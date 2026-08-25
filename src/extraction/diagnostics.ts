import type { ExtractionError } from '../types';

/**
 * A retry recovered the primary AST but deliberately omitted declaration-macro
 * replay. The file remains queryable, while declarations produced only by
 * macros may be absent and the overall index must therefore stay incomplete.
 */
export const DECLARATION_MACRO_RECOVERY_SKIPPED_CODE =
  'declaration_macro_recovery_skipped';

export function isDeclarationMacroRecoverySkipped(
  diagnostic: Pick<ExtractionError, 'code'>,
): boolean {
  return diagnostic.code === DECLARATION_MACRO_RECOVERY_SKIPPED_CODE;
}

/** True when a persisted file record still needs a full macro-recovery retry. */
export function hasDeclarationMacroRecoverySkipped(
  diagnostics: ReadonlyArray<Pick<ExtractionError, 'code'>> | undefined,
): boolean {
  return diagnostics?.some(isDeclarationMacroRecoverySkipped) ?? false;
}

/**
 * Replace a retryable whole-file failure with the narrower coverage diagnostic
 * that is true after a base-only retry succeeds.
 */
export function replaceWithDeclarationMacroRecoverySkipped(
  errors: ExtractionError[],
  originalFailure: ExtractionError,
  filePath: string,
  commentsStripped: boolean,
): ExtractionError {
  const failureIndex = errors.indexOf(originalFailure);
  if (failureIndex >= 0) errors.splice(failureIndex, 1);

  const strippedDetail = commentsStripped
    ? ' The successful retry also omitted comment-only lines to reduce parser memory pressure.'
    : '';
  const diagnostic: ExtractionError = {
    severity: 'warning',
    code: DECLARATION_MACRO_RECOVERY_SKIPPED_CODE,
    filePath,
    message:
      `Declaration-macro recovery was skipped after a retryable parse-worker failure ` +
      `(${originalFailure.message}). Base AST symbols from this file were indexed, ` +
      `but declarations generated only by macros may be missing.${strippedDetail}`,
  };
  errors.push(diagnostic);
  return diagnostic;
}

/**
 * Diagnostics persisted by `codegraph status`. Ordinary per-file parse errors
 * are represented by the aggregate `files_not_indexed` entry, but a base-only
 * degradation must retain its file path and precise missing-coverage reason.
 */
export function collectPersistedIndexDiagnostics(
  errors: ExtractionError[],
  filesErrored: number,
): ExtractionError[] {
  return [
    ...errors.filter(
      (diagnostic) =>
        !diagnostic.filePath || isDeclarationMacroRecoverySkipped(diagnostic),
    ),
    ...(filesErrored > 0
      ? [{
          severity: 'error' as const,
          code: 'files_not_indexed',
          message: `${filesErrored} files could not be indexed.`,
        }]
      : []),
  ];
}
