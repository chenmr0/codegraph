import { describe, expect, it } from 'vitest';
import {
  isRetryableParseWorkerError,
  isWasmRuntimeCorruptionError,
} from '../src/extraction/wasm-errors';

describe('tree-sitter WASM corruption classification', () => {
  it.each([
    'memory access out of bounds',
    'RuntimeError: table index is out of bounds',
    'null function or function signature mismatch',
    'indirect call signature mismatch',
    new Error('Out of memory'),
  ])('treats %s as fatal worker corruption', (error) => {
    expect(isWasmRuntimeCorruptionError(error)).toBe(true);
  });

  it('does not classify ordinary source damage as worker corruption', () => {
    expect(isWasmRuntimeCorruptionError('Parse error: unexpected token')).toBe(false);
  });

  it.each([
    'Worker exited with code 1',
    'Parse timed out after 30000ms',
    'Parse error: table index is out of bounds',
  ])('routes %s through the fresh-worker retry pass', (message) => {
    expect(isRetryableParseWorkerError(message)).toBe(true);
  });
});
