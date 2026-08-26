import { describe, expect, it } from 'vitest';
import {
  buildCppMacroContext,
  cppMacroManifestFromMap,
  diffCppMacroContexts,
  parseCppMacroManifest,
  scanCppMacroFileContribution,
  serializeCppMacroManifest,
  sourceReferencesAnyCppMacro,
  type CppMacroFileContribution,
} from '../src/extraction/macro-context';

function context(files: Record<string, string>) {
  const contributions = new Map<string, CppMacroFileContribution>();
  for (const [filePath, source] of Object.entries(files)) {
    contributions.set(filePath, scanCppMacroFileContribution(source));
  }
  return buildCppMacroContext(cppMacroManifestFromMap(contributions));
}

describe('C/C++ macro context', () => {
  it('propagates a changed inner macro to transitive outer users', () => {
    const previous = context({
      'defs.h': [
        '#define INNER(Name) struct Name { int old_field; };',
        '#define OUTER(Name) INNER(Name)',
      ].join('\n'),
    });
    const current = context({
      'defs.h': [
        '#define INNER(Name) struct Name { int new_field; };',
        '#define OUTER(Name) INNER(Name)',
      ].join('\n'),
    });

    const diff = diffCppMacroContexts(previous, current);
    expect(diff.changedNames).toEqual(new Set(['INNER']));
    expect(diff.affectedNames).toEqual(new Set(['INNER', 'OUTER']));
  });

  it('propagates a newly introduced macro through an existing replacement token', () => {
    const previous = context({
      'outer.h': '#define OUTER(Name) MAYBE_DECL(Name)\n',
    });
    const current = context({
      'outer.h': '#define OUTER(Name) MAYBE_DECL(Name)\n',
      'inner.h': '#define MAYBE_DECL(Name) struct Name {};\n',
    });

    expect(diffCppMacroContexts(previous, current).affectedNames).toEqual(
      new Set(['MAYBE_DECL', 'OUTER']),
    );
  });

  it('invalidates token-pasting macros conservatively on any context change', () => {
    const previous = context({
      'defs.h': [
        '#define PASTE_DECL(Prefix, Name) struct Prefix##Name {};',
        '#define VALUE 1',
      ].join('\n'),
    });
    const current = context({
      'defs.h': [
        '#define PASTE_DECL(Prefix, Name) struct Prefix##Name {};',
        '#define VALUE 2',
      ].join('\n'),
    });

    expect(diffCppMacroContexts(previous, current).affectedNames).toEqual(
      new Set(['VALUE', 'PASTE_DECL']),
    );
  });

  it('round-trips a normalized per-file manifest', () => {
    const manifest = cppMacroManifestFromMap(new Map([
      ['defs.h', scanCppMacroFileContribution([
        '#define BODYLESS',
        '#define DECL(Name) struct Name {};',
      ].join('\n'))],
    ]));

    expect(parseCppMacroManifest(serializeCppMacroManifest(manifest))).toEqual(manifest);
    expect(parseCppMacroManifest('{"version":0}')).toBeNull();
  });

  it('matches exact identifier tokens while allowing conservative comments and strings', () => {
    const names = new Set(['DECL']);
    expect(sourceReferencesAnyCppMacro('DECL(Value)', names)).toBe(true);
    expect(sourceReferencesAnyCppMacro('DECL_SUFFIX(Value)', names)).toBe(false);
    expect(sourceReferencesAnyCppMacro('// DECL(Value)', names)).toBe(true);
  });
});
