/**
 * SQLite Adapter
 *
 * Thin wrapper over Node's built-in `node:sqlite` (`DatabaseSync`), exposed
 * through a small better-sqlite3-shaped interface so the rest of the codebase
 * is storage-agnostic.
 *
 * When `node:sqlite` is unavailable (Node < 22.5), falls back to sql.js
 * (WASM-based SQLite). The WASM backend lacks WAL and mmap but supports FTS5
 * and all query features needed by CodeGraph.
 */

export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

/**
 * The active SQLite backend. `node-sqlite` is the primary (full features);
 * `sql-js` is the WASM fallback (no WAL/mmap, but FTS5 works).
 */
export type SqliteBackend = 'node-sqlite' | 'sql-js';

// ---------------------------------------------------------------------------
// node:sqlite adapter (primary)
// ---------------------------------------------------------------------------

/**
 * Wraps Node's built-in `node:sqlite` (`DatabaseSync`) to match the
 * better-sqlite3 interface the rest of the code expects.
 */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    this._db = new DatabaseSync(dbPath);
  }

  get open(): boolean {
    return this._db.isOpen;
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const r = stmt.run(...params);
        return {
          changes: Number(r?.changes ?? 0),
          lastInsertRowid: r?.lastInsertRowid ?? 0,
        };
      },
      get(...params: any[]) {
        return stmt.get(...params);
      },
      all(...params: any[]) {
        return stmt.all(...params);
      },
    };
  }

  exec(sql: string): void {
    this._db.exec(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    if (trimmed.includes('=')) {
      this._db.exec(`PRAGMA ${trimmed}`);
      return;
    }
    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    if (options?.simple) {
      return row && typeof row === 'object' ? Object.values(row)[0] : row;
    }
    return row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this._db.exec('BEGIN');
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        throw error;
      }
    };
  }

  close(): void {
    if (this._db.isOpen) this._db.close();
  }
}

// ---------------------------------------------------------------------------
// sql.js WASM adapter (fallback for old Node / old glibc)
// ---------------------------------------------------------------------------

let SqlJsDatabase: any = null;

/**
 * Pre-initialize the sql.js WASM backend. Must be called (and awaited) before
 * `createDatabase()` when `node:sqlite` is unavailable. Idempotent — safe to
 * call multiple times.
 */
export async function ensureSqlJsReady(): Promise<void> {
  if (SqlJsDatabase) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJs = require('sql.js-fts5');
  // Load the WASM binary from disk (synchronous read) so sql.js init doesn't
  // need to fetch it over the network.
  const wasmCandidates = [
    path.join(__dirname, 'sql-wasm.wasm'),                          // dist/db/
    path.join(__dirname, '..', 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm'),
  ];
  let wasmBinary: Buffer | undefined;
  for (const candidate of wasmCandidates) {
    try {
      wasmBinary = fs.readFileSync(candidate);
      break;
    } catch { /* try next */ }
  }
  const SQL = wasmBinary
    ? await initSqlJs({ wasmBinary })
    : await initSqlJs();
  SqlJsDatabase = SQL.Database;
}

/**
 * sql.js requires `@`-prefixed keys in named-param objects, but CodeGraph
 * passes bare keys (e.g. `{ id: 1 }` for SQL `@id`). This helper adds the
 * prefix when the SQL likely uses `@named` parameters and the first param is
 * an object.
 */
function prefixNamedParams(params: any[]): any[] {
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === 'object' &&
    !Array.isArray(params[0])
  ) {
    const obj: Record<string, any> = {};
    for (const [key, value] of Object.entries(params[0])) {
      const prefixed =
        key.startsWith('@') || key.startsWith('$') || key.startsWith(':')
          ? key
          : `@${key}`;
      obj[prefixed] = value;
    }
    return [obj];
  }
  return params;
}

/** PRAGMAs that sql.js cannot honor — silently swallow them. */
const UNSUPPORTED_WRITE_PRAGMAS = new Set([
  'journal_mode',
  'mmap_size',
]);
const UNSUPPORTED_READ_PRAGMAS = new Set([
  'wal_checkpoint',
]);

