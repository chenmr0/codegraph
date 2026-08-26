import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph, { SyncIncompleteError } from '../src/index';
import {
  CPP_MACRO_MANIFEST_METADATA_KEY,
  CPP_MACRO_MANIFEST_READY_METADATA_KEY,
} from '../src/extraction/macro-context';

function nodesInFile(graph: CodeGraph, name: string, filePath: string) {
  return graph.getNodesByName(name).filter((node) => node.filePath === filePath);
}

describe('C/C++ macro-context invalidation', () => {
  const tempDirs: string[] = [];
  const graphs: CodeGraph[] = [];

  function createProject(files: Record<string, string>): { dir: string; graph: CodeGraph } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-macro-sync-'));
    tempDirs.push(dir);
    for (const [relativePath, source] of Object.entries(files)) {
      const fullPath = path.join(dir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, source);
    }
    const graph = CodeGraph.initSync(dir);
    graphs.push(graph);
    return { dir, graph };
  }

  afterEach(() => {
    for (const graph of graphs.splice(0)) {
      try { graph.close(); } catch { /* already closed */ }
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reindexes an unchanged transitive macro user after reopen', async () => {
    const { dir, graph } = createProject({
      'defs.h': [
        '#define INNER(Name) struct Name { int old_field; };',
        '#define OUTER(Name) INNER(Name)',
        '',
      ].join('\n'),
      'use.cpp': 'OUTER(Generated)\n',
      'unrelated.cpp': 'int untouched_value;\n',
    });
    await graph.indexAll();

    expect(nodesInFile(graph, 'Generated', 'use.cpp')).toHaveLength(1);
    expect(nodesInFile(graph, 'old_field', 'use.cpp')).toHaveLength(1);
    expect(nodesInFile(graph, 'new_field', 'use.cpp')).toHaveLength(0);

    graph.close();
    graphs.splice(graphs.indexOf(graph), 1);
    fs.writeFileSync(path.join(dir, 'defs.h'), [
      '#define INNER(Name) struct Name { int new_field; };',
      '#define OUTER(Name) INNER(Name)',
      '',
    ].join('\n'));

    const reopened = CodeGraph.openSync(dir);
    graphs.push(reopened);
    // Watcher syncs are path-scoped. The unchanged consumer lives outside the
    // explicit event set and must still be pulled into the same transaction.
    const result = await reopened.sync({ paths: ['defs.h'] });

    expect(result.changedFilePaths).toEqual(expect.arrayContaining(['defs.h', 'use.cpp']));
    expect(result.changedFilePaths).not.toContain('unrelated.cpp');
    expect(nodesInFile(reopened, 'old_field', 'use.cpp')).toHaveLength(0);
    expect(nodesInFile(reopened, 'new_field', 'use.cpp')).toHaveLength(1);
  }, 30_000);

  it('does not invalidate macro users for an ordinary C++ source edit', async () => {
    const { dir, graph } = createProject({
      'defs.h': '#define DECL(Name) struct Name { int value; };\n',
      'use.cpp': 'DECL(Generated)\n',
      'ordinary.cpp': 'int ordinary_value;\n',
    });
    await graph.indexAll();

    fs.writeFileSync(
      path.join(dir, 'ordinary.cpp'),
      'int ordinary_value;\nint another_value;\n',
    );
    const result = await graph.sync({ paths: ['ordinary.cpp'] });

    expect(result.changedFilePaths).toEqual(['ordinary.cpp']);
    expect(nodesInFile(graph, 'Generated', 'use.cpp')).toHaveLength(1);
    expect(nodesInFile(graph, 'value', 'use.cpp')).toHaveLength(1);
  }, 30_000);

  it('invalidates users when a definition becomes ambiguous and restores them when it is unambiguous', async () => {
    const { dir, graph } = createProject({
      'defs-a.h': '#define DECL(Name) struct Name { int stable_field; };\n',
      'use.cpp': 'DECL(Generated)\n',
      'unrelated.cpp': 'int untouched_value;\n',
    });
    await graph.indexAll();
    expect(nodesInFile(graph, 'Generated', 'use.cpp')).toHaveLength(1);

    fs.writeFileSync(
      path.join(dir, 'defs-b.h'),
      '#define DECL(Name) class Name { int conflicting_field; };\n',
    );
    const conflicted = await graph.sync({ paths: ['defs-b.h'] });

    expect(conflicted.changedFilePaths).toEqual(expect.arrayContaining(['defs-b.h', 'use.cpp']));
    expect(nodesInFile(graph, 'Generated', 'use.cpp')).toHaveLength(0);
    expect(nodesInFile(graph, 'stable_field', 'use.cpp')).toHaveLength(0);

    fs.unlinkSync(path.join(dir, 'defs-b.h'));
    const restored = await graph.sync({ paths: ['defs-b.h'] });

    expect(restored.filesRemoved).toBe(1);
    expect(restored.changedFilePaths).toContain('use.cpp');
    expect(nodesInFile(graph, 'Generated', 'use.cpp')).toHaveLength(1);
    expect(nodesInFile(graph, 'stable_field', 'use.cpp')).toHaveLength(1);
    expect(restored.changedFilePaths).not.toContain('unrelated.cpp');
  }, 30_000);

  it('persists semantically neutral duplicate definitions for later diffs', async () => {
    const definition = '#define DECL(Name) struct Name { int stable_field; };\n';
    const { dir, graph } = createProject({
      'defs-a.h': definition,
      'use.cpp': 'DECL(Generated)\n',
    });
    await graph.indexAll();

    fs.writeFileSync(path.join(dir, 'defs-b.h'), definition);
    const duplicated = await graph.sync({ paths: ['defs-b.h'] });
    expect(duplicated.changedFilePaths).toEqual(['defs-b.h']);

    fs.unlinkSync(path.join(dir, 'defs-a.h'));
    const originalRemoved = await graph.sync({ paths: ['defs-a.h'] });
    expect(originalRemoved.changedFilePaths).toBeUndefined();
    expect(nodesInFile(graph, 'Generated', 'use.cpp')).toHaveLength(1);
    expect(nodesInFile(graph, 'stable_field', 'use.cpp')).toHaveLength(1);
  }, 30_000);

  it('conservatively rebuilds C-family files once when an old index has no manifest', async () => {
    const { dir, graph } = createProject({
      'defs.h': '#define DECL(Name) struct Name { int value; };\n',
      'use.cpp': 'DECL(Generated)\n',
      'ordinary.cpp': 'int ordinary_value;\n',
    });
    await graph.indexAll();

    const internal = graph as unknown as {
      queries: { setMetadata(key: string, value: string): void };
    };
    internal.queries.setMetadata(CPP_MACRO_MANIFEST_METADATA_KEY, '{"version":0}');
    internal.queries.setMetadata(CPP_MACRO_MANIFEST_READY_METADATA_KEY, '0');
    graph.close();
    graphs.splice(graphs.indexOf(graph), 1);

    const reopened = CodeGraph.openSync(dir);
    graphs.push(reopened);

    const result = await reopened.sync();
    expect(result.changedFilePaths).toEqual(expect.arrayContaining([
      'defs.h',
      'use.cpp',
      'ordinary.cpp',
    ]));

    const next = await reopened.sync();
    expect(next.changedFilePaths).toBeUndefined();
  }, 30_000);

  it('rebuilds the current context after an interrupted consumer invalidation', async () => {
    const { dir, graph } = createProject({
      'defs.h': '#define DECL(Name) struct Name { int old_field; };\n',
      'use.cpp': 'DECL(Generated)\n',
    });
    await graph.indexAll();
    fs.writeFileSync(
      path.join(dir, 'defs.h'),
      '#define DECL(Name) struct Name { int new_field; };\n',
    );

    const userPath = path.join(dir, 'use.cpp');
    let removed = false;
    let failure: unknown;
    try {
      await graph.sync({
        paths: ['defs.h'],
        onProgress: (progress) => {
          if (!removed && progress.phase === 'parsing' && progress.current === 0) {
            fs.unlinkSync(userPath);
            removed = true;
          }
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      fs.writeFileSync(userPath, 'DECL(Generated)\n');
    }

    expect(failure).toBeInstanceOf(SyncIncompleteError);
    expect((failure as SyncIncompleteError).result.failedFilePaths).toContain('use.cpp');
    graph.close();
    graphs.splice(graphs.indexOf(graph), 1);

    const reopened = CodeGraph.openSync(dir);
    graphs.push(reopened);
    const recovered = await reopened.sync();
    expect(recovered.changedFilePaths).toContain('use.cpp');
    expect(nodesInFile(reopened, 'old_field', 'use.cpp')).toHaveLength(0);
    expect(nodesInFile(reopened, 'new_field', 'use.cpp')).toHaveLength(1);
  }, 30_000);
});
