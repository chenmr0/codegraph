import { describe, expect, it } from 'vitest';
import { CODEGRAPH_INSTRUCTIONS_BLOCK } from '../src/installer/instructions-template';
import { getCodeGraphPermissions } from '../src/installer/targets/shared';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions';
import { getStaticTools, ToolHandler } from '../src/mcp/tools';

describe('MCP codegraph_node context-budget guidance', () => {
  const nodeTool = () => getStaticTools().find((tool) => tool.name === 'node')!;

  it('advertises symbol-first guarded file mode', () => {
    const tool = nodeTool();
    expect(tool.description).toMatch(/Prefer SYMBOL MODE/i);
    expect(tool.description).toMatch(/Bare-file\/full-file reads are rejected/i);
    expect(tool.description).not.toMatch(/use it whenever you would Read/i);
  });

  it('publishes the 120-line limit in the JSON schema', () => {
    const properties = nodeTool().inputSchema.properties;
    expect(properties.limit?.minimum).toBe(1);
    expect(properties.limit?.maximum).toBe(120);
    expect(properties.offset?.minimum).toBe(1);
    expect(properties.outlineLimit?.maximum).toBe(80);
  });

  it('publishes bounded batch-context and literal-search schemas', () => {
    const context = getStaticTools().find((tool) => tool.name === 'context')!;
    const textSearch = getStaticTools().find((tool) => tool.name === 'text_search')!;
    expect(context.inputSchema.properties.targets?.minItems).toBe(1);
    expect(context.inputSchema.properties.targets?.maxItems).toBe(8);
    expect(textSearch.inputSchema.properties.queries?.maxItems).toBe(8);
    expect(textSearch.inputSchema.required).toEqual(['queries', 'path']);
  });

  it('keeps server instructions aligned with runtime guards', () => {
    expect(SERVER_INSTRUCTIONS).toContain('{ file, symbolsOnly: true }');
    expect(SERVER_INSTRUCTIONS).toContain('{ file, offset, limit<=120 }');
    expect(SERVER_INSTRUCTIONS).toMatch(/rejects bare\/full-file reads/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/ONE `codegraph_context` call/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/ONE `codegraph_text_search` call/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/Do not paginate file windows/i);
    expect(SERVER_INSTRUCTIONS).not.toMatch(/any time you'd use the `Read` tool/i);
  });

  it('keeps installed agent guidance aligned with runtime guards', () => {
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('symbolsOnly=true');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('limit<=120');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph_context');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph_text_search');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toContain('codegraph_node');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).not.toContain('codegraph_codegraph_node');
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).toMatch(/Bare\/full-file MCP reads are rejected/i);
    expect(CODEGRAPH_INSTRUCTIONS_BLOCK).not.toMatch(/Use it INSTEAD of Read/i);
  });

  it('auto-allows the optimized batch tools for Claude-compatible clients', () => {
    const permissions = getCodeGraphPermissions();
    expect(permissions).toContain('mcp__codegraph__context');
    expect(permissions).toContain('mcp__codegraph__text_search');
    expect(permissions.some((permission) => permission.startsWith('mcp__codegraph__codegraph_'))).toBe(false);
  });

  it('does not accept the removed prefixed raw MCP names', async () => {
    const result = await new ToolHandler(null).execute('codegraph_node', { symbol: 'Widget' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown tool: codegraph_node/);
  });
});
