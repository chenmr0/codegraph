/**
 * Errors that indicate the web-tree-sitter WASM runtime can no longer be
 * trusted for subsequent parses in the same worker.
 *
 * These are process-local runtime failures, not ordinary source parse errors.
 * Keeping the worker alive after one of them causes every later file assigned
 * to that worker to fail as well.
 */
const WASM_RUNTIME_CORRUPTION_PATTERNS = [
  'memory access out of bounds',
  'table index is out of bounds',
  'indirect call signature mismatch',
  'null function or function signature mismatch',
  'out of memory',
] as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWasmRuntimeCorruptionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return WASM_RUNTIME_CORRUPTION_PATTERNS.some(pattern => message.includes(pattern));
}

/** Failures that should be retried after replacing the parse worker. */
export function isRetryableParseWorkerError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return isWasmRuntimeCorruptionError(message)
    || message.includes('worker exited')
    || message.includes('timed out');
}
