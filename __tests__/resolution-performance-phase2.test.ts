import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import {
  ResolverPool,
  minRefsForResolverPool,
  resolveResolverPoolSize,
} from '../src/resolution/resolver-pool';
import { ReferenceResolver } from '../src/resolution';
import type { ResolutionContext } from '../src/resolution/types';
import type { Node, UnresolvedReference } from '../src/types';

function makeNode(id: string, name = id): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'sample.c',
    language: 'c',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
  };
}

function makeRef(line: number): UnresolvedReference {
  return {
    fromNodeId: 'caller',
    referenceName: 'target',
    referenceKind: 'calls',
    line,
    column: 2,
    filePath: 'sample.c',
    language: 'c',
  };
}

describe('phase 2 exact unresolved-reference cleanup', () => {
  let directory: string;
  let connection: DatabaseConnection;
  let queries: QueryBuilder;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-resolve-phase2-'));
    connection = DatabaseConnection.initialize(path.join(directory, 'graph.db'));
    queries = new QueryBuilder(connection.getDb());
    queries.insertNodes([makeNode('caller'), makeNode('target')]);
  });

  afterEach(() => {
    connection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('seeks in row-id order and deletes only the selected sibling call site', () => {
    queries.insertUnresolvedRefsBatch([makeRef(10), makeRef(20), makeRef(30)]);

    const firstBatch = queries.getUnresolvedReferencesBatchAfter(0, 2);
    expect(firstBatch.map((ref) => ref.line)).toEqual([10, 20]);
    expect(firstBatch.every((ref) => ref.rowId !== undefined)).toBe(true);

    const firstId = firstBatch[0]!.rowId!;
    expect(queries.deleteReferencesByRowIds([firstId])).toBe(1);

    const remaining = queries.getUnresolvedReferences();
    expect(remaining.map((ref) => ref.line)).toEqual([20, 30]);

    const afterFirst = queries.getUnresolvedReferencesBatchAfter(firstId, 10);
    expect(afterFirst.map((ref) => ref.line)).toEqual([20, 30]);
  });

  it('keeps edge identity deduplication while secondary indexes are deferred', async () => {
    connection.beginBulkResolutionEdgeLoad();
    connection.beginBulkResolutionRefLoad();

    const namesDuring = new Set(
      (
        connection
          .getDb()
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(namesDuring.has('idx_edges_kind')).toBe(false);
    expect(namesDuring.has('idx_unresolved_name')).toBe(false);
    expect(namesDuring.has('idx_edges_identity')).toBe(true);

    queries.insertEdges([
      { source: 'caller', target: 'target', kind: 'calls', line: 10, column: 2 },
      { source: 'caller', target: 'target', kind: 'calls', line: 10, column: 2 },
    ]);

    await connection.endBulkResolutionRefLoad();
    await connection.endBulkResolutionEdgeLoad();

    const namesAfter = new Set(
      (
        connection
          .getDb()
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(namesAfter.has('idx_edges_kind')).toBe(true);
    expect(namesAfter.has('idx_unresolved_name')).toBe(true);
    expect(queries.getOutgoingEdges('caller')).toHaveLength(1);
  });

  it('self-heals resolution indexes after an interrupted bulk window', () => {
    connection.beginBulkResolutionEdgeLoad();
    connection.beginBulkResolutionRefLoad();
    connection.close();

    connection = DatabaseConnection.open(path.join(directory, 'graph.db'));
    queries = new QueryBuilder(connection.getDb());

    const names = new Set(
      (
        connection
          .getDb()
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(names.has('idx_edges_kind')).toBe(true);
    expect(names.has('idx_unresolved_name')).toBe(true);
  });

  it('memoizes the exact method-owner filter without changing candidate order', () => {
    const methods: Node[] = [
      {
        ...makeNode('first', 'run'),
        kind: 'method',
        qualifiedName: 'ns::Worker::run',
      },
      {
        ...makeNode('other', 'run'),
        kind: 'method',
        qualifiedName: 'ns::Other::run',
      },
      {
        ...makeNode('second', 'run'),
        kind: 'method',
        qualifiedName: 'Worker::run',
      },
    ];
    queries.insertNodes(methods);
    const resolver = new ReferenceResolver(directory, queries);
    resolver.initialize();
    const context = (
      resolver as unknown as { context: ResolutionContext }
    ).context;

    expect(
      context.getMethodMatches!('Worker', 'run', 'c').map((node) => node.id)
    ).toEqual(['first', 'second']);
    expect(
      context.getMethodMatches!('Worker', 'run', 'c').map((node) => node.id)
    ).toEqual(['first', 'second']);
  });

  it('invalidates supertype answers when a later batch adds conformance edges', () => {
    queries.insertNodes([
      {
        ...makeNode('derived', 'Derived'),
        kind: 'class',
        qualifiedName: 'Derived',
      },
      {
        ...makeNode('base', 'Base'),
        kind: 'class',
        qualifiedName: 'Base',
      },
    ]);
    const resolver = new ReferenceResolver(directory, queries);
    resolver.initialize();
    const context = (
      resolver as unknown as { context: ResolutionContext }
    ).context;

    expect(context.getSupertypes!('Derived', 'c')).toEqual([]);
    queries.insertEdges([
      { source: 'derived', target: 'base', kind: 'extends' },
    ]);
    resolver.resolveAll([]); // advances the fixed-edge-state batch generation
    expect(context.getSupertypes!('Derived', 'c')).toEqual(['Base']);
  });
});

describe('phase 2 resolver pool policy', () => {
  const originalMinimum = process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN;

  afterEach(() => {
    if (originalMinimum === undefined) {
      delete process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN;
    } else {
      process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN = originalMinimum;
    }
  });

  it('keeps two-core and low-memory machines sequential', () => {
    expect(
      resolveResolverPoolSize({
        availableParallelism: 2,
        availableMemoryBytes: 16 * 1024 ** 3,
        databaseSizeBytes: 1024 ** 3,
      })
    ).toBeNull();
    expect(
      resolveResolverPoolSize({
        availableParallelism: 16,
        availableMemoryBytes: 300 * 1024 ** 2,
        databaseSizeBytes: 1024 ** 3,
      })
    ).toBeNull();
  });

  it('caps automatic workers and honors the explicit rollback setting', () => {
    const automatic = resolveResolverPoolSize({
      availableParallelism: 32,
      availableMemoryBytes: 64 * 1024 ** 3,
      databaseSizeBytes: 1024 ** 3,
    });
    expect(automatic).toBe(6);

    expect(
      resolveResolverPoolSize({
        explicit: '0',
        availableParallelism: 32,
        availableMemoryBytes: 64 * 1024 ** 3,
        databaseSizeBytes: 1024 ** 3,
      })
    ).toBeNull();
    expect(
      resolveResolverPoolSize({
        explicit: '99',
        availableParallelism: 2,
        availableMemoryBytes: 256 * 1024 ** 2,
        databaseSizeBytes: 1024 ** 3,
      })
    ).toBe(16);
  });

  it('uses a conservative default threshold with an explicit override', () => {
    delete process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN;
    expect(minRefsForResolverPool()).toBe(150_000);
    process.env.CODEGRAPH_PARALLEL_RESOLVE_MIN = '1234';
    expect(minRefsForResolverPool()).toBe(1234);
  });

  it('honors the parallel-resolution kill switch before touching the database', () => {
    const previous = process.env.CODEGRAPH_NO_PARALLEL_RESOLVE;
    process.env.CODEGRAPH_NO_PARALLEL_RESOLVE = '1';
    try {
      expect(ResolverPool.tryCreate('missing.db', 'missing-project')).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_NO_PARALLEL_RESOLVE;
      else process.env.CODEGRAPH_NO_PARALLEL_RESOLVE = previous;
    }
  });
});
