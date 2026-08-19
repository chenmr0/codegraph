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
      `export function missing_symbol_helper(): void { return; }\n` +
      // A class whose name shares the `helper` prefix (case-folded) — used by
      // the kind-filter test: an exact `helper` search filtered to kind=class
      // has no exact match, so it must fall back to fuzzy and surface this.
      `export class HelperUtils { value = 1; }\n`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'service.h'),
      'class Service { public: int execute(int value); };\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'service.cpp'),
      '#include "service.h"\nint Service::execute(int value) { return value + 1; }\n',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'raw_markers.cpp'),
      '// FIRST_RAW_MARKER and SECOND_RAW_MARKER intentionally remain comments.\n',
    );

    cg = await CodeGraph.init(tempDir, {
      config: { include: ['**/*.ts', '**/*.h', '**/*.cpp'], exclude: [] },
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
    const result = await handler.execute('search', { query: 'helper' });
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
    const result = await handler.execute('search', { query: 'nonexist' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;

    // No exact `nonexist`, so the closest fuzzy match surfaces, flagged.
    expect(text).toMatch(/⚠️ No exact match for "nonexist"/);
    expect(text).toContain('nonexistThing');
  });

  it('adds exact raw evidence behind fuzzy results for a distinctive identifier', async () => {
    const result = await handler.execute('search', { query: 'missing_symbol' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/⚠️ No exact match for "missing_symbol"/);
    expect(text).toContain('missing_symbol_helper');
    expect(text).toMatch(/No raw-source matches/i);
    expect(text).toContain('CONFIRMED_ABSENT');
  });

  it('falls back to fuzzy with a warning when the kind filter eliminates the exact match', async () => {
    // `helper` exists, but only as a function and a method — not as a class.
    // Filtering kind=class yields no exact match, so it must fall back to
    // fuzzy and surface the class-typed prefix candidate `HelperUtils` with
    // the warning (rather than returning an empty result).
    const result = await handler.execute('search', {
      query: 'helper',
      kind: 'class',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/⚠️ No exact match for "helper"/);
    expect(text).toContain('HelperUtils');
    expect(text).not.toMatch(/raw-source (?:match|scan)/i);
  });

  it('resolves a qualified input exactly and exposes the qualified name', async () => {
    const result = await handler.execute('search', { query: 'Widget.helper' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('### helper (method)');
    expect(text).toContain('Qualified: `Widget::helper`');
    expect(text).not.toContain('### helper (function)');
    expect(text).not.toMatch(/closest matches/i);
  });

  it('auto-corrects a stray quote in includeCode instead of failing the call', async () => {
    const result = await handler.execute('search', {
      query: 'helperSync',
      includeCode: 'if_unique"',
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toMatch(/Automatically corrected includeCode/i);
    expect(text).toContain('function helperSync');
  });

  it('uses path to disambiguate same-named exact symbols before limiting', async () => {
    const result = await handler.execute('search', {
      query: 'helper',
      path: 'src/b.ts',
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('src/b.ts');
    expect(text).not.toContain('src/a.ts');
  });

  it('uses path and line to pin one physical node among repeated qualified names', async () => {
    const queries = (cg as unknown as {
      queries: { insertNode(node: Record<string, unknown>): void };
    }).queries;
    for (let line = 1; line <= 120; line++) {
      queries.insertNode({
        id: `function:mcp-test-f-${line}`,
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

    const result = await handler.execute('search', {
      query: 'tests::TEST_F',
      path: 'src/repeated.cpp',
      line: 119,
      limit: 1,
    });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('src/repeated.cpp:119');
    expect(text).not.toContain('src/repeated.cpp:118');
  });

  it('does not fuzzy-fallback for an unknown qualified input', async () => {
    const result = await handler.execute('search', { query: 'Foo.bar' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('No results found');
  });

  it('returns declaration and definition source for one exact logical overload', async () => {
    const result = await handler.execute('search', {
      query: 'Service::execute',
      includeCode: 'if_unique',
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text).toContain('int execute(int value);');
    expect(text).toContain('int Service::execute(int value) { return value + 1; }');
    expect(text).toMatch(/all source bodies are included/i);
  });

  it('recovers a wrong qualified owner from exact leaf candidates without raw scanning', async () => {
    const result = await handler.execute('search', {
      query: 'LegacyService::execute',
      includeCode: 'if_unique',
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Qualified owner mismatch/i);
    expect(text).toContain('Service::execute');
    expect(text).toContain('return value + 1');
    expect(text).not.toMatch(/raw-source (?:match|scan)/i);
  });

  it('batches symbol queries and emits one shared multi-pattern raw fallback report', async () => {
    const result = await handler.execute('search', {
      queries: [
        { query: 'helperSync', includeCode: 'if_unique' },
        { query: 'FIRST_RAW_MARKER' },
        { query: 'SECOND_RAW_MARKER' },
      ],
    });
    const text = result.content[0]!.text;
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Batch symbol search \(3 queries\)/i);
    expect(text).toContain('function helperSync');
    expect(text.match(/Found 1 raw-source match/g)).toHaveLength(2);
    expect(text).toMatch(/Found 1 raw-source match for `FIRST_RAW_MARKER`/i);
    expect(text).toMatch(/Found 1 raw-source match for `SECOND_RAW_MARKER`/i);
    expect(text).not.toMatch(/server-side|Coverage:|KiB|MiB/i);
  });
});
