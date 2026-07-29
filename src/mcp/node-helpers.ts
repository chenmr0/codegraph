/**
 * Pure helpers shared between the MCP `codegraph_node` tool handler
 * (`tools.ts`) and the CLI `codegraph node` command (`src/cli/node-view.ts`).
 *
 * Everything here is a pure function of its arguments (no `this`, no I/O, no
 * CodeGraph instance) so both call sites get identical symbol-resolution and
 * synthesized-edge labeling without drift. Extracted verbatim from `tools.ts`
 * — behavior is byte-for-byte the same; the existing `node-file-view` /
 * `symbol-lookup` / `pr19-improvements` suites guard against regression.
 */

import type { Node, Edge, NodeKind } from '../types';

/**
 * Rust path roots that have no file-system equivalent — `crate` is the
 * current crate, `super` is the parent module, `self` is the current
 * module. Used by `matchesSymbol` to strip these before file-path
 * matching so `crate::configurator::stage_apply::run` resolves the
 * same as `configurator::stage_apply::run`.
 */
export const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/**
 * Node kinds that contain other symbols. For these, `codegraph_node` with
 * `includeCode=true` returns a structural outline (member names + signatures
 * + line numbers) instead of the full body, which for a large class is a
 * multi-thousand-character wall of source that bloats the agent's context.
 */
export const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
export function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Number a chunk of source lines `cat -n` style (`<n>\t<line>`), starting at
 * `firstLineNumber`. Matches the shape the Read tool and `codegraph_explore`
 * produce, so output is Edit-safe.
 */
export function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/**
 * Whether a node matches a (possibly qualified) symbol query.
 *
 * Bare names match by exact name (or file basename for file nodes). Qualified
 * names (`Session.request`, `stage_apply::run`) split on any supported
 * separator and match by qualified-name suffix first, then by file-path
 * containment (Rust modules / Python packages live in the path, not the
 * qualifiedName). Rust path roots with no filesystem equivalent are stripped.
 */
export function matchesSymbol(node: Node, symbol: string): boolean {
  // Simple name match
  if (node.name === symbol) return true;
  // File basename match (e.g., "product-card" matches "product-card.liquid")
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

  // Qualified-name lookups: split on any supported separator. `\w` keeps
  // identifier chars (incl. `_`) intact; everything else is treated as a
  // separator we tolerate.
  if (!/[.\/]|::/.test(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts[parts.length - 1]!;
  if (node.name !== lastPart) return false;

  // Stage 1: qualified-name suffix match. The extractor joins the
  // semantic hierarchy with `::`, so `Session.request` and
  // `Session::request` both become `Session::request` here.
  const colonSuffix = parts.join('::');
  if (node.qualifiedName.includes(colonSuffix)) return true;

  // Stage 2: file-path containment. Rust modules and Python packages
  // are not in `qualifiedName` — they're encoded in the file path. So
  // `stage_apply::run` matches a `run` in any file whose path
  // contains a `stage_apply` segment (with or without an extension).
  //
  // Filter out Rust path prefixes that have no file-system equivalent.
  const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
  if (containerHints.length === 0) return false;

  const segments = node.filePath.split('/').filter((s) => s.length > 0);
  return containerHints.every((hint) =>
    segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
  );
}

/**
 * Label a synthesized (`provenance: 'heuristic'`) edge with a human-readable
 * note. Returns `null` for non-heuristic edges. `compact` is the short form
 * inlined into trail/flow output; `label` is the long form. `registeredAt`
 * is the wiring site (file:line) when the synthesizer recorded one.
 */
export function synthEdgeNote(edge: Edge | null): { label: string; compact: string; registeredAt?: string } | null {
  if (!edge || edge.provenance !== 'heuristic') return null;
  const m = edge.metadata as Record<string, unknown> | undefined;
  const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
  const at = registeredAt ? ` @${registeredAt}` : '';
  if (m?.synthesizedBy === 'callback') {
    const via = m.via ? `\`${String(m.via)}\`` : 'a registrar';
    const field = m.field ? ` on .${String(m.field)}` : '';
    return {
      label: `callback — registered via ${via}${field} (dynamic dispatch)`,
      compact: `dynamic: callback via ${via}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'event-emitter') {
    const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
    return {
      label: `event ${ev} — emit → handler (dynamic dispatch)`,
      compact: `dynamic: event ${ev}${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'react-render') {
    return {
      label: `React re-render — \`setState\` re-runs render() (dynamic dispatch)`,
      compact: `dynamic: React re-render via setState${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'jsx-render') {
    const child = m.via ? `<${String(m.via)}>` : 'a child component';
    return {
      label: `renders ${child} (JSX child — dynamic dispatch)`,
      compact: `dynamic: renders ${child}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'vue-handler') {
    const ev = m.event ? `@${String(m.event)}` : 'a template event';
    return {
      label: `Vue template handler — bound to ${ev} (dynamic dispatch)`,
      compact: `dynamic: Vue ${ev} handler`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'interface-impl') {
    return {
      label: `interface/abstract dispatch — runs the implementation override (dynamic dispatch)`,
      compact: `dynamic: interface → impl${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'closure-collection') {
    const field = m.field ? `\`${String(m.field)}\`` : 'a collection';
    return {
      label: `closure collection — runs handlers appended to ${field} (dynamic dispatch)`,
      compact: `dynamic: runs ${field} handlers${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'cpp-decl-def') {
    return {
      label: `C++ declaration-definition pair (structural link, not a call)`,
      compact: `decl-def pair${at}`,
      registeredAt,
    };
  }
  if (m?.synthesizedBy === 'c-decl-def') {
    return {
      label: `C declaration-definition pair (structural link, not a call)`,
      compact: `decl-def pair${at}`,
      registeredAt,
    };
  }
  return null;
}