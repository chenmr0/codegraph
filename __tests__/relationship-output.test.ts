import { describe, expect, it } from 'vitest';
import { GraphTraverser } from '../src/graph/traversal';
import type { QueryBuilder } from '../src/db/queries';
import type { Edge, Node } from '../src/types';
import {
  formatDefinitionLocation,
  formatRelationshipSites,
  mergeDirectRelationshipGroups,
  relationshipGroupToJson,
  type RelatedSymbolRelationships,
  type RelationshipSite,
} from '../src/relationship-output';

function node(id: string, filePath: string, startLine: number, endLine: number): Node {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    filePath,
    language: 'typescript',
    startLine,
    endLine,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 0,
  };
}

describe('direct relationship groups', () => {
  it('preserves parallel call sites without changing recursive traversal semantics', () => {
    const caller = node('caller', 'src/caller.ts', 10, 20);
    const target = node('target', 'src/target.ts', 1, 3);
    const incoming: Edge[] = [12, 15, 18].map((line) => ({
      source: caller.id,
      target: target.id,
      kind: 'calls',
      line,
      column: 2,
    }));
    const queries = {
      getIncomingEdges: (id: string) => id === target.id ? incoming : [],
      getOutgoingEdges: () => [],
      getNodesByIds: () => new Map([[caller.id, caller]]),
    } as unknown as QueryBuilder;
    const traverser = new GraphTraverser(queries);

    const groups = traverser.getDirectRelationshipGroups(target.id, 'incoming');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.node.id).toBe(caller.id);
    expect(groups[0]!.edges.map((edge) => edge.line)).toEqual([12, 15, 18]);

    // The legacy default-depth traversal still returns the same three direct
    // edges; its depth > 1 node-oriented behavior remains untouched.
    expect(traverser.getCallers(target.id).map(({ edge }) => edge.line)).toEqual([12, 15, 18]);
  });
});

describe('relationship output', () => {
  it('labels real relationship kinds and never disguises a missing synthetic site as a definition', () => {
    const sites: RelationshipSite[] = [
      { kind: 'calls', filePath: 'src/caller.ts', line: 12 },
      { kind: 'references', filePath: 'src/caller.ts', line: 13 },
      { kind: 'imports', filePath: 'src/caller.ts', line: 1 },
      {
        kind: 'calls',
        filePath: 'src/dispatcher.ts',
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'event-emitter' },
      },
      {
        kind: 'calls',
        filePath: 'src/callback.ts',
        provenance: 'heuristic',
        metadata: { synthesizedBy: 'callback', registeredAt: 'src/wiring.ts:44' },
      },
    ];

    const formatted = formatRelationshipSites(sites, 10).lines.join('\n');
    expect(formatted).toContain('call: src/caller.ts:12');
    expect(formatted).toContain('reference: src/caller.ts:13');
    expect(formatted).toContain('import: src/caller.ts:1');
    expect(formatted).toContain('synthetic (event-emitter): location unavailable');
    expect(formatted).toContain('synthetic (callback): metadata location src/wiring.ts:44');
  });

  it('keeps complete JSON sites while bounding human-readable output', () => {
    const root = node('root', 'src/root.ts', 20, 30);
    const callee = node('callee', 'src/callee.ts', 2, 8);
    const edges: Edge[] = Array.from({ length: 6 }, (_, index) => ({
      source: root.id,
      target: callee.id,
      kind: 'calls',
      line: 21 + index,
    }));
    const merged = new Map<string, RelatedSymbolRelationships>();
    mergeDirectRelationshipGroups(merged, root, 'outgoing', [{ node: callee, edges }]);
    const entry = merged.get(callee.id)!;

    expect(formatDefinitionLocation(callee)).toBe('src/callee.ts:2-8');
    expect(formatRelationshipSites(entry.sites, 3).omitted).toBe(3);
    const json = relationshipGroupToJson(entry) as { sites: unknown[]; endLine: number };
    expect(json.endLine).toBe(8);
    expect(json.sites).toHaveLength(6);
  });
});
