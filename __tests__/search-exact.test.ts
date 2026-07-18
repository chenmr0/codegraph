/**
 * Exact-match search tests
 *
 * Covers `SearchOptions.exact`: a strict, case-sensitive, byte-equal lookup
 * on node `name` with no prefix / substring / edit-distance fallback. This is
 * the mode the CLI `query` command defaults to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-exact-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('searchNodes exact mode', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = createTempDir();
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // Names chosen to collide under case-folding or prefix matching:
    //   getUser / GetUser / getuser  — differ only by case
    //   getUserById / getUserProfile — share the "getUser" prefix
    fs.writeFileSync(
      path.join(tempDir, 'src', 'users.ts'),
      `export function getUser(): { id: number } { return { id: 1 }; }
export function GetUser(): { id: number } { return { id: 2 }; }
export function getuser(): { id: number } { return { id: 3 }; }
export function getUserById(id: number): { id: number } { return { id }; }
export function getUserProfile(id: number): string { return 'p' + id; }
`
    );
    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg.close();
    cleanupTempDir(tempDir);
  });

  it('returns only nodes whose name is byte-equal to the query', () => {
    const results = cg.searchNodes('getUser', { exact: true });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.node.name).toBe('getUser');
  });

  it('is case-sensitive: GetUser and getuser do not match getUser', () => {
    const lower = cg.searchNodes('getUser', { exact: true }).map((r) => r.node.name);
    const pascal = cg.searchNodes('GetUser', { exact: true }).map((r) => r.node.name);
    const allLower = cg.searchNodes('getuser', { exact: true }).map((r) => r.node.name);

    expect(lower).toEqual(['getUser']);
    expect(pascal).toEqual(['GetUser']);
    expect(allLower).toEqual(['getuser']);
  });

  it('does not fall back to prefix matches', () => {
    // "getUser" is a prefix of getUserById / getUserProfile — exact mode must
    // not surface them, whereas the default fuzzy chain would.
    const names = cg.searchNodes('getUser', { exact: true }).map((r) => r.node.name);
    expect(names).not.toContain('getUserById');
    expect(names).not.toContain('getUserProfile');

    // A full, exact query for the longer name resolves to just that name.
    const byId = cg.searchNodes('getUserById', { exact: true }).map((r) => r.node.name);
    expect(byId).toEqual(['getUserById']);
  });

  it('returns an empty array when no name matches exactly', () => {
    expect(cg.searchNodes('getUserX', { exact: true })).toEqual([]);
    expect(cg.searchNodes('getuserbyid', { exact: true })).toEqual([]); // case mismatch
  });

  it('respects the kind filter', () => {
    const results = cg.searchNodes('getUser', { exact: true, kinds: ['class'] });
    expect(results).toEqual([]);
    const fns = cg.searchNodes('getUser', { exact: true, kinds: ['function'] });
    expect(fns.length).toBe(1);
    expect(fns[0]!.node.name).toBe('getUser');
  });

  it('applies the path: filter as a hard gate', () => {
    // path: filter is parsed out of the raw query string; use a basename
    // substring so it stays stable across path-separator styles.
    const hit = cg.searchNodes('getUser path:users', { exact: true });
    expect(hit.length).toBe(1);
    expect(hit[0]!.node.name).toBe('getUser');
    const miss = cg.searchNodes('getUser path:elsewhere_xyz', { exact: true });
    expect(miss).toEqual([]);
  });

  it('falls back to the filter-only path when only fields are given', () => {
    const fns = cg.searchNodes('kind:function', { exact: true, limit: 50 });
    expect(fns.length).toBe(5);
    for (const r of fns) expect(r.node.kind).toBe('function');
  });

  it('default (non-exact) mode still surfaces prefix matches — regression guard', () => {
    // Without exact, the FTS prefix chain must still find getUserById via the
    // "getUser" prefix. This guards against the exact path leaking into the
    // default behavior used by the MCP tools.
    const names = cg.searchNodes('getUser', { limit: 50 }).map((r) => r.node.name);
    expect(names).toContain('getUser');
    expect(names).toContain('getUserById');
  });
});