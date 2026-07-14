import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('body leak typedef regression', () => {
  it('extracts leaked content when typedef is the first leaked node', () => {
    // Simulate: #define inside function body breaks compound_statement,
    // causing subsequent file-level content to be swallowed.
    const result = extractFromSource('test.c',
      'void broken_func(void) {\n' +
      '  #define MACRO(x) (x)\n' +
      '  int a = MACRO(1);\n' +
      '}\n' +
      'typedef int my_type;\n' +
      'int g_x = 1;\n' +
      'int g_y = 2;\n' +
      'void leaked_func_a(int x) { }\n' +
      'int leaked_func_b(int y) { return y; }\n' +
      'void leaked_func_c(void) { }\n'
    );

    const funcs = result.nodes.filter(n => n.kind === 'function');
    const vars = result.nodes.filter(n => n.kind === 'variable');
    console.log('Functions:', funcs.map(f => f.name));
    console.log('Variables:', vars.map(v => v.name));

    // These should be extracted as file-level nodes
    expect(result.nodes.find(n => n.kind === 'function' && n.name === 'leaked_func_a')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'function' && n.name === 'leaked_func_b')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'function' && n.name === 'leaked_func_c')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_x')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_y')).toBeDefined();
  });

  it('extracts leaked content when function_definition is the first leaked node', () => {
    // Control case: no typedef before the leaked content
    const result = extractFromSource('test.c',
      'void broken_func(void) {\n' +
      '  #define MACRO(x) (x)\n' +
      '  int a = MACRO(1);\n' +
      '}\n' +
      'int g_x = 1;\n' +
      'int g_y = 2;\n' +
      'void leaked_func_a(int x) { }\n' +
      'int leaked_func_b(int y) { return y; }\n'
    );

    const funcs = result.nodes.filter(n => n.kind === 'function');
    const vars = result.nodes.filter(n => n.kind === 'variable');
    console.log('Functions:', funcs.map(f => f.name));
    console.log('Variables:', vars.map(v => v.name));

    expect(result.nodes.find(n => n.kind === 'function' && n.name === 'leaked_func_a')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'function' && n.name === 'leaked_func_b')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_x')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_y')).toBeDefined();
  });
});