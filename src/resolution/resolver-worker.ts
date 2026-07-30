/**
 * Read-only reference-resolution worker.
 *
 * Workers never persist edges or delete unresolved rows. They resolve a
 * caller-supplied list against SQLite's committed state and return plain data
 * for ordered admission by the main thread.
 */

try {
  // Repeated worker startup benefits from Node's compile cache where available.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require('node:module') as { enableCompileCache?: () => void }).enableCompileCache?.();
} catch {
  // Best effort on older supported Node versions.
}

import { parentPort } from 'worker_threads';
import { createDatabase, type SqliteDatabase } from '../db/sqlite-adapter';
import { QueryBuilder } from '../db/queries';
import { ReferenceResolver } from './index';
import type { UnresolvedReference } from '../types';

if (!parentPort) {
  throw new Error('resolver-worker must run inside a worker thread');
}

const port = parentPort;
let db: SqliteDatabase | null = null;
let resolver: ReferenceResolver | null = null;

type WorkerMessage =
  | { type: 'open'; dbPath: string; projectRoot: string }
  | { type: 'resolve'; id: number; refs: UnresolvedReference[] };

port.on('message', (message: WorkerMessage) => {
  try {
    if (message.type === 'open') {
      const opened = createDatabase(message.dbPath, { readOnly: true });
      if (opened.backend !== 'node-sqlite') {
        throw new Error('parallel resolution requires node:sqlite');
      }
      db = opened.db;
      db.pragma('busy_timeout = 5000');
      db.pragma('query_only = ON');
      db.pragma('cache_size = -32000');
      const queries = new QueryBuilder(db);
      resolver = new ReferenceResolver(message.projectRoot, queries);
      resolver.initialize();
      port.postMessage({ type: 'ready' });
      return;
    }

    if (!resolver) throw new Error('resolver worker received work before open');
    const result = resolver.resolveListForAdmission(message.refs);
    port.postMessage({ type: 'result', id: message.id, result });
  } catch (error) {
    port.postMessage({
      type: 'error',
      id: 'id' in message ? message.id : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

process.once('exit', () => {
  try {
    db?.close();
  } catch {
    // Already closed.
  }
});
