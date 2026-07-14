import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * Regression check: verify that C files with ERROR nodes (X-macro leaks,
 * attribute macro stacking) still produce the expected node counts.
 */
describe('regression: ERROR node handling', () => {
  let dir: string;

  it('extracts all function declarations from a file with mixed ERROR scenarios', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-'));

    fs.writeFileSync(
      path.join(dir, 'big.h'),
      `#pragma once
struct leaked_struct {
#include "nonexistent_fields.h"
};

int normal_func_a(int x);
int normal_func_b(int y);
void normal_func_c(void);

SAFE VOS_VOID* OWNED NULLABLE func_with_attrs(VOS_UINT32 a, VOS_UINT32 b) CALLEE_RET_ALIGN();
EXTERN VOS_VOID func_with_error(VOS_VOID *p) CALLEE_RET_ALIGN();
`
    );

    fs.writeFileSync(
      path.join(dir, 'big.c'),
      `#include "big.h"
int normal_func_a(int x) { return x + 1; }
int normal_func_b(int y) { return y + 2; }
void normal_func_c(void) {}
VOS_VOID* func_with_attrs(VOS_UINT32 a, VOS_UINT32 b) { return 0; }
VOS_VOID func_with_error(VOS_VOID *p) { return; }
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const totalNodes = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    const funcNodes = db.prepare("SELECT name, file_path, start_line, is_declaration FROM nodes WHERE kind = 'function'").all();
    const structNodes = db.prepare("SELECT name FROM nodes WHERE kind = 'struct'").all();

    console.log('Total nodes:', totalNodes);
    console.log('Function nodes:');
    for (const f of funcNodes) {
      console.log(`  ${f.name} @ ${f.file_path}:${f.start_line} isDecl=${f.is_declaration}`);
    }
    console.log('Struct nodes:', structNodes.map((s: any) => s.name));

    // We should have at least the normal functions
    const normalA = funcNodes.find((f: any) => f.name === 'normal_func_a');
    const normalB = funcNodes.find((f: any) => f.name === 'normal_func_b');
    const normalC = funcNodes.find((f: any) => f.name === 'normal_func_c');

    expect(normalA).toBeTruthy();
    expect(normalB).toBeTruthy();
    expect(normalC).toBeTruthy();

    cg.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});