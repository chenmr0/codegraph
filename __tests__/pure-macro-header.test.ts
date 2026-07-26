/**
 * Pure-macro data header fast path (B-2).
 *
 * tree-sitter-c hangs every #define under a single preproc_ifdef guard node,
 * so a file made of hundreds of `#define X { initializer }` (no real
 * declarations) parses in O(n^2) upstream (tree-sitter-c#196 / tree-sitter#1356).
 * Such files yield no extractable symbols beyond macro names, so the C
 * extractor skips the parse and collects macro names via regex instead:
 * O(n), better recall (the broken parse only reaches the first macro before
 * the slowdown swamps it), zero regression for files with real declarations.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** Build a pure-macro data header: n object-like macros with bare `{...}` bodies. */
function genPureMacroHeader(n: number): string {
  let s = '#ifndef _SPEC_H\n#define _SPEC_H\n\n';
  for (let i = 0; i < n; i++) {
    s += `#define SPEC_${String(i).padStart(3, '0')} \\\n`;
    s += `  /* CAP_${i} */ \\\n`;
    s += `  { 0x05015000, 159244, 50000, 512, 0, 0, 0, 0, 0, 500, 750, 1000, 19000, 0, 3, 6, 9, 0, 1, 2, 4, 0, 0, 0, 0, 0, 0x10002, 0, 0, 0, 0, 0, 245760, 0, 2, 16, 4, 0, 0, 1, 1, 7, 1, 1, 0, 0, 1, 1, 0, 0, 0, 512, 512, 5120, 2, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 6, 0}, \\\n`;
  }
  // drop the trailing ", \" so the last macro actually terminates
  s = s.replace(/, \\\n$/, '\n');
  s += '\n#endif\n';
  return s;
}

describe('pure-macro data header fast path', () => {
  it('skips parse, emits every macro name, and warns', () => {
    const src = genPureMacroHeader(100);
    const r = extractFromSource('specmode.h', src, 'c');

    // Skipped path is O(n) — must be well under the O(n^2) baseline (seconds).
    expect(r.durationMs).toBeLessThan(500);

    // 100 data macros + 1 include-guard macro.
    const macros = r.nodes.filter((n) => n.kind === 'macro');
    expect(macros.length).toBe(101);
    expect(macros.some((n) => n.name === '_SPEC_H')).toBe(true);
    expect(macros.some((n) => n.name === 'SPEC_000')).toBe(true);
    expect(macros.some((n) => n.name === 'SPEC_099')).toBe(true);

    // file node + contains edges from file to every macro.
    expect(r.nodes.some((n) => n.kind === 'file')).toBe(true);
    expect(r.edges.filter((e) => e.kind === 'contains').length).toBe(101);

    // Warn surfaced so users can see the skip and force-parse if they want.
    expect(r.errors.some((e) => e.code === 'skipped_macro_data_header')).toBe(true);
  });

  it('does not skip files with real declarations (semicolons)', () => {
    const src = '#ifndef H\n#define H\nint foo(void) { return 0; }\n#endif\n';
    const r = extractFromSource('normal.h', src, 'c');

    expect(r.errors.some((e) => e.code === 'skipped_macro_data_header')).toBe(false);
    expect(r.nodes.some((n) => n.kind === 'function' && n.name === 'foo')).toBe(true);
  });

  it('does not skip files with typedef/struct/enum (type keywords)', () => {
    let src = '#ifndef H\n#define H\n\n';
    for (let i = 0; i < 100; i++) src += `#define M_${i} { 1, 2 }\n`;
    // A typedef keeps this on the normal path even though it has many #defines.
    src += 'typedef struct { int a; } S;\n#endif\n';
    const r = extractFromSource('types.h', src, 'c');

    expect(r.errors.some((e) => e.code === 'skipped_macro_data_header')).toBe(false);
  });

  it('does not skip files with function-like macros', () => {
    let src = '#ifndef H\n#define H\n\n';
    for (let i = 0; i < 100; i++) src += `#define FN_${i}(x) ((x) + ${i})\n`;
    src += '#endif\n';
    const r = extractFromSource('fnmacros.h', src, 'c');

    expect(r.errors.some((e) => e.code === 'skipped_macro_data_header')).toBe(false);
  });

  it('does not skip C++ (the pathology is C-only)', () => {
    const src = genPureMacroHeader(100);
    const r = extractFromSource('specmode.h', src, 'cpp');

    expect(r.errors.some((e) => e.code === 'skipped_macro_data_header')).toBe(false);
  });

  it('CODEGRAPH_FORCE_PARSE=1 forces the normal parse path', () => {
    const src = genPureMacroHeader(30);
    const prev = process.env.CODEGRAPH_FORCE_PARSE;
    process.env.CODEGRAPH_FORCE_PARSE = '1';
    try {
      const r = extractFromSource('force.h', src, 'c');
      expect(r.errors.some((e) => e.code === 'skipped_macro_data_header')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_FORCE_PARSE;
      else process.env.CODEGRAPH_FORCE_PARSE = prev;
    }
  });

  it('a handful of macros is not enough to trigger the skip', () => {
    // 5 macros, no declarations — still below the defineCount >= 20 threshold,
    // so this stays on the normal path (small files parse fine anyway).
    const src = genPureMacroHeader(5);
    const r = extractFromSource('small.h', src, 'c');

    expect(r.errors.some((e) => e.code === 'skipped_macro_data_header')).toBe(false);
    // Still extracts whatever the normal path would.
    expect(r.nodes.some((n) => n.kind === 'file')).toBe(true);
  });
});