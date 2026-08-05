import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

function rawDb(cg: CodeGraph): any {
  const handle = (cg as any).db?.db;
  if (handle && typeof handle.prepare === 'function') return handle;
  throw new Error('raw DB handle not accessible');
}

function hasCall(cg: CodeGraph, callerName: string, targetName: string): boolean {
  const caller = cg
    .getNodesByName(callerName)
    .find((node) => node.kind === 'function');
  const target = cg
    .getNodesByName(targetName)
    .find((node) => node.kind === 'function');
  if (!caller || !target) return false;
  return cg
    .getOutgoingEdges(caller.id)
    .some((edge) => edge.kind === 'calls' && edge.target === target.id);
}

describe('C/C++ sync cross-file reference recovery', () => {
  let directory: string;
  let cg: CodeGraph | null;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sync-ref-recovery-'));
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

  it('retries a call in an unchanged C file when another file adds the symbol', async () => {
    fs.writeFileSync(
      path.join(directory, 'caller.c'),
      'int caller(void) { return late_api(); }\n'
    );
    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int existing_api(void) { return 1; }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();

    expect(hasCall(cg, 'caller', 'late_api')).toBe(false);
    const failedBefore = rawDb(cg)
      .prepare(
        "SELECT status, name_tail FROM unresolved_refs WHERE reference_name = 'late_api'"
      )
      .get() as { status: string; name_tail: string } | undefined;
    expect(failedBefore).toEqual({ status: 'failed', name_tail: 'late_api' });

    const callerIndexedAt = cg.getFile('caller.c')!.indexedAt;
    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int existing_api(void) { return 1; }\nint late_api(void) { return 2; }\n'
    );

    const result = await cg.sync();

    expect(result.filesModified).toBe(1);
    expect(hasCall(cg, 'caller', 'late_api')).toBe(true);
    expect(cg.getFile('caller.c')!.indexedAt).toBe(callerIndexedAt);
    expect(
      rawDb(cg)
        .prepare("SELECT COUNT(*) AS count FROM unresolved_refs WHERE reference_name = 'late_api'")
        .get().count
    ).toBe(0);
  });

  it('parks a dropped C target and heals the unchanged caller when it returns', async () => {
    fs.writeFileSync(
      path.join(directory, 'caller.c'),
      'int caller(void) { return recoverable_api(); }\n'
    );
    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int recoverable_api(void) { return 7; }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(hasCall(cg, 'caller', 'recoverable_api')).toBe(true);
    const callerIndexedAt = cg.getFile('caller.c')!.indexedAt;

    fs.unlinkSync(path.join(directory, 'provider.c'));
    const removal = await cg.sync();

    expect(removal.filesRemoved).toBe(1);
    expect(cg.getNodesByName('recoverable_api')).toHaveLength(0);
    const parked = rawDb(cg)
      .prepare(
        "SELECT status, name_tail FROM unresolved_refs WHERE reference_name = 'recoverable_api'"
      )
      .get() as { status: string; name_tail: string } | undefined;
    expect(parked).toEqual({ status: 'failed', name_tail: 'recoverable_api' });
    expect(cg.getFile('caller.c')!.indexedAt).toBe(callerIndexedAt);

    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int recoverable_api(void) { return 9; }\n'
    );
    const addition = await cg.sync();

    expect(addition.filesAdded).toBe(1);
    expect(hasCall(cg, 'caller', 'recoverable_api')).toBe(true);
    expect(cg.getFile('caller.c')!.indexedAt).toBe(callerIndexedAt);
  });

  it('matches the final segment of a qualified C++ reference', async () => {
    fs.writeFileSync(
      path.join(directory, 'caller.cpp'),
      'int caller() { return ns::late_cpp(); }\n'
    );
    fs.writeFileSync(
      path.join(directory, 'provider.cpp'),
      'namespace ns { int existing_cpp() { return 1; } }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();

    const parked = rawDb(cg)
      .prepare(
        "SELECT status, name_tail FROM unresolved_refs WHERE reference_name LIKE '%late_cpp'"
      )
      .get() as { status: string; name_tail: string } | undefined;
    expect(parked).toEqual({ status: 'failed', name_tail: 'late_cpp' });

    fs.writeFileSync(
      path.join(directory, 'provider.cpp'),
      'namespace ns { int existing_cpp() { return 1; } int late_cpp() { return 2; } }\n'
    );
    await cg.sync();

    expect(hasCall(cg, 'caller', 'late_cpp')).toBe(true);
  });
});
