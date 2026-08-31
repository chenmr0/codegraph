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

  it('does not let qualified return types leak into recovered method identities', () => {
    const result = cpp([
      'template <class T> struct Box {',
      '  using iterator = int;',
      '  iterator begin();',
      '};',
      'template <class T>',
      'typename Box<T>::iterator Box<T>::begin() { return 0; }',
      '@', // Keep the translation unit damaged so source-spelled recovery runs.
    ].join('\n'));
    const definitions = result.nodes.filter(node =>
      node.kind === 'method' && node.name === 'begin' && node.startLine === 6
    );

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      qualifiedName: 'Box<T>::begin',
    });
    expect(definitions[0]?.isDeclaration).not.toBe(true);
  });

  it('normalizes nested-template, spaced-scope, destructor, and operator recovery names', () => {
    const result = cpp([
      'template <class T> struct Box;',
      'typename Box<A<B<C<int>>>>::iterator Box<A<B<C<int>>>> :: begin() { return 0; }',
      'Box<A<B<C<int>>>> :: ~Box() {}',
      'Box<A<B<C<int>>>>::operator bool() const { return true; }',
      'Box<A<B<C<int>>>>::operator const char *() const { return nullptr; }',
      'Box<A<B<C<int>>>> &Box<A<B<C<int>>>>::operator = (const Box &) { return *this; }',
      '@',
    ].join('\n'));
    const definitions = result.nodes.filter(node =>
      node.kind === 'method' && !node.isDeclaration
    );

    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'begin', qualifiedName: 'Box<A<B<C<int>>>>::begin' }),
      expect.objectContaining({ name: '~Box', qualifiedName: 'Box<A<B<C<int>>>>::~Box' }),
      expect.objectContaining({ name: 'operator bool', qualifiedName: 'Box<A<B<C<int>>>>::operator bool' }),
      expect.objectContaining({ name: 'operator const char*', qualifiedName: 'Box<A<B<C<int>>>>::operator const char*' }),
      expect.objectContaining({ name: 'operator=', qualifiedName: 'Box<A<B<C<int>>>>::operator=' }),
    ]));
    for (const name of ['begin', '~Box', 'operator bool', 'operator const char*', 'operator=']) {
      expect(definitions.filter(node => node.name === name)).toHaveLength(1);
    }
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
