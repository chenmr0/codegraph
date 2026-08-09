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
export {
  RUST_PATH_PREFIXES,
  lastQualifierPart,
  matchesSymbol,
} from '../search/symbol-match';

/**
 * Node kinds that contain other symbols. For these, `codegraph_node` with
 * `includeCode=true` returns a structural outline (member names + signatures
 * + line numbers) instead of the full body, which for a large class is a
 * multi-thousand-character wall of source that bloats the agent's context.
 */
export const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

/**
 * Display name for a node in a disambiguation list: the qualifiedName when it
 * carries a scope prefix the simple name doesn't (e.g. `ns::UbuffOffset` for a
 * struct inside a C++ namespace, so two same-named structs in different
 * namespaces are visually distinguishable — and the caller can copy the
 * qualified name back for a precise re-query), otherwise the simple name.
 * Shared by `codegraph_node` and the CLI `codegraph node` command.
 */
export function displaySymbol(n: Node): string {
  return n.qualifiedName && n.qualifiedName !== n.name ? n.qualifiedName : n.name;
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
