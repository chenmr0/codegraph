/**
 * Regression coverage for project-wide empty macro names that are suffixes of
 * unrelated identifiers. C/C++ preprocessing works on tokens: `#define IN`
 * must never alter `SYNCETH_TYPE_IN` or `NCM_RRU_CONNTYPE_PLAIN`.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

const SOURCE = `
typedef enum tagSYNCETH_TYPE_ENUM {
    SYNCETH_TYPE_IN,
    SYNCETH_TYPE_OUT,
    SYNCETH_TYPE_BUTT
} SYNCETH_TYPE_ENUM;

typedef enum {
    NCM_RRU_CONNTYPE_TLS = 0,
    NCM_RRU_CONNTYPE_PLAIN,
    NCM_RRU_CONNTYPE_TLSANDPLAIN,
    NCM_RRU_CONNTYPE_BUTT
} NCM_RRU_CONNTYPE_ENUM;

typedef enum {
    SEEMSRV_HASHTABLE_SWITCH = 0,
    SEEMSRV_DEBUG_SWITCH_BUTT
} SeemSrvFeatureDebugSwitch;

const VOS_UINT32 CDEV_EXT_BRD_SLOTNO_MIN = 4;
`;

const EXPECTED_MEMBERS = [
  'SYNCETH_TYPE_IN',
  'SYNCETH_TYPE_OUT',
  'SYNCETH_TYPE_BUTT',
  'NCM_RRU_CONNTYPE_TLS',
  'NCM_RRU_CONNTYPE_PLAIN',
  'NCM_RRU_CONNTYPE_TLSANDPLAIN',
  'NCM_RRU_CONNTYPE_BUTT',
  'SEEMSRV_HASHTABLE_SWITCH',
  'SEEMSRV_DEBUG_SWITCH_BUTT',
];

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('C macro names do not match identifier suffixes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves complete enum member names during direct extraction', () => {
    const macroNames = new Set(['SWITCH', 'OUT', 'IN']);
    const bodylessMacroNames = new Set(['OUT', 'IN']);
    const result = extractFromSource(
      'enum_suffixes.h',
      SOURCE,
      'c',
      undefined,
      macroNames,
      bodylessMacroNames,
    );

    const members = result.nodes
      .filter((node) => node.kind === 'enum_member')
      .map((node) => node.name);

    expect(members).toEqual(EXPECTED_MEMBERS);
    expect(members).not.toContain('SYNCETH_TYPE_');
    expect(members).not.toContain('NCM_RRU_CONNTYPE_PLA');
    expect(members).not.toContain('NCM_RRU_CONNTYPE_TLSANDPLA');
  });

  it('keeps exact queries working after a full project macro scan', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-macro-suffix-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'macros.h'), [
      '#define SWITCH static',
      '#define OUT',
      '#define IN',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'enum_suffixes.h'), SOURCE);

    const graph = await CodeGraph.init(dir, { silent: true });
    try {
      await graph.indexAll();

      for (const name of EXPECTED_MEMBERS) {
        expect(graph.getNodesByName(name)).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'enum_member', name }),
        ]));
      }
      expect(graph.getNodesByName('CDEV_EXT_BRD_SLOTNO_MIN')).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'constant', name: 'CDEV_EXT_BRD_SLOTNO_MIN' }),
      ]));
      expect(graph.getNodesByName('SYNCETH_TYPE_')).toHaveLength(0);
    } finally {
      graph.close();
    }
  }, 30_000);
});
