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
    fs.writeFileSync(
      path.join(tempDir, 'src', 'qualified.ts'),
      `export class UserService {
  lookupUser(): void {}
}
`
    );
    // Put the path-filter target after more than the requested limit in the
    // deterministic unfiltered order. Filtering after LIMIT used to miss it.
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(tempDir, 'src', `duplicate-${String(i).padStart(2, '0')}.ts`),
        `export class SharedThing { value = ${i}; }\n`
      );
    }
    fs.writeFileSync(
      path.join(tempDir, 'src', 'zzz-target.ts'),
      `export class SharedThing { target = true; }\n`
    );
    fs.mkdirSync(path.join(tempDir, 'src', 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src', 'nested', 'deeper', 'deep-target.ts'),
      `export class DeepThing { target = true; }\n`
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

  it('applies path filters before LIMIT for heavily duplicated exact names', () => {
    const hit = cg.searchNodes('SharedThing path:zzz-target', {
      exact: true,
      kinds: ['class'],
      limit: 1,
    });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.node.filePath).toContain('zzz-target.ts');
  });

  it('applies a soft path hint before LIMIT without filtering other exact candidates', () => {
    const hit = cg.searchNodes('SharedThing', {
      exact: true,
      kinds: ['class'],
      pathHint: '/usr1/checkout/src/zzz-target.ts',
      limit: 1,
    });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.node.filePath).toContain('zzz-target.ts');

    const fallback = cg.searchNodes('SharedThing', {
      exact: true,
      kinds: ['class'],
      pathHint: 'completely/unrelated/path',
      limit: 50,
    });
    expect(fallback).toHaveLength(13);
  });

  it('honors SearchOptions includePatterns before exact-result LIMIT', () => {
    const hit = cg.searchNodes('SharedThing', {
      exact: true,
      kinds: ['class'],
      includePatterns: ['**/zzz-target.ts'],
      limit: 1,
    });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.node.filePath).toContain('zzz-target.ts');
  });

  it('matches slash-free includePatterns against the file basename', () => {
    const hit = cg.searchNodes('SharedThing', {
      exact: true,
      kinds: ['class'],
      includePatterns: ['ZZZ-TARGET.ts'],
      limit: 1,
    });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.node.filePath).toContain('zzz-target.ts');
  });

  it('preserves literal path prefixes with globstar patterns', () => {
    const patterns = [
      'src/nested/deeper/deep-target.ts',
      '**/deep-target.ts',
      '**/*.ts',
      'src/**/deep-target.ts',
      'src/nested/**',
      'src/nested/**/*',
    ];
    for (const includePattern of patterns) {
      const hit = cg.searchNodes('DeepThing', {
        exact: true,
        includePatterns: [includePattern],
        limit: 1,
      });
      expect(hit, includePattern).toHaveLength(1);
      expect(hit[0]!.node.filePath).toContain('deep-target.ts');
    }

    // A single `*` remains segment-scoped; it must not cross nested folders.
    expect(cg.searchNodes('DeepThing', {
      exact: true,
      includePatterns: ['src/*'],
    })).toEqual([]);
  });

  it('honors SearchOptions excludePatterns for exact symbols', () => {
    const results = cg.searchNodes('SharedThing', {
      exact: true,
      kinds: ['class'],
      includePatterns: ['**/*.ts'],
      excludePatterns: ['duplicate-*.ts'],
      limit: 50,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.node.filePath).toContain('zzz-target.ts');
  });

  it('uses source line to disambiguate more than 100 identical qualified names', () => {
    const queries = (cg as unknown as {
      queries: { insertNode(node: Record<string, unknown>): void };
    }).queries;
    for (let line = 1; line <= 150; line++) {
      queries.insertNode({
        id: `function:repeated-qualified-${line}`,
        kind: 'function',
        name: 'TEST_F',
        qualifiedName: 'tests::TEST_F',
        filePath: 'src/repeated.cpp',
        language: 'cpp',
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 1,
        updatedAt: Date.now(),
      });
    }

    const hit = cg.searchNodes('tests::TEST_F', {
      exact: true,
      includePatterns: ['src/repeated.cpp'],
      line: 149,
      limit: 1,
    });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.node.startLine).toBe(149);
  });

  it('applies path filters inside FTS before its candidate LIMIT', () => {
    const hit = cg.searchNodes('Shared path:zzz-target', {
      kinds: ['class'],
      limit: 1,
    });
    expect(hit).toHaveLength(1);
    expect(hit[0]!.node.filePath).toContain('zzz-target.ts');
  });

  it('resolves C++-style and dotted qualified names without FTS', () => {
    const cpp = cg.searchNodes('UserService::lookupUser', { exact: true });
    const dotted = cg.searchNodes('UserService.lookupUser', { exact: true });
    for (const results of [cpp, dotted]) {
      expect(results).toHaveLength(1);
      expect(results[0]!.node.kind).toBe('method');
      expect(results[0]!.node.qualifiedName).toContain('UserService::lookupUser');
    }
  });

  it('preserves whitespace and ellipses in an exact C++ template qualified name', () => {
    const qualifiedName = 'ns::Tuple <typename T...>\n  ::type, U...>';
    const queries = (cg as unknown as {
      queries: { insertNode(node: Record<string, unknown>): void };
    }).queries;
    queries.insertNode({
      id: 'class:complex-template-query',
      kind: 'class',
      name: 'type, U...>',
      qualifiedName,
      filePath: 'src/complex-template.hpp',
      language: 'cpp',
      startLine: 1,
      endLine: 3,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });

    const results = cg.searchNodes(qualifiedName, { exact: true, kinds: ['class'] });
    expect(results.some((result) => result.node.qualifiedName === qualifiedName)).toBe(true);
  });

  it('intersects inline kind filters with SearchOptions kinds', () => {
    expect(
      cg.searchNodes('getUser kind:class', { exact: true, kinds: ['function'] })
    ).toEqual([]);
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
