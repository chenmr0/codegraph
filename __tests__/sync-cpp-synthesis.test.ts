import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { QueryBuilder } from '../src/db/queries';

function rawDb(cg: CodeGraph): any {
  const handle = (cg as any).db?.db;
  if (handle && typeof handle.prepare === 'function') return handle;
  throw new Error('raw DB handle not accessible');
}

function synthesizedEdges(cg: CodeGraph, synthesizedBy: string): any[] {
  return rawDb(cg)
    .prepare(
      `SELECT s.name source_name, s.file_path source_path,
              t.name target_name, t.file_path target_path, e.kind
       FROM edges e
       JOIN nodes s ON s.id = e.source
       JOIN nodes t ON t.id = e.target
       WHERE json_extract(e.metadata, '$.synthesizedBy') = ?`
    )
    .all(synthesizedBy) as any[];
}

describe('C/C++ incremental synthesis', () => {
  let directory: string;
  let cg: CodeGraph | null;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-cpp-synth-'));
    cg = null;
  });

  afterEach(() => {
    try {
      cg?.destroy();
    } catch {
      // Already closed by a failed assertion path.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rebuilds a C declaration-definition edge without a whole-graph node scan', async () => {
    fs.writeFileSync(path.join(directory, 'api.h'), 'int calculate(int value);\n');
    fs.writeFileSync(
      path.join(directory, 'api.c'),
      '#include "api.h"\nint calculate(int value) { return value + 1; }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(synthesizedEdges(cg, 'c-decl-def')).toHaveLength(1);

    const wholeGraphScans = vi.spyOn(QueryBuilder.prototype, 'iterateNodesByKind');
    try {
      fs.writeFileSync(
        path.join(directory, 'api.c'),
        '#include "api.h"\nint calculate(int value) { return value + 2; }\n'
      );
      const result = await cg.sync({ paths: ['api.c'] });

      expect(result.filesModified).toBe(1);
      expect(synthesizedEdges(cg, 'c-decl-def')).toHaveLength(1);
      expect(wholeGraphScans).not.toHaveBeenCalled();
    } finally {
      wholeGraphScans.mockRestore();
    }

    // Removing the declaration cascades the old heuristic edge. Adding the
    // header back must recreate it from the changed-file scope.
    fs.unlinkSync(path.join(directory, 'api.h'));
    await cg.sync({ paths: ['api.h'] });
    expect(synthesizedEdges(cg, 'c-decl-def')).toHaveLength(0);

    fs.writeFileSync(path.join(directory, 'api.h'), 'int calculate(int value);\n');
    await cg.sync({ paths: ['api.h'] });
    expect(synthesizedEdges(cg, 'c-decl-def')).toHaveLength(1);
  });

  it('rebuilds a C++ out-of-line method declaration-definition edge', async () => {
    fs.writeFileSync(
      path.join(directory, 'widget.hpp'),
      'class Widget { public: int render(); };\n'
    );
    fs.writeFileSync(
      path.join(directory, 'widget.cpp'),
      '#include "widget.hpp"\nint Widget::render() { return 1; }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(synthesizedEdges(cg, 'cpp-decl-def')).toHaveLength(1);

    fs.writeFileSync(
      path.join(directory, 'widget.cpp'),
      '#include "widget.hpp"\nint Widget::render() { return 2; }\n'
    );
    await cg.sync({ paths: ['widget.cpp'] });

    const edges = synthesizedEdges(cg, 'cpp-decl-def');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source_name: 'render',
      target_name: 'render',
      kind: 'defines',
    });
    expect(edges[0]!.source_path).toMatch(/widget\.cpp$/);
    expect(edges[0]!.target_path).toMatch(/widget\.hpp$/);
  });

  it('rebuilds an extern-variable declaration-definition edge', async () => {
    fs.writeFileSync(path.join(directory, 'state.h'), 'extern int global_state;\n');
    fs.writeFileSync(
      path.join(directory, 'state.c'),
      '#include "state.h"\nint global_state = 1;\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(synthesizedEdges(cg, 'c-cpp-var-decl-def')).toHaveLength(1);

    fs.writeFileSync(
      path.join(directory, 'state.c'),
      '#include "state.h"\nint global_state = 2;\n'
    );
    await cg.sync({ paths: ['state.c'] });

    const edges = synthesizedEdges(cg, 'c-cpp-var-decl-def');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source_name: 'global_state',
      target_name: 'global_state',
      kind: 'defines',
    });
  });

  it('rebuilds a C++ virtual-override bridge after the class file changes', async () => {
    const source = (returnValue: number) =>
      `class Base {
 public:
  virtual int run() { return 0; }
};
class Derived : public Base {
 public:
  int run() override { return ${returnValue}; }
};
`;
    fs.writeFileSync(path.join(directory, 'override.cpp'), source(1));

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(synthesizedEdges(cg, 'cpp-override')).toHaveLength(1);

    fs.writeFileSync(path.join(directory, 'override.cpp'), source(2));
    await cg.sync({ paths: ['override.cpp'] });

    const edges = synthesizedEdges(cg, 'cpp-override');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source_name: 'run',
      target_name: 'run',
      kind: 'calls',
    });
  });

  it('keeps the base sync usable when scoped synthesis fails', async () => {
    fs.writeFileSync(path.join(directory, 'safe.c'), 'int safe_value(void) { return 1; }\n');
    cg = CodeGraph.initSync(directory);
    await cg.indexAll();

    const synthesis = vi
      .spyOn((cg as any).resolver, 'synthesizeIncrementalCCpp')
      .mockRejectedValueOnce(new Error('injected scoped synthesis failure'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      fs.writeFileSync(
        path.join(directory, 'safe.c'),
        'int safe_value(void) { return 2; }\nint still_indexed(void) { return 3; }\n'
      );

      await expect(cg.sync({ paths: ['safe.c'] })).resolves.toMatchObject({
        filesModified: 1,
      });
      expect(cg.getNodesByName('still_indexed')).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('injected scoped synthesis failure')
      );
    } finally {
      synthesis.mockRestore();
      errorLog.mockRestore();
    }
  });
});
