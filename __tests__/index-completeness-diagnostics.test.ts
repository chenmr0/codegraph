import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { ExtractionError } from '../src/types';
import {
  DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
  collectPersistedIndexDiagnostics,
  replaceWithDeclarationMacroRecoverySkipped,
} from '../src/extraction/diagnostics';

describe('base-only index completeness diagnostics', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaces a whole-file parse failure with a precise degradation warning', () => {
    const original: ExtractionError = {
      severity: 'error',
      code: 'parse_error',
      filePath: 'src/macros.cpp',
      message: 'Parse timed out after 30000ms',
    };
    const errors = [original];

    const diagnostic = replaceWithDeclarationMacroRecoverySkipped(
      errors,
      original,
      'src/macros.cpp',
      false,
    );

    expect(errors).toEqual([diagnostic]);
    expect(diagnostic).toEqual(expect.objectContaining({
      severity: 'warning',
      code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
      filePath: 'src/macros.cpp',
      message: expect.stringContaining('Base AST symbols from this file were indexed'),
    }));
    expect(diagnostic.message).toContain('declarations generated only by macros may be missing');
  });

  it('persists the file-scoped degradation while aggregating ordinary file failures', () => {
    const original: ExtractionError = {
      severity: 'error',
      code: 'parse_error',
      filePath: 'src/macros.cpp',
      message: 'Worker exited with code 1',
    };
    const errors: ExtractionError[] = [
      original,
      {
        severity: 'error',
        code: 'read_error',
        filePath: 'src/unreadable.cpp',
        message: 'permission denied',
      },
      {
        severity: 'warning',
        code: 'synthesis_disabled',
        message: 'synthesis disabled',
      },
    ];
    replaceWithDeclarationMacroRecoverySkipped(
      errors,
      original,
      'src/macros.cpp',
      true,
    );

    const persisted = collectPersistedIndexDiagnostics(errors, 1);

    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
        filePath: 'src/macros.cpp',
        message: expect.stringContaining('omitted comment-only lines'),
      }),
      expect.objectContaining({ code: 'synthesis_disabled' }),
      expect.objectContaining({ code: 'files_not_indexed' }),
    ]));
    expect(persisted).not.toContainEqual(
      expect.objectContaining({ code: 'read_error', filePath: 'src/unreadable.cpp' })
    );
  });

  it('marks a usable base-only result incomplete and persists its file path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-base-only-'));
    tempDirs.push(dir);
    const cg = CodeGraph.initSync(dir);
    const original: ExtractionError = {
      severity: 'error',
      code: 'parse_error',
      filePath: 'src/macros.cpp',
      message: 'Parse timed out after 30000ms',
    };
    const errors = [original];
    replaceWithDeclarationMacroRecoverySkipped(
      errors,
      original,
      'src/macros.cpp',
      false,
    );

    const orchestrator = (cg as unknown as {
      orchestrator: {
        indexAll: (...args: unknown[]) => Promise<unknown>;
      };
    }).orchestrator;
    const realIndexAll = orchestrator.indexAll;
    orchestrator.indexAll = async () => ({
      success: true,
      filesIndexed: 1,
      filesSkipped: 0,
      filesErrored: 0,
      nodesCreated: 1,
      edgesCreated: 0,
      errors,
      durationMs: 1,
    });

    try {
      const result = await cg.indexAll();
      expect(result.success).toBe(true);
      expect(result.filesErrored).toBe(0);
      expect(result.complete).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({
        code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
        severity: 'warning',
      }));
      expect(cg.getIndexCompleteness()).toEqual({
        status: 'incomplete',
        diagnostics: [expect.objectContaining({
          code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
          filePath: 'src/macros.cpp',
        })],
      });
    } finally {
      orchestrator.indexAll = realIndexAll;
      cg.close();
    }
  });
});
