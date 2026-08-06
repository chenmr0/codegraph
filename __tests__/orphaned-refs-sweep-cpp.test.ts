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

describe('C/C++ orphaned reference sweep', () => {
  let directory: string;
  let cg: CodeGraph | null;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphan-ref-'));
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

  it('heals C call edges left pending by an interrupted resolution pass', async () => {
    const callerPath = path.join(directory, 'caller.c');
    fs.writeFileSync(
      callerPath,
      'int caller(void) { return recover_target(); }\n'
    );
    fs.writeFileSync(
      path.join(directory, 'provider.c'),
      'int recover_target(void) { return 7; }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();

    expect(hasCall(cg, 'caller', 'recover_target')).toBe(true);
    expect(cg.getPendingReferenceCount()).toBe(0);

    // Re-extract and stop before resolution. The stored content hash is now
    // current, so the next sync sees no changed file just as it would after a
    // process is killed while displaying "Resolving refs".
    fs.appendFileSync(callerPath, '\n// interrupted after extraction\n');
    const extractionOnly = await cg.indexFiles(['caller.c']);
    expect(extractionOnly.success).toBe(true);
    expect(cg.getPendingReferenceCount()).toBeGreaterThan(0);
    expect(hasCall(cg, 'caller', 'recover_target')).toBe(false);

    const healed = await cg.sync();

    expect(healed.filesAdded).toBe(0);
    expect(healed.filesModified).toBe(0);
    expect(healed.filesRemoved).toBe(0);
    expect(cg.getPendingReferenceCount()).toBe(0);
    expect(hasCall(cg, 'caller', 'recover_target')).toBe(true);

    const again = await cg.sync();
    expect(again.filesAdded + again.filesModified + again.filesRemoved).toBe(0);
    expect(cg.getPendingReferenceCount()).toBe(0);
  });

  it('parks an unresolvable C orphan instead of retrying it forever', async () => {
    const callerPath = path.join(directory, 'caller.c');
    fs.writeFileSync(
      callerPath,
      'int caller(void) { return missing_external(); }\n'
    );

    cg = CodeGraph.initSync(directory);
    await cg.indexAll();
    expect(cg.getPendingReferenceCount()).toBe(0);

    fs.appendFileSync(callerPath, '\n// interrupted after extraction\n');
    await cg.indexFiles(['caller.c']);
    expect(cg.getPendingReferenceCount()).toBeGreaterThan(0);

    const swept = await cg.sync();
    expect(swept.filesAdded + swept.filesModified + swept.filesRemoved).toBe(0);
    expect(cg.getPendingReferenceCount()).toBe(0);

    const parked = rawDb(cg)
      .prepare(
        "SELECT status, name_tail FROM unresolved_refs WHERE reference_name = 'missing_external'"
      )
      .get() as { status: string; name_tail: string } | undefined;
    expect(parked).toEqual({ status: 'failed', name_tail: 'missing_external' });

    const again = await cg.sync();
    expect(again.filesAdded + again.filesModified + again.filesRemoved).toBe(0);
    expect(cg.getPendingReferenceCount()).toBe(0);
  });
});
