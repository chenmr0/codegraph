/**
 * Regression coverage for project-wide bodyless macro names colliding with
 * directly-written enum members. The C/C++ pre-parse pass must preserve the
 * member name without disabling legitimate empty-macro expansion elsewhere in
 * the enum body.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function enumMembers(source: string, language: 'c' | 'cpp', bodyless: string[]): string[] {
  const macros = new Set(bodyless);
  const result = extractFromSource(
    language === 'c' ? 'test.h' : 'test.cpp',
    source,
    language,
    undefined,
    macros,
    macros,
  );
  return result.nodes
    .filter((node) => node.kind === 'enum_member')
    .map((node) => node.name);
}

describe('bodyless macro collisions with enum members', () => {
  it('preserves colliding members in C typedef and anonymous enums', () => {
    const source = `
typedef enum NamedTag {
  FIRST,
  COLLIDING,
  LAST
} Named;

typedef enum {
  ANON_FIRST = 0,
  ANON_COLLIDING,
  ANON_LAST
} Anonymous;
`;

    expect(enumMembers(source, 'c', ['COLLIDING', 'ANON_COLLIDING'])).toEqual([
      'FIRST',
      'COLLIDING',
      'LAST',
      'ANON_FIRST',
      'ANON_COLLIDING',
      'ANON_LAST',
    ]);
  });

  it('preserves a colliding member in a C++ scoped enum', () => {
    const source = `
enum class Status {
  Ready,
  COLLIDING,
  Done
};
`;

    expect(enumMembers(source, 'cpp', ['COLLIDING'])).toEqual([
      'Ready',
      'COLLIDING',
      'Done',
    ]);
  });

  it('still blanks bodyless prefix, postfix, and initializer macros in enum bodies', () => {
    const source = `
enum Values {
  EMPTY_ATTR PREFIXED,
  POSTFIXED EMPTY_ATTR,
  INITIALIZED = EMPTY_VALUE 7,
  COLLIDING EMPTY_ATTR,
  FINAL_VALUE
};
`;

    expect(enumMembers(source, 'cpp', ['EMPTY_ATTR', 'EMPTY_VALUE', 'COLLIDING'])).toEqual([
      'PREFIXED',
      'POSTFIXED',
      'INITIALIZED',
      'COLLIDING',
      'FINAL_VALUE',
    ]);
  });
});

describe('project-wide bodyless macro collision pipeline', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the member across full indexing and incremental re-indexing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-enum-bodyless-'));
    tempDirs.push(dir);
    const enumHeader = path.join(dir, 'enums.h');

    fs.writeFileSync(
      path.join(dir, 'macros.h'),
      '#define COLLIDING\n#define EMPTY_ATTR\n',
    );
    fs.writeFileSync(
      enumHeader,
      'typedef enum { FIRST, COLLIDING, LAST } Status;\n',
    );

    const graph = await CodeGraph.init(dir, { silent: true });
    try {
      await graph.indexAll();

      const findMembers = () => graph
        .getNodesByName('COLLIDING')
        .filter((node) => node.kind === 'enum_member');

      expect(findMembers()).toHaveLength(1);

      fs.appendFileSync(enumHeader, '// force incremental re-index\n');
      const syncResult = await graph.sync();
      expect(syncResult.filesModified).toBe(1);
      expect(findMembers()).toHaveLength(1);
    } finally {
      graph.close();
    }
  }, 30_000);
});
