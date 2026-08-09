import type { Node } from '../types';

/**
 * Rust path roots that carry semantic meaning but do not map to a file-system
 * segment. They are ignored by the path-based qualified-name fallback.
 */
export const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/** Whether a symbol contains one of the qualified-name separators we support. */
export function isQualifiedSymbol(symbol: string): boolean {
  return /[./]|::/.test(symbol);
}

/** Split a qualified symbol on C++/Rust, dotted, or slash separators. */
export function qualifierParts(symbol: string): string[] {
  return symbol.split(/::|[./]/).filter((part) => part.length > 0);
}

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
export function lastQualifierPart(symbol: string): string {
  const parts = qualifierParts(symbol);
  return parts[parts.length - 1] ?? symbol;
}

/** Canonical semantic qualified name used by extractors (`A::B::name`). */
export function canonicalQualifiedName(symbol: string): string {
  return qualifierParts(symbol).join('::');
}

/**
 * Whether a node matches a (possibly qualified) symbol query.
 *
 * Bare names are byte-exact. Qualified names match a semantic qualified-name
 * suffix first, then a file-path qualification for languages whose module path
 * is stored in `filePath` rather than `qualifiedName` (notably Rust/Python).
 */
export function matchesSymbol(node: Node, symbol: string): boolean {
  if (node.name === symbol) return true;
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  if (!isQualifiedSymbol(symbol)) return false;
  const parts = qualifierParts(symbol);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart && node.name !== symbol) return false;

  // Normalize dotted/slash qualified names before comparing. Require a true
  // segment boundary: `Session::request` must not match
  // `OtherSession::request` merely because it contains the same text.
  const wanted = parts.join('::');
  const actual = canonicalQualifiedName(node.qualifiedName || node.name);
  if (actual === wanted || actual.endsWith(`::${wanted}`)) return true;

  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;

  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}
