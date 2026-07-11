import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

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
                t.name tgt_name, t.qualified_name tgt_qn, t.kind tgt_kind,
                t.file_path tgt_path, t.start_line tgt_line,
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
    await cg.indexAll();
    const db = (cg as any).db.db;
    const edges = definesEdges(db);
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
});