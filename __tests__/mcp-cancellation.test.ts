import { describe, expect, it } from 'vitest';
import type { MCPEngine } from '../src/mcp/engine';
import { MCPSession } from '../src/mcp/session';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcTransport,
  MessageHandler,
} from '../src/mcp/transport';
import type { ToolExecutionOptions, ToolResult } from '../src/mcp/tools';

class FakeTransport implements JsonRpcTransport {
  handler: MessageHandler | null = null;
  responses: JsonRpcResponse[] = [];

  start(handler: MessageHandler): void { this.handler = handler; }
  stop(): void { /* no-op */ }
  send(response: JsonRpcResponse): void { this.responses.push(response); }
  notify(): void { /* no-op */ }
  request(): Promise<unknown> { return Promise.resolve({}); }
  sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }
  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, data } });
  }
  deliver(message: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!this.handler) throw new Error('session not started');
    return this.handler(message);
  }
}

describe('MCP request cancellation', () => {
  it('propagates notifications/cancelled to the active tool AbortSignal', async () => {
    const transport = new FakeTransport();
    let receivedSignal: AbortSignal | undefined;
    const toolHandler = {
      execute: async (
        _name: string,
        _args: Record<string, unknown>,
        options: ToolExecutionOptions,
      ): Promise<ToolResult> => {
        receivedSignal = options.signal;
        await new Promise<void>((resolve) => {
          if (receivedSignal?.aborted) resolve();
          else receivedSignal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return { content: [{ type: 'text', text: 'cancelled' }] };
      },
    };
    const engine = {
      hasDefaultCodeGraph: () => true,
      getToolHandler: () => toolHandler,
    } as unknown as MCPEngine;
    const session = new MCPSession(transport, engine);
    session.start();

    const call = transport.deliver({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: 'MissingSymbol' } },
    });
    while (!receivedSignal) await new Promise<void>((resolve) => setImmediate(resolve));
    await transport.deliver({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 42, reason: 'client timeout' },
    });
    await call;

    expect(receivedSignal.aborted).toBe(true);
    expect(transport.responses.at(-1)?.error).toMatchObject({
      code: -32800,
      message: 'Request cancelled',
    });
  });
});
