import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { QueryBuilder } from '../src/db/queries';
import * as memoryBudget from '../src/resolution/memory-budget';
import { registerFrameworkResolver } from '../src/resolution/frameworks';
import { buildNodeView } from '../src/cli/node-view';

/**
 * End-to-end test for the C declaration-definition pairing synthesizer
 * (`cDeclDefEdges`). A C function's prototype (in a .h header) and its
 * definition (in a .c file) are extracted as two separate nodes with no edge
 * between them — the declaration has callers but no callees, the definition
 * has callees but no callers. The synthesizer bridges them with a `defines`
 * edge (definition → declaration), strictly gated to cases where the
 * declaration is in a .h header file.
 */
describe('c-decl-def synthesizer', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c-decldef-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Helper: query all `defines` edges with joined node attrs. */
  const definesEdges = (db: any) =>
    db
      .prepare(
        `SELECT s.name src_name, s.qualified_name src_qn, s.kind src_kind,
                s.file_path src_path, s.start_line src_line, s.end_line src_endline,
                s.is_declaration src_isdecl,
                t.name tgt_name, t.qualified_name tgt_qn, t.kind tgt_kind,
                t.file_path tgt_path, t.start_line tgt_line,
                t.is_declaration tgt_isdecl,
                e.provenance, json_extract(e.metadata,'$.synthesizedBy') synthBy,
                json_extract(e.metadata,'$.registeredAt') registeredAt
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'defines'`
      )
      .all() as any[];

  it('pairs a .c definition with its .h declaration', async () => {
    fs.writeFileSync(
      path.join(dir, 'foo.h'),
      `#pragma once
int add(int a, int b);
`
    );
    fs.writeFileSync(
      path.join(dir, 'foo.c'),
      `#include "foo.h"
int add(int a, int b) {
  return a + b;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    const result = await cg.indexAll();
    expect(result.success).toBe(true);
    expect(result.complete).toBe(true);
    expect(cg.getIndexCompleteness()).toEqual({ status: 'complete', diagnostics: [] });
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    const definitionView = await buildNodeView(cg, { symbol: 'add', file: 'foo.c' });
    const declarationView = await buildNodeView(cg, { symbol: 'add', file: 'foo.h' });
    cg.close?.();

    expect(edges.length).toBe(1);

    const edge = edges[0]!;
    // Direction: definition (multi-line, .c) → declaration (single-line, .h).
    expect(edge.src_name).toBe('add');
    expect(edge.src_path.endsWith('foo.c')).toBe(true);
    expect(edge.src_endline).toBeGreaterThan(edge.src_line); // has body
    expect(edge.tgt_path.endsWith('foo.h')).toBe(true);
    expect(edge.tgt_line).toBe(2);
    expect(edge.synthBy).toBe('c-decl-def');
    expect(edge.provenance).toBe('heuristic');
    expect(edge.registeredAt).toMatch(/foo\.h:\d+/);

    // CLI JSON declaration/definition pointers expose both range bounds, just
    // like the primary node payload.
    expect((definitionView.json as any).match.declDef.declarations[0]).toMatchObject({
      filePath: 'foo.h',
      startLine: 2,
      endLine: 2,
    });
    expect((declarationView.json as any).match.declDef.definitions[0]).toMatchObject({
      filePath: 'foo.c',
      startLine: 2,
      endLine: 4,
    });
  });

  it('skips language-specific whole-graph passes on a pure C project', async () => {
    fs.writeFileSync(path.join(dir, 'only.c'), 'int answer(void) { return 42; }\n');

    // A pure C index must gate the Kotlin expect/actual pass before it even
    // opens that pass's (now streamed) node cursor.
    const kotlinNodes = vi.spyOn(
      QueryBuilder.prototype,
      'iterateNodesByLanguageWithDecorator'
    );
    const cg = await CodeGraph.init(dir, { silent: true });
    try {
      await cg.indexAll();
      expect(kotlinNodes).not.toHaveBeenCalled();
    } finally {
      cg.close?.();
      kotlinNodes.mockRestore();
    }
  });

  it('reports incomplete coverage when synthesis is explicitly disabled', async () => {
    fs.writeFileSync(path.join(dir, 'safe.h'), 'int safe_api(void);\n');
    fs.writeFileSync(path.join(dir, 'safe.c'), 'int safe_api(void) { return 1; }\n');

    const previous = process.env.CODEGRAPH_NO_SYNTHESIS;
    process.env.CODEGRAPH_NO_SYNTHESIS = '1';
    let cg: CodeGraph | undefined;
    try {
      cg = await CodeGraph.init(dir, { silent: true });
      const phases: string[] = [];
      const result = await cg.indexAll({ onProgress: (progress) => phases.push(progress.phase) });
      expect(result.nodesCreated).toBeGreaterThan(0);
      expect(phases).toContain('synthesizing');
      expect(result.success).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          severity: 'warning',
          code: 'synthesis_disabled',
        })
      );
      expect(cg.getIndexCompleteness()).toMatchObject({
        status: 'incomplete',
        diagnostics: [expect.objectContaining({ code: 'synthesis_disabled' })],
      });
      const db = (cg as any).db.db;
      expect(definesEdges(db).filter((edge) => edge.src_name === 'safe_api')).toEqual([]);
    } finally {
      cg?.close?.();
      if (previous === undefined) delete process.env.CODEGRAPH_NO_SYNTHESIS;
      else process.env.CODEGRAPH_NO_SYNTHESIS = previous;
    }
  });

  it('allows SDK init to return a usable incomplete index when synthesis is explicitly disabled', async () => {
    fs.writeFileSync(path.join(dir, 'sdk.c'), 'int sdk_api(void) { return 1; }\n');

    const previous = process.env.CODEGRAPH_NO_SYNTHESIS;
    process.env.CODEGRAPH_NO_SYNTHESIS = '1';
    let cg: CodeGraph | undefined;
    try {
      cg = await CodeGraph.init(dir, { index: true });
      expect(cg.getIndexCompleteness()).toMatchObject({
        status: 'incomplete',
        diagnostics: [expect.objectContaining({ code: 'synthesis_disabled' })],
      });
      expect(cg.getStats().nodeCount).toBeGreaterThan(0);
    } finally {
      cg?.close?.();
      if (previous === undefined) delete process.env.CODEGRAPH_NO_SYNTHESIS;
      else process.env.CODEGRAPH_NO_SYNTHESIS = previous;
    }
  });

  it('keeps the base index usable when synthesis is skipped for memory safety', async () => {
    fs.writeFileSync(path.join(dir, 'memory.c'), 'int memory_api(void) { return 1; }\n');

    const budget = vi.spyOn(memoryBudget, 'memoryBudgetBytes').mockReturnValue(0);
    const cg = await CodeGraph.init(dir);
    try {
      const result = await cg.indexAll();
      expect(result.success).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          code: 'synthesis_skipped_memory',
        })
      );
      expect(cg.getStats().nodeCount).toBeGreaterThan(0);
      expect(cg.getIndexCompleteness()).toMatchObject({
        status: 'incomplete',
        diagnostics: [expect.objectContaining({ code: 'synthesis_skipped_memory' })],
      });
    } finally {
      cg.close?.();
      budget.mockRestore();
    }
  });

  it('returns a usable incomplete result when a synthesis pass fails', async () => {
    fs.writeFileSync(path.join(dir, 'broken.h'), 'int broken_api(void);\n');
    fs.writeFileSync(path.join(dir, 'broken.c'), 'int broken_api(void) { return 1; }\n');

    const stage = vi
      .spyOn(QueryBuilder.prototype, 'stageSynthesisEdges')
      .mockImplementation(() => {
        throw new Error('injected synthesis failure');
      });
    const cg = await CodeGraph.init(dir, { silent: true });
    try {
      const result = await cg.indexAll();
      expect(result.success).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          code: 'synthesis_pass_failed',
          message: expect.stringContaining('injected synthesis failure'),
        })
      );
      expect(cg.getIndexCompleteness()).toMatchObject({
        status: 'incomplete',
        diagnostics: [expect.objectContaining({ code: 'synthesis_pass_failed' })],
      });
    } finally {
      cg.close?.();
      stage.mockRestore();
    }
  });

  it('keeps the base index usable when optional framework detection fails', async () => {
    fs.writeFileSync(path.join(dir, 'framework.c'), 'int framework_api(void) { return 1; }\n');

    const resolverName = 'test-c-detection-failure';
    registerFrameworkResolver({
      name: resolverName,
      languages: ['c'],
      detect: () => {
        throw new Error('injected framework detection failure');
      },
      resolve: () => null,
    });

    let cg: CodeGraph | undefined;
    try {
      cg = await CodeGraph.init(dir);
      const result = await cg.indexAll();
      expect(result.success).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          code: 'framework_detection_failed',
          message: expect.stringContaining('injected framework detection failure'),
        })
      );
      expect(cg.getStats().nodeCount).toBeGreaterThan(0);
    } finally {
      cg?.close?.();
      // Keep the global registry harmless for later tests in this worker.
      registerFrameworkResolver({
        name: resolverName,
        languages: ['c'],
        detect: () => false,
        resolve: () => null,
      });
    }
  });

  it('keeps the base index usable when optional framework post-processing fails', async () => {
    fs.writeFileSync(path.join(dir, 'post-extract.c'), 'int post_extract_api(void) { return 1; }\n');

    const resolverName = 'test-c-post-extract-failure';
    registerFrameworkResolver({
      name: resolverName,
      languages: ['c'],
      detect: () => true,
      resolve: () => null,
      postExtract: () => {
        throw new Error('injected framework postExtract failure');
      },
    });

    let cg: CodeGraph | undefined;
    try {
      cg = await CodeGraph.init(dir);
      const result = await cg.indexAll();
      expect(result.success).toBe(true);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          code: 'framework_post_extract_failed',
          message: expect.stringContaining('injected framework postExtract failure'),
        })
      );
      expect(cg.getStats().nodeCount).toBeGreaterThan(0);
    } finally {
      cg?.close?.();
      registerFrameworkResolver({
        name: resolverName,
        languages: ['c'],
        detect: () => false,
        resolve: () => null,
      });
    }
  });

  it('pairs a .h declaration with multiple platform .c definitions', async () => {
    fs.writeFileSync(
      path.join(dir, 'api.h'),
      `#pragma once
int compute(int x);
`
    );
    fs.writeFileSync(
      path.join(dir, 'compute_unix.c'),
      `#include "api.h"
int compute(int x) {
  return x * 2;
}
`
    );
    fs.writeFileSync(
      path.join(dir, 'compute_win.c'),
      `#include "api.h"
int compute(int x) {
  return x * 3;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    // Two definitions, one declaration → 2 edges.
    expect(edges.length).toBe(2);
    // Every edge goes from a .c definition to the .h declaration.
    for (const e of edges) {
      expect(e.src_path.endsWith('.c')).toBe(true);
      expect(e.tgt_path.endsWith('api.h')).toBe(true);
      expect(e.synthBy).toBe('c-decl-def');
    }
  });

  it('does NOT pair when there is no matching .h declaration', async () => {
    fs.writeFileSync(
      path.join(dir, 'solo.c'),
      `static int helper(int x) {
  return x + 1;
}
int run(void) {
  return helper(0);
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    expect(edges.length).toBe(0);
  });

  it('does NOT pair same-file forward declaration + definition', async () => {
    fs.writeFileSync(
      path.join(dir, 'fwd.c'),
      `int helper(int x);
int helper(int x) {
  return x + 1;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    // Cross-file check excludes same-file pairs.
    expect(edges.length).toBe(0);
  });

  it('does NOT pair when the declaration is in a .c file (not .h)', async () => {
    fs.writeFileSync(
      path.join(dir, 'decl.c'),
      `int compute(int x);
`
    );
    fs.writeFileSync(
      path.join(dir, 'impl.c'),
      `int compute(int x) {
  return x * 2;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    // Strict mode: declaration must be in a .h file.
    expect(edges.length).toBe(0);
  });

  it('does NOT pollute the call graph — defines edges are invisible to getCallers/getCallees', async () => {
    fs.writeFileSync(
      path.join(dir, 'call.h'),
      `#pragma once
void outer(void);
void inner(void);
`
    );
    fs.writeFileSync(
      path.join(dir, 'call.c'),
      `#include "call.h"
void outer(void) {
  inner();
}
void inner(void) {
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // Find the declaration node for outer (single-line, in .h).
    const declRow = db
      .prepare(
        `SELECT id FROM nodes WHERE name = 'outer' AND file_path LIKE '%call.h%'`
      )
      .get() as any;
    expect(declRow).toBeTruthy();

    // The declaration node must have zero callers/callees via call-graph edges.
    const declCallees = cg.getCallees(declRow.id);
    const declCallers = cg.getCallers(declRow.id);
    expect(declCallees.length).toBe(0);
    expect(declCallers.length).toBe(0);

    // The definition node's callees must contain inner (the real call), and
    // must NOT contain the declaration node.
    const defRow = db
      .prepare(
        `SELECT id FROM nodes WHERE name = 'outer' AND file_path LIKE '%call.c%'`
      )
      .get() as any;
    const defCallees = cg.getCallees(defRow.id);
    expect(defCallees.some((c) => c.node.name === 'inner')).toBe(true);
    expect(defCallees.some((c) => c.node.id === declRow.id)).toBe(false);

    // But defines edges DO exist.
    const edges = definesEdges(db);
    expect(edges.some((e) => e.src_name === 'outer')).toBe(true);
    cg.close?.();
  });

  it('surfaces the definition call trail on a dead-end declaration node via formatDeclDef', async () => {
    fs.writeFileSync(
      path.join(dir, 'trail.h'),
      `#pragma once
void start(void);
void finish(void);
`
    );
    fs.writeFileSync(
      path.join(dir, 'trail.c'),
      `#include "trail.h"
void start(void) {
  finish();
}
void finish(void) {
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // The declaration node for start has no callees of its own.
    // But via the defines edge it should reach the definition's call trail.
    const declRow = db
      .prepare(
        `SELECT id FROM nodes WHERE name = 'start' AND file_path LIKE '%trail.h%'`
      )
      .get() as any;
    expect(declRow).toBeTruthy();

    // Verify the structural precondition: the declaration has an incoming
    // defines edge whose source (the definition) has callees.
    const defEdge = db
      .prepare(
        `SELECT e.source FROM edges e WHERE e.kind = 'defines' AND e.target = ?`
      )
      .get(declRow.id) as any;
    expect(defEdge).toBeTruthy();

    const defCallees = cg.getCallees(defEdge.source);
    expect(defCallees.some((c) => c.node.name === 'finish')).toBe(true);
    cg.close?.();
  });

  it('pairs multiple .h declarations with one .c definition', async () => {
    fs.writeFileSync(
      path.join(dir, 'pub.h'),
      `#pragma once
int compute(int x);
`
    );
    fs.writeFileSync(
      path.join(dir, 'pub2.h'),
      `#pragma once
int compute(int x);
`
    );
    fs.writeFileSync(
      path.join(dir, 'compute.c'),
      `#include "pub.h"
int compute(int x) {
  return x * 2;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    // One definition, two declarations (in different .h files) → 2 edges.
    const computeEdges = edges.filter((e) => e.src_name === 'compute');
    expect(computeEdges.length).toBe(2);
    // Every edge goes from .c definition to a .h declaration.
    expect(computeEdges.every((e) => e.src_path.endsWith('.c') && e.tgt_path.endsWith('.h'))).toBe(true);
  });

  it('pairs a multi-line .h declaration with its .c definition (isDeclaration flag, not endLine heuristic)', async () => {
    // Prototype spans 3 lines — the old endLine>startLine heuristic
    // misclassified this as a definition and skipped pairing. With the
    // isDeclaration flag set at extraction time, the prototype is correctly
    // recognized as a declaration regardless of how many lines it spans.
    fs.writeFileSync(
      path.join(dir, 'multi.h'),
      `#pragma once
void draw(
    int x,
    int y);
`
    );
    fs.writeFileSync(
      path.join(dir, 'multi.c'),
      `#include "multi.h"
void draw(int x, int y) {
  plot(x, y);
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    const drawEdges = edges.filter((e) => e.src_name === 'draw' || e.tgt_name === 'draw');
    expect(drawEdges.length).toBe(1);

    const edge = drawEdges[0]!;
    // Definition (.c, has body) → declaration (.h, multi-line prototype).
    expect(edge.src_path.endsWith('multi.c')).toBe(true);
    expect(edge.tgt_path.endsWith('multi.h')).toBe(true);
    // The isDeclaration flag must be populated: 0 on the definition source,
    // 1 on the prototype target. This is what distinguishes them without
    // relying on the buggy line-count heuristic.
    expect(edge.src_isdecl).toBe(0);
    expect(edge.tgt_isdecl).toBe(1);
    expect(edge.synthBy).toBe('c-decl-def');
  });

  it('pairs a .h declaration with stacked attribute macros and a trailing macro call', async () => {
    // Stacked attribute macros before the return type (`SAFE VOS_VOID* OWNED
    // NULLABLE`) plus a trailing macro call after the parameter list
    // (`CALLEE_RET_ALIGN()`) break tree-sitter-c's declaration parse: the `*`
    // is misread as a dereference expression, the type split into a spurious
    // declaration + expression_statement, and the function_declarator lands in
    // an ERROR recovery node. The ERROR-node rescue in the body walker routes
    // it through extractVariable, which detects the function_declarator and
    // creates a declaration node — enabling cDeclDefEdges to pair it with the
    // .c definition.
    fs.writeFileSync(
      path.join(dir, 'attr.h'),
      `#pragma once
SAFE VOS_VOID* OWNED NULLABLE TlmDynamicMemAlloc(VOS_UINT32 dwPid, VOS_UINT32 dwSize) CALLEE_RET_ALIGN();
`
    );
    fs.writeFileSync(
      path.join(dir, 'attr.c'),
      `#include "attr.h"
RRE_ATTRIBUTE_VISIBILITY VOS_VOID *TlmDynamicMemAlloc(VOS_UINT32 dwPid, VOS_UINT32 dwSize) {
  return 0;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    const tlmEdges = edges.filter(
      (e) => e.src_name === 'TlmDynamicMemAlloc' || e.tgt_name === 'TlmDynamicMemAlloc'
    );
    expect(tlmEdges.length).toBe(1);

    const edge = tlmEdges[0]!;
    expect(edge.src_path.endsWith('attr.c')).toBe(true);
    expect(edge.tgt_path.endsWith('attr.h')).toBe(true);
    expect(edge.src_isdecl).toBe(0);
    expect(edge.tgt_isdecl).toBe(1);
    expect(edge.synthBy).toBe('c-decl-def');
  });

  it('pairs a .h declaration where the ERROR is nested inside a declaration node', async () => {
    // With fewer leading attribute macros (so tree-sitter-c does not split
    // the type into a spurious declaration + expression_statement), the
    // function_declarator lands in an ERROR that is itself nested inside a
    // declaration node. The declaration dispatch normally sets skipChildren,
    // which would prevent the body walker from reaching the ERROR. The fix
    // detects ERROR children with function_declarator descendants and keeps
    // walking so the ERROR-node rescue can extract the prototype.
    fs.writeFileSync(
      path.join(dir, 'nest.h'),
      `#pragma once
EXTERN VOS_VOID TlmFree(VOS_VOID *p) CALLEE_RET_ALIGN();
`
    );
    fs.writeFileSync(
      path.join(dir, 'nest.c'),
      `#include "nest.h"
VOS_VOID TlmFree(VOS_VOID *p) {
  return;
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    const freeEdges = edges.filter(
      (e) => e.src_name === 'TlmFree' || e.tgt_name === 'TlmFree'
    );
    expect(freeEdges.length).toBe(1);

    const edge = freeEdges[0]!;
    expect(edge.src_path.endsWith('nest.c')).toBe(true);
    expect(edge.tgt_path.endsWith('nest.h')).toBe(true);
    expect(edge.src_isdecl).toBe(0);
    expect(edge.tgt_isdecl).toBe(1);
    expect(edge.synthBy).toBe('c-decl-def');
  });
});

describe('cpp-decl-def synthesizer', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpp-decldef-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Helper: query all `defines` edges with joined node attrs. */
  const definesEdges = (db: any) =>
    db
      .prepare(
        `SELECT s.name src_name, s.qualified_name src_qn, s.kind src_kind,
                s.file_path src_path, s.start_line src_line, s.end_line src_endline,
                s.is_declaration src_isdecl,
                t.name tgt_name, t.qualified_name tgt_qn, t.kind tgt_kind,
                t.file_path tgt_path, t.start_line tgt_line, s.end_line tgt_endline,
                t.is_declaration tgt_isdecl,
                e.provenance, json_extract(e.metadata,'$.synthesizedBy') synthBy,
                json_extract(e.metadata,'$.registeredAt') registeredAt
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'defines'`
      )
      .all() as any[];

  it('pairs a C++ multi-line class member declaration with its .cpp definition (isDeclaration flag, not endLine heuristic)', async () => {
    // The class member declaration wraps its parameter list across 4 lines.
    // The old endLine>startLine heuristic misclassified this multi-line
    // declaration as a definition (it spans more than one line), so it was
    // never paired with the .cpp definition. With the isDeclaration flag set
    // at extraction time (field_declaration + function_declarator), the
    // declaration is recognized regardless of line span.
    fs.writeFileSync(
      path.join(dir, 'shape.h'),
      `#pragma once
class Shape {
public:
  void resize(
      int w,
      int h);
};
`
    );
    fs.writeFileSync(
      path.join(dir, 'shape.cpp'),
      `#include "shape.h"
void Shape::resize(int w, int h) {
  // body
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
    cg.close?.();

    const resizeEdges = edges.filter(
      (e) => (e.src_name === 'resize' || e.tgt_name === 'resize')
    );
    expect(resizeEdges.length).toBe(1);

    const edge = resizeEdges[0]!;
    // Definition (.cpp, has body) → declaration (.h, multi-line, in class).
    expect(edge.src_path.endsWith('shape.cpp')).toBe(true);
    expect(edge.tgt_path.endsWith('shape.h')).toBe(true);
    // The isDeclaration flag must be populated: 0 on the definition source,
    // 1 on the in-class declaration target. This is what distinguishes them
    // without relying on the buggy line-count heuristic.
    expect(edge.src_isdecl).toBe(0);
    expect(edge.tgt_isdecl).toBe(1);
    expect(edge.synthBy).toBe('cpp-decl-def');
    expect(edge.provenance).toBe('heuristic');
    expect(edge.registeredAt).toMatch(/shape\.h:\d+/);
  });
});

describe('c-cpp-var-decl-def synthesizer (extern variable declarations)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'var-decldef-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const definesEdges = (db: any) =>
    db
      .prepare(
        `SELECT s.name src_name, s.kind src_kind, s.file_path src_path,
                s.is_declaration src_isdecl,
                t.name tgt_name, t.kind tgt_kind, t.file_path tgt_path,
                t.is_declaration tgt_isdecl,
                e.provenance, json_extract(e.metadata,'$.synthesizedBy') synthBy
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'defines'`
      )
      .all() as any[];

  it('keeps the extern declaration AND the definition, bridged by a defines edge (user-reported regression)', async () => {
    // Reproduces the reported case: a header with only an `extern` declaration
    // of a TLV table. Previously the `extern` variable declaration was skipped
    // unconditionally, so when the definition lived in a file that wasn't
    // indexed (or whose parse was broken), the symbol vanished entirely. Now
    // the declaration is kept as a node (isDeclaration=true) and bridged to the
    // definition with a `defines` edge.
    fs.writeFileSync(
      path.join(dir, 'tlv.h'),
      `typedef struct { int a; int b; } CBB_MSGCDC_TLV_TABLE_STRU;
extern const CBB_MSGCDC_TLV_TABLE_STRU g_netm_astSrioTopoEsnRspTlvTbl[];
`
    );
    fs.writeFileSync(
      path.join(dir, 'tlv.c'),
      `#include "tlv.h"
const CBB_MSGCDC_TLV_TABLE_STRU g_netm_astSrioTopoEsnRspTlvTbl[] = {
  { 0, 0 },
  { 1, 1 }
};
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    // The symbol must now be findable from the header alone — the regression fix.
    const found = await cg.searchNodes('g_netm_astSrioTopoEsnRspTlvTbl');
    const nodes = found.map((r) => r.node);
    const decl = nodes.find((n) => n.filePath.endsWith('tlv.h'));
    const def = nodes.find((n) => n.filePath.endsWith('tlv.c'));
    expect(decl).toBeDefined();
    expect(def).toBeDefined();
    expect(decl!.isDeclaration).toBe(true);
    expect(def!.isDeclaration).not.toBe(true);

    const db = (cg as any).db.db;
    const edges = definesEdges(db).filter(
      (e) => e.src_name === 'g_netm_astSrioTopoEsnRspTlvTbl'
    );
    cg.close?.();

    expect(edges.length).toBe(1);
    expect(edges[0]!.src_path.endsWith('tlv.c')).toBe(true);
    expect(edges[0]!.tgt_path.endsWith('tlv.h')).toBe(true);
    expect(edges[0]!.src_isdecl).toBe(0);
    expect(edges[0]!.tgt_isdecl).toBe(1);
    expect(edges[0]!.synthBy).toBe('c-cpp-var-decl-def');
  });

  it('treats an extern declarator WITH an initializer as a definition (isDeclaration=false)', async () => {
    // `extern T g_x = ...;` is a definition in C, not a declaration. It must
    // be extracted as a definition node and NOT paired with itself.
    fs.writeFileSync(
      path.join(dir, 'init.c'),
      `typedef struct { int a; } T;
extern T g_with_init = { 1 };
T g_with_init_ref = { 2 };
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const found = await cg.searchNodes('g_with_init');
    const node = found.map((r) => r.node).find((n) => n.name === 'g_with_init');
    expect(node).toBeDefined();
    expect(node!.isDeclaration).not.toBe(true);
    cg.close?.();
  });

  it('does NOT pair when the declaration is not in a header (strict mode)', async () => {
    fs.writeFileSync(
      path.join(dir, 'decl.c'),
      `typedef struct { int a; } T;
extern T g_strict;
`
    );
    fs.writeFileSync(
      path.join(dir, 'def.c'),
      `typedef struct { int a; } T;
T g_strict = { 0 };
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db).filter((e) => e.src_name === 'g_strict');
    cg.close?.();

    // Strict mode: the declaration must be in a .h file to be paired.
    expect(edges.length).toBe(0);
  });

  it('keeps the extern declaration findable even when the definition file is absent', async () => {
    // The core regression: header-only. The definition lives in a file that
    // isn't indexed (e.g. a library .c). The `extern` declaration must still
    // produce a findable node.
    fs.writeFileSync(
      path.join(dir, 'only.h'),
      `typedef struct { int a; int b; } T;
extern const T g_only_decl[];
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const found = await cg.searchNodes('g_only_decl');
    const node = found.map((r) => r.node).find((n) => n.name === 'g_only_decl');
    expect(node).toBeDefined();
    expect(node!.isDeclaration).toBe(true);
    cg.close?.();
  });
});
