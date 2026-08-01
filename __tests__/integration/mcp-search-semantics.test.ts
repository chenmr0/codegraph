/**
 * codegraph_search semantics — exact-first, fuzzy-fallback with warning
 *
 * Mirrors the resolution pattern already used by codegraph_node /
 * codegraph_explore (findSymbolMatches / findAllSymbols): a bare name is
 * resolved through the direct exact-name index first, and only falls back
 * to the FTS→LIKE→edit-distance chain — flagged with a `⚠️ No exact match`
 * warning — when no exact match exists. These tests pin that behavior so a
 * search for an exact name can't regress to burying it under prefix /
 * case-folded lookalikes, and a name with no exact match can't regress to an
 * empty result that sends the agent back to grep.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../../src/index';
import { ToolHandler } from '../../src/mcp/tools';

describe('codegraph_search semantics — exact-first, fuzzy-fallback', () => {
  let tempDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-search-sem-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });

    // Exact-name targets: a top-level `helper` function AND a `helper`
    // method on a class (two distinct nodes sharing the bare name), plus a
    // `helperSync` function that must NOT surface under an exact `helper`
    // search (prefix noise / case-folded lookalike).
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `export function helper(): void { return; }\n` +
      `export function helperSync(): void { return; }\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b.ts'),
      `export class Widget {\n` +
      `  helper(): void { return; }\n` +
      `}\n`
    );
    // A fuzzy-fallback target: searching `nonexist` (no exact match) should
    // surface `nonexistThing` with a warning, not an empty result.
    fs.writeFileSync(
      path.join(tempDir, 'src', 'c.ts'),
      `export function nonexistThing(): void { return; }\n` +
      // A class whose name shares the `helper` prefix (case-folded) — used by
      // the kind-filter test: an exact `helper` search filtered to kind=class
      // has no exact match, so it must fall back to fuzzy and surface this.
      `export class HelperUtils { value = 1; }\n`
    );

    cg = await CodeGraph.init(tempDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns every exact-name definition and excludes prefix lookalikes', async () => {
    const result = await handler.execute('codegraph_search', { query: 'helper' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;

    // The exact name `helper` (both the function and the method) is present.
    expect(text).toContain('### helper (function)');
    expect(text).toContain('### helper (method)');
    // The prefix lookalike `helperSync` must NOT leak in.
    expect(text).not.toContain('helperSync');
    // An exact hit carries no fuzzy-fallback warning.
    expect(text).not.toMatch(/⚠️ No exact match/);
  });

  it('falls back to fuzzy matches with a warning when no exact match exists', async () => {
    const result = await handler.execute('codegraph_search', { query: 'nonexist' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;

    // No exact `nonexist`, so the closest fuzzy match surfaces, flagged.
    expect(text).toMatch(/⚠️ No exact match for "nonexist"/);
    expect(text).toContain('nonexistThing');
  });

  it('falls back to fuzzy with a warning when the kind filter eliminates the exact match', async () => {
    // `helper` exists, but only as a function and a method — not as a class.
    // Filtering kind=class yields no exact match, so it must fall back to
    // fuzzy and surface the class-typed prefix candidate `HelperUtils` with
    // the warning (rather than returning an empty result).
    const result = await handler.execute('codegraph_search', {
      query: 'helper',
      kind: 'class',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/⚠️ No exact match for "helper"/);
    expect(text).toContain('HelperUtils');
  });

  it('does not crash on a qualified input (falls through to the fuzzy path)', async () => {
    const result = await handler.execute('codegraph_search', { query: 'Foo.bar' });
    // Qualified names are discouraged in the tool description (use codegraph_node
    // to resolve them), but the handler must not throw — it falls through to
    // the FTS fuzzy path and returns either candidates or "No results found".
    expect(result.isError).toBeFalsy();
  });
});