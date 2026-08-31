import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['c', 'cpp']);
});

function kinds(source: string, filePath = 'const-matrix.cpp'): Record<string, string> {
  return Object.fromEntries(
    extractFromSource(filePath, source).nodes
      .filter(node => node.kind === 'variable' || node.kind === 'constant')
      .map(node => [node.name, node.kind]),
  );
}

describe('C/C++ declarator-level top-level const classification', () => {
  it('classifies each C++ declarator by object constness', () => {
    expect(kinds([
      'const int value = 1;',
      'const int *mutable_pointer = nullptr;',
      'int * const fixed_pointer = nullptr;',
      'const int * const fixed_const_pointer = nullptr;',
      'const int values[] = {1, 2};',
      'const int *mutable_pointer_array[] = {nullptr};',
      'constexpr int compile_time_value = 2;',
      'const int &reference = value;',
      'constexpr const int &compile_time_reference = value;',
    ].join('\n'))).toMatchObject({
      value: 'constant',
      mutable_pointer: 'variable',
      fixed_pointer: 'constant',
      fixed_const_pointer: 'constant',
      values: 'constant',
      mutable_pointer_array: 'variable',
      compile_time_value: 'constant',
      reference: 'variable',
      compile_time_reference: 'constant',
    });
  });

  it('does not leak a shared base const across multiple declarators', () => {
    expect(kinds(
      'const int plain = 1, *mutable_pointer = nullptr, * const fixed_pointer = nullptr;',
    )).toMatchObject({
      plain: 'constant',
      mutable_pointer: 'variable',
      fixed_pointer: 'constant',
    });
  });

  it('uses the modifier closest to the identifier for nested pointers and arrays', () => {
    expect(kinds([
      'const int **mutable_outer = nullptr;',
      'const int * const *still_mutable_outer = nullptr;',
      'const int ** const fixed_outer = nullptr;',
      'const int (*mutable_pointer_to_array)[3] = nullptr;',
      'const int (* const fixed_pointer_to_array)[3] = nullptr;',
      'int * const fixed_pointer_elements[] = {nullptr};',
    ].join('\n'))).toMatchObject({
      mutable_outer: 'variable',
      still_mutable_outer: 'variable',
      fixed_outer: 'constant',
      mutable_pointer_to_array: 'variable',
      fixed_pointer_to_array: 'constant',
      fixed_pointer_elements: 'constant',
    });
  });

  it('applies the same top-level const rules to C declarations', () => {
    expect(kinds([
      'const int c_value = 1;',
      'const int *c_mutable_pointer = 0;',
      'int * const c_fixed_pointer = 0;',
      'const int c_values[] = {1};',
      'const int *c_mutable_pointer_array[] = {0};',
    ].join('\n'), 'const-matrix.c')).toMatchObject({
      c_value: 'constant',
      c_mutable_pointer: 'variable',
      c_fixed_pointer: 'constant',
      c_values: 'constant',
      c_mutable_pointer_array: 'variable',
    });
  });
});
