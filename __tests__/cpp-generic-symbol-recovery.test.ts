import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['c', 'cpp']);
});

function cpp(source: string) {
  return extractFromSource('generic.cpp', source, 'cpp');
}

describe('generic C/C++ declaration recovery', () => {
  it('indexes anonymous structs, unions, and enums while preserving injected members', () => {
    const result = cpp([
      'struct Owner {',
      '  union {',
      '    struct { int value; };',
      '    long raw;',
      '  };',
      '  enum { ready = 1 };',
      '};',
      'typedef struct { int c_value; } CValue;',
      'typedef enum { c_ready = 1 } CState;',
    ].join('\n'));

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', name: '(anonymous union)' }),
      expect.objectContaining({ kind: 'struct', name: '(anonymous struct)' }),
      expect.objectContaining({ kind: 'enum', name: '(anonymous enum)' }),
      expect.objectContaining({ kind: 'field', name: 'value' }),
      expect.objectContaining({ kind: 'field', name: 'raw' }),
      expect.objectContaining({ kind: 'enum_member', name: 'ready' }),
      expect.objectContaining({ kind: 'struct', name: 'CValue' }),
      expect.objectContaining({ kind: 'enum', name: 'CState' }),
    ]));
  });

  it('indexes templated forward declarations, member prototypes, and explicit instantiations', () => {
    const result = cpp([
      'template <class R, class C> class PlanVisitor;',
      'template <class T>',
      'class Box {',
      'public:',
      '  template <class F> void for_each(F &&fn);',
      '  template <> void visit<demo::Item>(const demo::Item &);',
      '};',
      'template class Box<int>;',
      'extern template class Box<long>;',
    ].join('\n'));

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'PlanVisitor', isDeclaration: true }),
      expect.objectContaining({ kind: 'method', name: 'for_each', isDeclaration: true }),
      expect.objectContaining({ kind: 'method', name: 'visit<demo::Item>', isDeclaration: true }),
      expect.objectContaining({ kind: 'class', name: 'Box<int>', startLine: 8 }),
    ]));
  });

  it('keeps function and member-function pointers as fields', () => {
    const result = cpp([
      'class Comparator {',
      '  int (*plain_)(int);',
      '  int (Comparator::*member_)(int) const;',
      '  int compare(int) const;',
      '};',
    ].join('\n'));

    expect(result.nodes.filter(node => node.kind === 'field').map(node => node.name))
      .toEqual(expect.arrayContaining(['plain_', 'member_']));
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'method', name: 'compare' }),
    ]));
    expect(result.nodes.some(node => node.kind === 'method' && node.name === 'member_')).toBe(false);
  });

  it('normalizes callable template-ids and symbolic operator whitespace', () => {
    const result = cpp([
      'template <class T> struct List { List(); };',
      'template <class T> List<T>::List() {}',
      'struct Label { bool operator = (const Label &) const; };',
    ].join('\n'));

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'method', name: 'List' }),
      expect.objectContaining({ kind: 'method', name: 'operator=' }),
    ]));
  });

  it('uses an inline type declaration as the range of its trailing field', () => {
    const result = cpp([
      'class Owner {',
      '  class Thread {',
      '    void run();',
      '  } thread_;',
      '};',
    ].join('\n'));
    const thread = result.nodes.find(node => node.kind === 'field' && node.name === 'thread_');

    expect(thread).toMatchObject({ startLine: 2, endLine: 4 });
  });
});
