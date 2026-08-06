/**
 * Regression coverage for a typedef enum preceded by an unresolved statement
 * wrapper macro. tree-sitter keeps the enum body intact but splits `typedef`
 * into a separate broken declaration; the extractor must reconnect the two
 * declarations instead of treating the enum alias as a variable.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

const MEMBER_NAMES = [
  'SEEMSRV_HASHTABLE_SWITCH',
  'SEEMSRV_FLOW_SWITCH',
  'SEEMSRV_PERFORMANCE_TRACE_SWITCH',
  'SEEMSRV_AWARENESS_DBG_SWITCH',
  'SEEMSRV_PORTRAIT_DBG_SWITCH',
  'SEEMSRV_MSG_DBG_SWITCH',
  'SEEMSRV_CORE_MNT_SWITCH',
  'SEEMSRV_BASIS_INFO_SWITCH',
  'SEEMSRV_SP_MEASRST_RPT_DBG_SWITCH',
  'SEEMSRV_SP_MSG_PROC_DBG_SWITCH',
  'SEEMSRV_SP_GET_MEAS_DBG_SWITCH',
  'SEEMSRV_SP_TCP_UPD_DBG_SWITCH',
  'SEEMSRV_SP_TCP_PKT_DBG_SWITCH',
  'SEEMSRV_BRD_CAPACITY_DBG_SWITCH',
  'SEEMSRV_PORTRAIT_BURST_INFO_SWITCH',
  'SEEMSRV_AWARENESS_TRACE_SW',
  'SEEMSRV_EXPT_ANALYSIS_SWITCH',
  'SEEMSRV_AWARENESS_CROSSSITE',
  'SEEMSRV_NQI_REPORTER_SW',
  'SEEMSRV_REFINE_AWARENESS_DBG_SWITCH',
  'SEEMSRV_JSF_SEND_PKT_DBG_SWITCH',
  'SEEMSRV_FIVETUPLE_TRUNC_DBG_SWITCH',
  'SEEMSRV_FIVETUPLE_AGE_STUDY_DBG_SWITCH',
  'SEEMSRV_DEBUG_SWITCH_BUTT',
];

const SOURCE = `#ifndef SEEMSRV_DEBUG_H
#define SEEMSRV_DEBUG_H
#include "rre_define.h"
EXTERN_STDC_BEGIN

typedef enum {
    ${MEMBER_NAMES[0]} = 0,
${MEMBER_NAMES.slice(1).map((name) => `    ${name},`).join('\n')}
} SeemSrvFeatureDebugSwitch;

typedef struct {
    VOS_UINT64 lastLogTick;
    VOS_UINT64 logFilterCounter;
} SEEMSRV_LOG_FILTER;
EXTERN_STDC_END
#endif /* SEEMSRV_DEBUG_H */
`;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('C typedef enum after an unresolved wrapper macro', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers the enum alias and all members from the intact enum_specifier', () => {
    const result = extractFromSource('test.h', SOURCE, 'c');
    const enumNames = result.nodes
      .filter((node) => node.kind === 'enum')
      .map((node) => node.name);
    const memberNames = result.nodes
      .filter((node) => node.kind === 'enum_member')
      .map((node) => node.name);
    const variableNames = result.nodes
      .filter((node) => node.kind === 'variable')
      .map((node) => node.name);

    expect(enumNames).toContain('SeemSrvFeatureDebugSwitch');
    expect(memberNames).toEqual(MEMBER_NAMES);
    expect(variableNames).not.toContain('typedef');
    expect(variableNames).not.toContain('SeemSrvFeatureDebugSwitch');
  });

  it('keeps both reported members queryable after full indexing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-wrapper-enum-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'test.h'), SOURCE);

    const graph = await CodeGraph.init(dir, { silent: true });
    try {
      await graph.indexAll();

      expect(graph.getNodesByName('SeemSrvFeatureDebugSwitch'))
        .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'enum' })]));
      expect(graph.getNodesByName('SEEMSRV_EXPT_ANALYSIS_SWITCH'))
        .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'enum_member' })]));
      expect(graph.getNodesByName('SEEMSRV_FIVETUPLE_AGE_STUDY_DBG_SWITCH'))
        .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'enum_member' })]));
    } finally {
      graph.close();
    }
  }, 30_000);

  it('does not reclassify a legal anonymous-enum variable without the broken typedef prefix', () => {
    const result = extractFromSource('ordinary.h', 'enum { ORDINARY_VALUE } ordinaryVariable;\n', 'c');

    expect(result.nodes.some(
      (node) => node.kind === 'enum' && node.name === 'ordinaryVariable',
    )).toBe(false);
    expect(result.nodes.some(
      (node) => node.kind === 'variable' && node.name === 'ordinaryVariable',
    )).toBe(true);
  });
});
