import type { Node } from './types';

/** Format an indexed symbol's inclusive line range. */
export function formatSourceRange(startLine: number, endLine?: number): string {
  const safeEndLine = Math.max(startLine, endLine ?? startLine);
  return `${startLine}-${safeEndLine}`;
}

/** Format an indexed symbol location as `path:start-end`. */
export function formatSourceLocation(
  filePath: string,
  startLine: number,
  endLine?: number,
): string {
  return `${filePath}:${formatSourceRange(startLine, endLine)}`;
}

/** Format a node's complete inclusive source location. */
export function formatNodeLocation(
  node: Pick<Node, 'filePath' | 'startLine' | 'endLine'>,
): string {
  return formatSourceLocation(node.filePath, node.startLine, node.endLine);
}