class SqlJsAdapter implements SqliteDatabase {
  private _db: any;
  private _dbPath: string;
  private _open = true;

  constructor(dbPath: string) {
    if (!SqlJsDatabase) {
      throw new Error(
        'sql.js WASM backend not initialized. Call ensureSqlJsReady() first.',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    this._dbPath = dbPath;
    if (fs.existsSync(dbPath)) {
      const buf = fs.readFileSync(dbPath);
      this._db = new SqlJsDatabase(buf);
    } else {
      this._db = new SqlJsDatabase();
    }
  }

  get open(): boolean {
    return this._open;
  }

  prepare(sql: string): SqliteStatement {
    const stmt = this._db.prepare(sql);
    const db = this._db;
    return {
      run(...params: any[]) {
        const bound = prefixNamedParams(params);
        if (bound.length > 0) {
          stmt.bind(bound[0]);
        }
        stmt.step();
        stmt.reset();
        const changes = db.getRowsModified();
        const rowidResult = db.exec('SELECT last_insert_rowid()');
        const lastInsertRowid = rowidResult?.[0]?.values?.[0]?.[0] ?? 0;
        stmt.free();
        return { changes, lastInsertRowid };
      },
      get(...params: any[]) {
        const bound = prefixNamedParams(params);
        if (bound.length > 0) {
          stmt.bind(bound[0]);
        }
        let result: any = undefined;
        if (stmt.step()) {
          result = stmt.getAsObject();
        }
        stmt.reset();
        stmt.free();
        return result;
      },
      all(...params: any[]) {
        const bound = prefixNamedParams(params);
        if (bound.length > 0) {
          stmt.bind(bound[0]);
        }
        const results: any[] = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.reset();
        stmt.free();
        return results;
      },
    };
  }

  exec(sql: string): void {
    this._db.run(sql);
  }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();

    // Unsupported read pragmas — return undefined
    for (const u of UNSUPPORTED_READ_PRAGMAS) {
      if (trimmed.toLowerCase().startsWith(u)) return undefined;
    }

    if (trimmed.includes('=')) {
      const key = (trimmed.split('=')[0] ?? '').trim().toLowerCase();
      if (UNSUPPORTED_WRITE_PRAGMAS.has(key)) return undefined;
      this._db.run(`PRAGMA ${trimmed}`);
      return undefined;
    }

    // Read pragma
    const result = this._db.exec(`PRAGMA ${trimmed}`);
    if (!result || !result.length || !result[0].values?.length) {
      return options?.simple ? null : null;
    }
    const row = result[0].values[0];
    if (options?.simple) return row?.[0];
    const columns = result[0].columns;
    const obj: Record<string, any> = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      this._db.run('BEGIN');
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        return result;
      } catch (error) {
        this._db.run('ROLLBACK');
        throw error;
      }
    };
  }

  /** Persist in-memory DB to disk. */
  flush(): void {
    if (!this._open) return;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const data = this._db.export();
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this._dbPath, Buffer.from(data));
  }

  close(): void {
    if (!this._open) return;
    this.flush();
    this._db.close();
    this._open = false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a database connection. Tries `node:sqlite` first; falls back to the
 * sql.js WASM backend when the native module is unavailable.
 *
 * For the WASM path, call `ensureSqlJsReady()` before this function.
 */
export function createDatabase(dbPath: string): { db: SqliteDatabase; backend: SqliteBackend } {
  // Try node:sqlite first (full performance, WAL, native)
  try {
    return { db: new NodeSqliteAdapter(dbPath), backend: 'node-sqlite' };
  } catch { /* unavailable, try fallback */ }

  // Fallback: sql.js WASM backend (no native deps, no WAL)
  if (SqlJsDatabase) {
    return { db: new SqlJsAdapter(dbPath), backend: 'sql-js' };
  }

  throw new Error(
    'Failed to open SQLite.\n' +
    'node:sqlite is unavailable (requires Node.js 22.5+), and the sql.js\n' +
    'WASM fallback has not been initialized. When running on Node < 22.5,\n' +
    'the CLI and MCP server entry points call ensureSqlJsReady() before\n' +
    'opening any database.',
  );
}
