import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { formatStaleBanner, getStaticTools, ToolHandler } from '../src/mcp/tools';

describe('MCP bounded batch context and literal search', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-batch-context-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'flow.ts'),
      [
        'export function helper(x: number) { return x + 1; }',
        'export function first() { return helper(1); }',
        'export function second() { return first(); }',
        'export const TABLE_NAME = "__all_virtual_demo";',
        '// REGISTER_CHANNEL(TABLE_NAME)',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'widget.generated.ts'),
      'export const GENERATED_MARKER = "__all_virtual_demo";\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'overloads.h'),
      [
        'struct ObDtlLinkedBuffer {};',
        'class ObDtlBasicChannel {',
        'public:',
        '  int push_back_send_list(ObDtlLinkedBuffer *buffer);',
        '  int push_back_send_list();',
        '};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'overloads.cpp'),
      [
        '#include "overloads.h"',
        'int ObDtlBasicChannel::push_back_send_list() { return 0; }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'metrics.h'),
      [
        'namespace common { struct ObNewRow {}; struct ObAddr {}; }',
        'struct ObVirtualChannelInfo {};',
        'class TransferMetrics {',
        'public:',
        '  int get_row(ObVirtualChannelInfo &chan_info, common::ObNewRow *&row);',
        '  int make_channel(const common::ObAddr &addr);',
        '};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'metrics.cpp'),
      [
        '#include "metrics.h"',
        'using common::ObAddr;',
        'using common::ObNewRow;',
        'int TransferMetrics::get_row(ObVirtualChannelInfo &info, ObNewRow *&result) { return 0; }',
        'int TransferMetrics::make_channel(const ObAddr &address) { return 0; }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'named_container.h'),
      [
        'class NamedContainer {',
        'public:',
        '  NamedContainer();',
        '  explicit NamedContainer(int value);',
        '  int run();',
        '};',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'named_container.cpp'),
      [
        '#include "named_container.h"',
        'NamedContainer::NamedContainer() {}',
        'NamedContainer::NamedContainer(int value) {}',
        'int NamedContainer::run() { return 1; }',
        '',
      ].join('\n'),
    );
    cg = CodeGraph.initSync(dir, {
      config: { include: ['src/**/*.ts', 'src/**/*.h', 'src/**/*.cpp'], exclude: [] },
    });
    await cg.indexAll();
    const db = (cg as any).db.getDb();
    const noArgDefinition = db.prepare(
      `SELECT id FROM nodes
       WHERE name = 'push_back_send_list' AND file_path = 'src/overloads.cpp'`,
    ).get() as { id: string };
    const pointerDeclaration = db.prepare(
      `SELECT id FROM nodes
       WHERE name = 'push_back_send_list' AND file_path = 'src/overloads.h'
         AND signature LIKE '%ObDtlLinkedBuffer%'`,
    ).get() as { id: string };
    const first = db.prepare(
      `SELECT id FROM nodes WHERE name = 'first' AND file_path = 'src/flow.ts'`,
    ).get() as { id: string };
    const second = db.prepare(
      `SELECT id FROM nodes WHERE name = 'second' AND file_path = 'src/flow.ts'`,
    ).get() as { id: string };
    const helper = db.prepare(
      `SELECT id FROM nodes WHERE name = 'helper' AND file_path = 'src/flow.ts'`,
    ).get() as { id: string };
    const insertEdge = db.prepare(
      `INSERT INTO edges (source, target, kind, provenance)
       VALUES (?, ?, 'calls', 'relationship-overload-test')`,
    );
    // Give each overload a distinct caller and callee so an accidental merge
    // is observable even when the language resolver would not connect a
    // declaration-only overload on its own.
    insertEdge.run(first.id, noArgDefinition.id);
    insertEdge.run(noArgDefinition.id, helper.id);
    insertEdge.run(second.id, pointerDeclaration.id);
    insertEdge.run(pointerDeclaration.id, second.id);
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const output = async (tool: string, args: Record<string, unknown>) =>
    (await handler.execute(tool, args)).content.map((c) => c.text).join('\n');

  it('publishes the two optimized MCP tools', () => {
    const names = getStaticTools().map((tool) => tool.name);
    expect(names).toContain('context');
    expect(names).toContain('text_search');
    expect(names.some((name) => name.startsWith('codegraph_'))).toBe(false);
  });

  it('scopes a stale warning to only the files it names', () => {
    const banner = formatStaleBanner([
      { path: 'src/stale.cpp', lastSeenMs: Date.now(), indexing: false },
    ]);
    expect(banner).toMatch(/ONLY the files listed above are stale/i);
    expect(banner).toMatch(/Every unlisted file.*fresh/i);
  });

  it('returns several exact symbol bodies in one call without repetitive trails', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'first', file: 'flow.ts' },
        { symbol: 'second', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('return helper(1)');
    expect(out).toContain('return first()');
    expect(out).not.toContain('### Trail');
    expect(out).toMatch(/Treat them as already read/i);
  });

  it('inlines source during search when one logical symbol remains', async () => {
    const out = await output('search', {
      query: 'first',
      path: 'flow.ts',
      includeCode: 'if_unique',
    });
    expect(out).toMatch(/Unique exact result; source included/i);
    expect(out).toContain('return helper(1)');
    expect(out).toMatch(/Do not call codegraph_node/i);
  });

  it('accepts a callable signature directly in search and never guesses a bad signature', async () => {
    const precise = await output('search', {
      query: 'int push_back_send_list(ObDtlLinkedBuffer *buffer)',
      includeCode: 'if_unique',
    });
    expect(precise).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(precise).toMatch(/No indexed definition found/i);

    const bad = await output('search', {
      query: 'push_back_send_list',
      signature: 'push_back_send_list(double value)',
      includeCode: 'if_unique',
    });
    expect(bad).toMatch(/Signature hint did not match/i);
    expect(bad).toMatch(/No source was inlined/i);
  });

  it('does not misread a natural-language question containing parentheses as a signature', async () => {
    const out = await output('search', { query: 'how does first() work?' });
    expect(out).toMatch(/symbol name|符号名/i);
    expect(out).not.toContain('return helper(1)');
  });

  it('corrects a unique symbol capitalization mismatch in the same call', async () => {
    const out = await output('search', {
      query: 'namedcontainer',
      includeCode: 'if_unique',
    });
    expect(out).toMatch(/Case-insensitive unique correction/i);
    expect(out).toContain('NamedContainer (class)');
  });

  it('applies the same capitalization correction to relationship tools', async () => {
    const out = await output('callers', { symbol: 'FIRST' });
    expect(out).toMatch(/Case-insensitive exact-name correction/i);
    expect(out).toContain('second (function)');
  });

  it('batches selected container members without returning the whole container', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'NamedContainer', file: 'named_container.h', members: ['run'] },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('member: run');
    expect(out).toMatch(/^5\t {2}int run\(\);$/m);
    expect(out).toContain('int NamedContainer::run() { return 1; }');
    expect(out).not.toContain('Members (3; showing 3)');
    expect(out).toContain('return helper(1)');
  });

  it('merges overlapping and adjacent file windows and text anchors', async () => {
    const out = await output('context', {
      targets: [
        { file: 'flow.ts', offset: 1, limit: 3 },
        { file: 'flow.ts', text: 'TABLE_NAME', contextLines: 0 },
      ],
    });
    expect(out).toMatch(/merged current-source ranges 1-4/i);
    expect(out.match(/^1\texport function helper/gm)).toHaveLength(1);
    expect(out.match(/^4\texport const TABLE_NAME/gm)).toHaveLength(1);
    expect(out).not.toMatch(/used by/i);
  });

  it('auto-clamps an oversized context file window in place', async () => {
    const out = await output('context', {
      targets: [{ file: 'flow.ts', offset: 1, limit: 400 }],
    });
    expect(out).toMatch(/safely clamped to 240 lines/i);
    expect(out).toContain('TABLE_NAME');
  });

  it('prefers a named container over same-name constructors unless precisely pinned', async () => {
    const contextOut = await output('context', {
      targets: [
        { symbol: 'NamedContainer', file: 'named_container.h' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(contextOut).toContain('NamedContainer (class)');
    expect(contextOut).toContain('Members (3; showing 3)');
    expect(contextOut).not.toMatch(/distinct overload candidates/i);

    const nodeOut = await output('node', {
      symbol: 'NamedContainer',
      file: 'named_container.h',
      includeCode: true,
    });
    expect(nodeOut).toContain('NamedContainer (class)');
    expect(nodeOut).not.toMatch(/definitions named "NamedContainer"/i);

    const constructorOut = await output('context', {
      targets: [
        {
          symbol: 'NamedContainer',
          file: 'named_container.h',
          signature: 'NamedContainer(int value)',
        },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(constructorOut).toContain('explicit NamedContainer(int value)');
  });

  it('returns same-name overload candidates together instead of silently choosing one', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'push_back_send_list', file: 'overloads.h' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toMatch(/distinct overload candidates/i);
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out).toContain('push_back_send_list()');
    expect(out).not.toMatch(/ambiguous.*add file\/line/i);
  });

  it('refuses to aggregate callers, callees, or impact across distinct overloads', async () => {
    for (const tool of ['callers', 'callees', 'impact']) {
      const out = await output(tool, { symbol: 'push_back_send_list' });
      expect(out).toMatch(/Ambiguous relationship target/i);
      expect(out).toMatch(/No (callers|callees|impact) traversal was run/i);
      expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
      expect(out).toContain('push_back_send_list()');
      expect(out).not.toContain('first (function)');
      expect(out).not.toContain('second (function)');
    }
  });

  it('uses a signature hint to select one overload for every relationship tool', async () => {
    const callers = await output('callers', {
      symbol: 'push_back_send_list',
      signature: 'push_back_send_list(ObDtlLinkedBuffer *buffer)',
    });
    expect(callers).toContain('second (function)');
    expect(callers).not.toContain('first (function)');

    const callees = await output('callees', {
      symbol: 'int push_back_send_list(ObDtlLinkedBuffer *buffer)',
    });
    expect(callees).toContain('second (function)');
    expect(callees).not.toContain('helper (function)');

    const impact = await output('impact', {
      symbol: 'push_back_send_list',
      signature: 'push_back_send_list(ObDtlLinkedBuffer *buffer)',
      depth: 1,
    });
    expect(impact).toContain('second:3');
    expect(impact).not.toContain('first:2');
  });

  it('uses canonical C++ parameter matching for a relationship signature hint', async () => {
    const out = await output('callers', {
      symbol: 'make_channel',
      signature: 'make_channel(const common::ObAddr &addr)',
    });
    expect(out).not.toMatch(/Ambiguous relationship target/i);
    expect(out).not.toMatch(/Signature hint did not match/i);
    expect(out).toMatch(/No callers found for.*make_channel/i);
  });

  it('uses file and line to select the intended overload without nearest guessing', async () => {
    const callers = await output('callers', {
      symbol: 'push_back_send_list',
      file: 'overloads.cpp',
      line: 2,
    });
    expect(callers).toContain('first (function)');
    expect(callers).not.toContain('second (function)');

    const badLine = await output('impact', {
      symbol: 'push_back_send_list',
      file: 'overloads.cpp',
      line: 999,
    });
    expect(badLine).toMatch(/line hint is outside every matching symbol body/i);
    expect(badLine).toMatch(/No impact traversal was run/i);
    expect(badLine).not.toContain('affects');
  });

  it('treats a bad signature as an assertion failure instead of falling back', async () => {
    const out = await output('callees', {
      symbol: 'push_back_send_list',
      file: 'overloads.h',
      signature: 'push_back_send_list(double value)',
    });
    expect(out).toMatch(/Signature hint did not match/i);
    expect(out).toMatch(/No callees traversal was run/i);
    expect(out).not.toContain('helper (function)');
    expect(out).not.toContain('second (function)');
  });

  it('does not collapse a different overload behind a stale legacy defines edge', async () => {
    const db = (cg as any).db.getDb();
    const definition = db.prepare(
      `SELECT id FROM nodes
       WHERE name = 'push_back_send_list' AND file_path = 'src/overloads.cpp'`,
    ).get() as { id: string };
    const pointerDeclaration = db.prepare(
      `SELECT id FROM nodes
       WHERE name = 'push_back_send_list' AND file_path = 'src/overloads.h'
         AND signature LIKE '%ObDtlLinkedBuffer%'`,
    ).get() as { id: string };
    db.prepare(
      `INSERT OR IGNORE INTO edges (source, target, kind, provenance)
       VALUES (?, ?, 'defines', 'legacy-test')`,
    ).run(definition.id, pointerDeclaration.id);

    const out = await output('context', {
      targets: [
        { symbol: 'push_back_send_list' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out).toMatch(/distinct overload candidates/i);
  });

  it('can narrow same-file overloads with an optional signature hint', async () => {
    const out = await output('context', {
      targets: [
        {
          symbol: 'push_back_send_list',
          file: 'overloads.h',
          signature: 'push_back_send_list(ObDtlLinkedBuffer *buffer)',
        },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out.match(/^4\t.*push_back_send_list/gm)).toHaveLength(1);
    expect(out).toContain('Other overloads (summary only)');
  });

  it('does not silently select the nearest overload when a line hint misses', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'push_back_send_list', file: 'overloads.cpp', line: 999 },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toMatch(/line hint is outside every matching symbol body/i);
    expect(out).toMatch(/No nearest overload was selected/i);
    expect(out).toContain('overloads.cpp:2');
  });

  it('does not silently select a symbol when the file hint misses', async () => {
    const out = await output('node', {
      symbol: 'push_back_send_list',
      file: 'missing.cpp',
      line: 2,
      includeCode: true,
    });
    expect(out).toMatch(/file hint matched no exact symbol candidate/i);
    expect(out).toContain('overloads.cpp:2');
    expect(out).toContain('overloads.h:4');
    expect(out).toMatch(/definitions named "push_back_send_list"/i);
  });

  it('summarizes sibling overloads after a precise single-node lookup', async () => {
    const out = await output('node', {
      symbol: 'push_back_send_list',
      file: 'overloads.cpp',
      line: 2,
      includeCode: true,
    });
    expect(out).toContain('Other overloads (summary only)');
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out).toMatch(/no indexed definition found for this exact overload/i);
    expect(out).toMatch(/codegraph_callers.*codegraph_callees/i);
  });

  it('marks a directly requested declaration-only overload as authoritative', async () => {
    const out = await output('node', {
      symbol: 'push_back_send_list',
      file: 'overloads.h',
      line: 4,
      includeCode: true,
    });
    expect(out).toMatch(/No indexed definition found for this exact overload/i);
    expect(out).toMatch(/do not use Grep or text search merely to verify absence/i);
  });

  it('uses canonical C++ matching when an older index is missing its defines edge', async () => {
    const db = (cg as any).db.getDb();
    db.prepare(
      `DELETE FROM edges
       WHERE kind = 'defines' AND (source IN (
         SELECT id FROM nodes WHERE name = 'get_row'
       ) OR target IN (
         SELECT id FROM nodes WHERE name = 'get_row'
       ))`,
    ).run();

    const out = await output('node', {
      symbol: 'get_row',
      file: 'metrics.h',
      line: 5,
      includeCode: true,
    });
    expect(out).toMatch(/Definition:.*metrics\.cpp:4/i);
    expect(out).not.toMatch(/No indexed definition found/i);

    const batchOut = await output('context', {
      targets: [
        { symbol: 'get_row' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(batchOut).toMatch(/1 distinct overload candidate/i);
    expect(batchOut).toMatch(/1 paired declaration.*collapsed/i);

    db.prepare(
      `DELETE FROM edges
       WHERE kind = 'defines' AND (source IN (
         SELECT id FROM nodes WHERE name = 'make_channel'
       ) OR target IN (
         SELECT id FROM nodes WHERE name = 'make_channel'
       ))`,
    ).run();
    const qualifiedTypeOut = await output('node', {
      symbol: 'make_channel',
      file: 'metrics.h',
      line: 6,
      includeCode: true,
    });
    expect(qualifiedTypeOut).toMatch(/Definition:.*metrics\.cpp:5/i);
    expect(qualifiedTypeOut).not.toMatch(/No indexed definition found/i);
  });

  it('makes declaration-only overload status explicit in symbol search', async () => {
    const out = await output('search', { query: 'push_back_send_list' });
    expect(out).toMatch(/declaration — no indexed definition found for this exact overload/i);
    expect(out).toMatch(/authoritative for the current index/i);
  });

  it('does not pair same-signature declarations and definitions from unrelated owners', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'owners.h'),
      'class Alpha { public: int run(int value); };\nclass Beta { public: int run(int value); };\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'owners.cpp'),
      '#include "owners.h"\nint Beta::run(int value) { return value; }\n',
    );
    await cg.sync({ paths: ['src/owners.h', 'src/owners.cpp'] });

    const out = await output('node', {
      symbol: 'run',
      file: 'owners.h',
      line: 1,
      includeCode: true,
    });
    expect(out).toMatch(/No indexed definition found for this exact overload/i);
    expect(out).not.toMatch(/Definition:.*owners\.cpp:2/i);
  });

  it('accepts a copied callable signature directly in the symbol field', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'push_back_send_list(ObDtlLinkedBuffer *buffer)', file: 'overloads.h' },
        { symbol: 'first', file: 'flow.ts' },
      ],
    });
    expect(out).toContain('push_back_send_list(ObDtlLinkedBuffer *buffer)');
    expect(out.match(/^4\t.*push_back_send_list/gm)).toHaveLength(1);
    expect(out).toContain('Other overloads (summary only)');
  });

  it('can opt into relation trails for a batch', async () => {
    const out = await output('context', {
      targets: [
        { symbol: 'first', file: 'flow.ts' },
        { symbol: 'second', file: 'flow.ts' },
      ],
      includeRelations: true,
    });
    expect(out).toContain('### Trail');
  });

  it('suppresses trails automatically for an already-pinned single-symbol edit target', async () => {
    const precise = await output('node', {
      symbol: 'first',
      file: 'flow.ts',
      line: 2,
      includeCode: true,
    });
    const exploratory = await output('node', {
      symbol: 'first',
      includeCode: true,
    });
    expect(precise).not.toContain('### Trail');
    expect(exploratory).toContain('### Trail');
  });

  it('accepts one precise context target without forcing a correction call', async () => {
    const single = await handler.execute('context', { targets: [{ symbol: 'first', file: 'flow.ts' }] });
    const singleOut = single.content.map((c) => c.text).join('\n');
    const invalid = await handler.execute('context', { targets: 'first' });
    const empty = await handler.execute('context', { targets: [] });
    const blank = await handler.execute('context', {
      targets: [{ symbol: 'first' }, { symbol: '   ' }],
    });
    expect(single.isError).not.toBe(true);
    expect(singleOut).toMatch(/One precise context target was supplied/i);
    expect(singleOut).toContain('return helper(1)');
    expect(invalid.isError).toBe(true);
    expect(empty.isError).toBe(true);
    expect(blank.isError).toBe(true);
  });

  it('batch-searches literals in a bounded path and skips generated source by default', async () => {
    const out = await output('text_search', {
      queries: ['__all_virtual_demo', 'REGISTER_CHANNEL'],
      path: 'src',
      contextLines: 0,
    });
    expect(out).toContain('src/flow.ts:4');
    expect(out).toContain('src/flow.ts:4-5');
    expect(out).toMatch(/1 unique window/i);
    expect(out.match(/^4\texport const TABLE_NAME/gm)).toHaveLength(1);
    expect(out.match(/^5\t\/\/ REGISTER_CHANNEL/gm)).toHaveLength(1);
    expect(out).not.toContain('widget.generated.ts');
    expect(out).toMatch(/1 generated file\(s\) skipped/i);
    expect(out).toMatch(/do not repeat.*Grep/i);
  });

  it('includes generated source only when explicitly requested', async () => {
    const out = await output('text_search', {
      queries: ['__all_virtual_demo'],
      path: 'src',
      includeGenerated: true,
      maxMatchesPerQuery: 5,
    });
    expect(out).toContain('widget.generated.ts');
  });

  it('rejects unbounded or malformed literal searches', async () => {
    const noPath = await handler.execute('text_search', { queries: ['TABLE_NAME'] });
    const rootPath = await handler.execute('text_search', {
      queries: ['TABLE_NAME'],
      path: '.',
    });
    const blankQuery = await handler.execute('text_search', {
      queries: ['   '],
      path: 'src',
    });
    const regexShapedButLiteral = await output('text_search', {
      queries: ['TABLE_.*'],
      path: 'src',
    });
    expect(noPath.isError).toBe(true);
    expect(rootPath.isError).toBe(true);
    expect(blankQuery.isError).toBe(true);
    expect(regexShapedButLiteral).toMatch(/0 matches/i);
  });
});
