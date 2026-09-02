import { formatSourceLocation } from '../source-location';

/**
 * Format an indexed symbol's inclusive source range for `codegraph query`.
 *
 * Keep both bounds even for a single-line symbol so agents and scripts can
 * translate the result directly to Read's `offset` and `limit` arguments.
 */
export function formatQueryLocation(
  filePath: string,
  startLine: number,
  endLine: number,
): string {
  return formatSourceLocation(filePath, startLine, endLine);
}
