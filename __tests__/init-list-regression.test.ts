import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('preprocessStatementMacros brace depth regression', () => {
  it('does NOT replace NULL inside a brace initializer (d285edf regression)', () => {
    // NULL is a common #define. Inside a brace initializer { ... }, NULL
    // appears with parenDepth=0 and is followed by ',' (not ';' or '{').
    // preprocessStatementMacros only tracks parenDepth, not brace depth,
    // so it wrongly replaces NULL with `0;`, breaking the initializer.
    const macroNames = new Set(['NULL', 'OB_CS_COMPILED']);

    const result = extractFromSource('test.c',
      'struct Handler {\n' +
      '  void (*init)(void);\n' +
      '  void (*uninit)(void);\n' +
      '  void *extra;\n' +
      '};\n' +
      'struct Handler my_handler = {\n' +
      '  init_func,\n' +
      '  uninit_func,\n' +
      '  NULL,\n' +
      '  other_func,\n' +
      '};\n' +
      'int g_x = 1;\n',
      undefined,
      undefined,
      macroNames
    );

    const vars = result.nodes.filter(n => n.kind === 'variable');
    console.log('Variables:', vars.map(v => v.name));

    // my_handler should be extracted as a variable
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'my_handler')).toBeDefined();
    // g_x should also be extracted
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_x')).toBeDefined();
  });

  it('DOES replace statement-level macro at file scope (correct behavior)', () => {
    // A bare SWITCH(x) with no trailing ; at statement scope should be replaced.
    const macroNames = new Set(['SWITCH']);

    const result = extractFromSource('test.c',
      'void foo(void) {\n' +
      '  SWITCH(x)\n' +
      '  int local = 1;\n' +
      '}\n' +
      'int g_after = 42;\n',
      undefined,
      undefined,
      macroNames
    );

    // g_after should be extracted (compound_statement stays open after replacement)
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_after')).toBeDefined();
  });
});