import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Edge, Node } from '../src/types';

const node = (id: string, name: string): Node => ({
  id,
  kind: 'function',
  name,
  qualifiedName: name,
  filePath: 'sample.cpp',
  language: 'cpp',
  startLine: 1,
  endLine: 1,
  startColumn: 0,
  endColumn: 1,
  isDeclaration: true,
  updatedAt: Date.now(),
});

describe('fresh-index database primitives', () => {
  let directory: string;
  let dbPath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-perf-db-'));
    dbPath = path.join(directory, 'graph.db');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('batches fork node fields and deduplicates identical edges', () => {
    const connection = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(connection.getDb());
    const nodes = [node('a', 'a'), node('b', 'b')];
    const edge: Edge = {
      source: 'a',
      target: 'b',
      kind: 'defines',
      line: 1,
      column: 0,
    };

    queries.storeFileBundle({
      nodes,
      edges: [edge, edge],
      refs: [],
      file: {
        path: 'sample.cpp',
        contentHash: 'hash',
        language: 'cpp',
        size: 1,
        modifiedAt: 1,
        indexedAt: 1,
        nodeCount: 2,
      },
    });

    const stored = connection
      .getDb()
      .prepare(
        `SELECT is_declaration FROM nodes WHERE id = 'a'`
      )
      .get() as { is_declaration: number };
    const edgeCount = connection
      .getDb()
      .prepare('SELECT count(*) AS count FROM edges')
      .get() as { count: number };
    expect(stored.is_declaration).toBe(1);
    expect(edgeCount.count).toBe(1);
    connection.close();
  });

  it('rebuilds FTS and deferred secondary indexes', async () => {
    const connection = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(connection.getDb());

    connection.beginBulkNodeLoad();
    connection.beginBulkParseLoad();
    queries.insertNodes([node('searchable', 'SearchableSymbol')]);
    await connection.endBulkParseLoad();
    connection.endBulkNodeLoad();

    const fts = connection
      .getDb()
      .prepare(
        `SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'SearchableSymbol'`
      )
      .all() as Array<{ id: string }>;
    const indexes = connection
      .getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>;
    const names = new Set(indexes.map((row) => row.name));

    expect(fts.map((row) => row.id)).toContain('searchable');
    expect(names.has('idx_nodes_name')).toBe(true);
    expect(names.has('idx_unresolved_from_name')).toBe(true);
    expect(names.has('idx_edges_identity')).toBe(true);
    connection.close();
  });

  it('self-heals an interrupted bulk window on the next open', () => {
    const interrupted = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(interrupted.getDb());
    interrupted.beginBulkNodeLoad();
    interrupted.beginBulkParseLoad();
    queries.insertNodes([node('recovered', 'RecoveredSymbol')]);
    interrupted.close();

    const recovered = DatabaseConnection.open(dbPath);
    const fts = recovered
      .getDb()
      .prepare(
        `SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'RecoveredSymbol'`
      )
      .all() as Array<{ id: string }>;
    const nameIndex = recovered
      .getDb()
      .prepare(
        `SELECT count(*) AS count FROM sqlite_master
         WHERE type = 'index' AND name = 'idx_nodes_name'`
      )
      .get() as { count: number };
    expect(fts.map((row) => row.id)).toContain('recovered');
    expect(nameIndex.count).toBe(1);
    recovered.close();
  });

  it('runs the fork edge-identity migration as version 7', () => {
    const initialized = DatabaseConnection.initialize(dbPath);
    const db = initialized.getDb();
    const queries = new QueryBuilder(db);
    queries.insertNodes([node('a', 'a'), node('b', 'b')]);
    db.exec('DROP INDEX idx_edges_identity');
    db.exec(`UPDATE schema_versions SET version = 6 WHERE version = 7`);
    db.exec(
      `INSERT INTO edges(source,target,kind,line,col) VALUES
       ('a','b','calls',1,0),('a','b','calls',1,0)`
    );
    initialized.close();

    const migrated = DatabaseConnection.open(dbPath);
    const count = migrated
      .getDb()
      .prepare('SELECT count(*) AS count FROM edges')
      .get() as { count: number };
    const version = migrated.getSchemaVersion();
    expect(count.count).toBe(1);
    expect(version?.version).toBe(7);
    migrated.close();
  });
});
