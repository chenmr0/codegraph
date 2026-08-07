/**
 * Regression coverage for C/C++ raw-first macro recovery. Healthy source must
 * remain byte-for-byte unmodified even when an unrelated project-wide macro
 * has the same name; statement macros that structurally damage tree-sitter's
 * AST still receive the offset-preserving fallback transform.
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

describe('C/C++ adaptive macro recovery', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not rewrite a healthy constant that collides with a project macro', () => {
    const source = 'const VOS_UINT32 CDEV_EXT_BRD_SLOTNO_MIN = 4;\n';
    const macroNames = new Set(['CDEV_EXT_BRD_SLOTNO_MIN']);

    for (const bodylessMacroNames of [new Set<string>(), macroNames]) {
      const result = extractFromSource(
        'constant.h',
        source,
        'c',
        undefined,
        macroNames,
        bodylessMacroNames,
      );
      expect(result.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'constant',
          name: 'CDEV_EXT_BRD_SLOTNO_MIN',
        }),
      ]));
    }
  });

  it('does not rewrite a healthy function-like macro type declaration', () => {
    const result = extractFromSource(
      'macro_type.h',
      'MACRO_TYPE(int) global_value;\n',
      'c',
      undefined,
      new Set(['MACRO_TYPE']),
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'variable', name: 'global_value' }),
    ]));
  });

  it('uses the same raw-first protection for healthy C++ declarations', () => {
    const result = extractFromSource(
      'constant.cpp',
      'constexpr int COLLIDING = 4;\n',
      'cpp',
      undefined,
      new Set(['COLLIDING']),
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'constant', name: 'COLLIDING' }),
    ]));
  });

  it('does not blank a C++ keyword from an unrelated bodyless macro during recovery', () => {
    const source = `
struct Stable {
  int inspect() const {
    SWITCH(value)
    after_switch();
    return 1;
  }
};
`;
    const result = extractFromSource(
      'keyword_collision.hpp',
      source,
      'cpp',
      undefined,
      new Set(['SWITCH', 'const']),
      new Set(['const']),
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', name: 'Stable' }),
      expect.objectContaining({
        kind: 'method',
        name: 'inspect',
        signature: expect.stringContaining('const'),
      }),
    ]));
  });

  it('rejects a cleaner recovery tree that erases a named type definition', () => {
    const source = `
struct Stable {
  BAD()
  int value;
};
`;
    const result = extractFromSource(
      'type_anchor_collision.hpp',
      source,
      'cpp',
      undefined,
      new Set(['BAD', 'Stable']),
      new Set(['Stable']),
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', name: 'Stable' }),
      expect.objectContaining({ kind: 'field', name: 'value' }),
    ]));
    expect(result.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', name: '<anonymous>' }),
    ]));
  });

  it('recovers a silent statement-macro misparse with no ERROR node', () => {
    const source = `
void handle(void) {
  SWITCH(value)
  after_switch();
}
`;
    const result = extractFromSource(
      'control_macro.c',
      source,
      'c',
      undefined,
      new Set(['SWITCH']),
    );
    const fn = result.nodes.find((node) => node.kind === 'function' && node.name === 'handle');
    expect(fn).toBeDefined();
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromNodeId: fn!.id,
        referenceKind: 'calls',
        referenceName: 'after_switch',
      }),
    ]));
  });

  it('limits recovery to the damaged function and preserves healthy declarations outside it', () => {
    const source = `
const VOS_UINT32 CDEV_EXT_BRD_SLOTNO_MIN = 4;
void handle(void) {
  SWITCH(value)
  after_switch();
}
`;
    const result = extractFromSource(
      'mixed.c',
      source,
      'c',
      undefined,
      new Set(['CDEV_EXT_BRD_SLOTNO_MIN', 'SWITCH']),
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'constant', name: 'CDEV_EXT_BRD_SLOTNO_MIN' }),
      expect.objectContaining({ kind: 'function', name: 'handle' }),
    ]));
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'after_switch' }),
    ]));
  });

  it('preserves the constant after a full project-wide macro scan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-adaptive-macro-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'macros.h'), [
      '#define CDEV_EXT_BRD_SLOTNO_MIN 4',
      '#define SWITCH(value) switch (value) {',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'symbols.c'), `
const VOS_UINT32 CDEV_EXT_BRD_SLOTNO_MIN = 4;
void handle(void) {
  SWITCH(value)
  after_switch();
}
`);

    const graph = await CodeGraph.init(dir, { silent: true });
    try {
      await graph.indexAll();
      expect(graph.getNodesByName('CDEV_EXT_BRD_SLOTNO_MIN')).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'constant', name: 'CDEV_EXT_BRD_SLOTNO_MIN' }),
      ]));
      expect(graph.getNodesByName('handle')).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'function', name: 'handle' }),
      ]));
    } finally {
      graph.close();
    }
  }, 30_000);
});
