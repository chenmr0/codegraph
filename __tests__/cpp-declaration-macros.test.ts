import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';
import {
  expandDeclarationMacros,
  scanCppMacroDefinitions,
  selectUnambiguousCppMacroDefinitions,
} from '../src/extraction/declaration-macros';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['cpp']);
});

describe('C/C++ declaration macro expansion', () => {
  it('recovers same-file class specializations without changing line count', () => {
    const source = [
      '#define REGISTER(type, text) \\',
      '  template <> struct Traits<type> { \\',
      '    static constexpr const char *name_ = text; \\',
      '  }',
      '',
      'REGISTER(KIND_A, "A");',
      'int after;',
      '',
    ].join('\n');
    const result = expandDeclarationMacros(source, []);

    expect(result.invocationLines).toEqual(new Set([6]));
    expect(result.source).toContain('template <> struct Traits<KIND_A>');
    expect(result.source).toContain('static constexpr const char *name_ = "A"');
    expect(result.source.split('\n')).toHaveLength(source.split('\n').length);
    expect(result.source.split('\n')[6]).toBe('int after;');
  });

  it('recursively expands helper, variadic, stringify, and token-paste macros', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(scanCppMacroDefinitions([
      '#define DECLARE_METHODS(CLS) int CLS::serialize() const; int CLS::deserialize();',
      '#define WRAP(CLS, ...) DECLARE_METHODS(CLS) static int CLS::count_##__VA_ARGS__;',
      '#define NAMED(name) static const char *name##_text = #name;',
    ].join('\n')));
    const source = [
      'namespace demo {',
      'WRAP(Widget, fields)',
      'NAMED(widget)',
      '}',
    ].join('\n');
    const result = expandDeclarationMacros(source, definitions);

    expect(result.source).toContain('int Widget::serialize() const;');
    expect(result.source).toContain('int Widget::deserialize();');
    expect(result.source).toContain('static int Widget::count_fields;');
    expect(result.source).toContain('static const char *widget_text = "widget";');
    expect(result.invocationLines).toEqual(new Set([2, 3]));
  });

  it('pre-expands ordinary arguments while preserving raw stringify and paste operands', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(scanCppMacroDefinitions([
      '#define SELECT3(_1, _2, _3, ...) _3',
      '#define COMMA_(...) ,',
      '#define APPLY_(f, ...) f(__VA_ARGS__)',
      '#define CAR(a, b) a',
      '#define IF_PAREN(x, yes, no) APPLY_(SELECT3, COMMA_ x, yes, no)',
      '#define OWNER(pair) IF_PAREN(pair, CAR pair, pair)',
      '#define METHOD(pair) int OWNER(pair)::load();',
      '#define WORD target',
      '#define RAW(name) int prefix_##name; const char *text = #name;',
    ].join('\n')));
    const result = expandDeclarationMacros([
      'METHOD((Derived, Base))',
      'RAW(WORD)',
    ].join('\n'), definitions);

    expect(result.source).toContain('int Derived::load();');
    expect(result.source).toContain('int prefix_WORD;');
    expect(result.source).toContain('"WORD"');
  });

  it('does not share conflicting project-wide definitions', () => {
    const definitions = selectUnambiguousCppMacroDefinitions([
      ...scanCppMacroDefinitions('#define DECL(T) struct T {};'),
      ...scanCppMacroDefinitions('#define DECL(T) class T {};'),
      ...scanCppMacroDefinitions('#define SAME(T) struct T {};'),
      ...scanCppMacroDefinitions('#define SAME(T) struct T {};'),
    ]);

    expect(definitions.map(definition => definition.name)).toEqual(['SAME']);
  });

  it('leaves expression and statement macros untouched', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(scanCppMacroDefinitions([
      '#define LIKELY(x) __builtin_expect(x, 1)',
      '#define LOG(x) do { write(x); } while (0)',
    ].join('\n')));
    const source = 'int f() { if (LIKELY(1)) LOG(1); return 0; }';
    const result = expandDeclarationMacros(source, definitions);

    expect(result.source).toBe(source);
    expect(result.invocationLines.size).toBe(0);
  });

  it('honors the declaration-scope predicate', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(
      scanCppMacroDefinitions('#define DECL(name) static int name;'),
    );
    const source = ['DECL(global_value)', 'void f() {', '  DECL(local_value)', '}'].join('\n');
    const result = expandDeclarationMacros(
      source,
      definitions,
      line => line === 1,
    );

    expect(result.source).toContain('static int global_value;');
    expect(result.source).toContain('DECL(local_value)');
    expect(result.invocationLines).toEqual(new Set([1]));
  });

  it('does not index declaration-shaped macros used inside function bodies', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(
      scanCppMacroDefinitions('#define DECL(name) static int name;'),
    );
    const result = extractFromSource(
      'scope.cpp',
      ['void run() { DECL(local_only) }', 'DECL(global_value)'].join('\n'),
      'cpp',
      undefined,
      new Set(['DECL']),
      new Set(),
      definitions,
    );

    expect(result.nodes.some(node => node.name === 'local_only')).toBe(false);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'variable', name: 'global_value', startLine: 2 }),
    ]));
  });

  it('merges generated classes, methods, fields, and variables at invocation lines', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(scanCppMacroDefinitions([
      '#define SPECIALIZE(T, value) template <> struct Traits<T> { static constexpr int code = value; }',
      '#define MEMBERS(label) private: int state_; public: bool operator()() { return true; } bool apply()',
      '#define GLOBAL(name) static int name;',
    ].join('\n')));
    const source = [
      'namespace demo {',
      'template <typename T> struct Traits;',
      'SPECIALIZE(Widget, 7);',
      'class Runner {',
      '  MEMBERS(run) { return operator()(); }',
      '};',
      'GLOBAL(global_state)',
      'void ordinary() {}',
      '}',
    ].join('\n');
    const result = extractFromSource(
      'sample.cpp',
      source,
      'cpp',
      undefined,
      new Set(definitions.map(definition => definition.name)),
      new Set(),
      definitions,
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', name: 'Traits<Widget>', startLine: 3 }),
      expect.objectContaining({ kind: 'field', name: 'code', startLine: 3 }),
      expect.objectContaining({ kind: 'field', name: 'state_', startLine: 5 }),
      expect.objectContaining({ kind: 'method', name: 'operator()', startLine: 5 }),
      expect.objectContaining({ kind: 'method', name: 'apply', startLine: 5 }),
      expect.objectContaining({ kind: 'variable', name: 'global_state', startLine: 7 }),
    ]));
    expect(result.nodes.filter(node => node.name === 'ordinary')).toHaveLength(1);
  });

  it('keeps the shared parser healthy across declaration-macro auxiliary parses', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(
      scanCppMacroDefinitions('#define DECLARE(Name) struct Name { int value; };'),
    );
    const sharedParser = getParser('cpp');
    const recovered = extractFromSource(
      'generated.cpp',
      'DECLARE(GeneratedRecord)\n',
      'cpp',
      undefined,
      new Set(['DECLARE']),
      new Set(),
      definitions,
    );
    const sentinel = extractFromSource(
      'sentinel.cpp',
      'struct Sentinel { int field; };\n',
      'cpp',
    );

    expect(getParser('cpp')).toBe(sharedParser);
    expect(recovered.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', name: 'GeneratedRecord' }),
    ]));
    expect(sentinel.errors).toEqual([]);
    expect(sentinel.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'struct', name: 'Sentinel' }),
      expect.objectContaining({ kind: 'field', name: 'field' }),
    ]));
  });

  it('uses context-sparse recovery for large translation units without a size cap', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(
      scanCppMacroDefinitions('#define DECLARE_VALUE(Name) static int Name;'),
    );
    const padding = '// declaration-macro replay budget padding\n'.repeat(7_000);
    const source = [
      'int ordinary_value;',
      padding,
      'DECLARE_VALUE(recovered_value)',
    ].join('\n');
    expect(source.length).toBeGreaterThan(256 * 1024);

    const result = extractFromSource(
      'large-generated.cpp',
      source,
      'cpp',
      undefined,
      new Set(['DECLARE_VALUE']),
      new Set(),
      definitions,
    );

    expect(result.errors).toEqual([]);
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'variable', name: 'ordinary_value' }),
      expect.objectContaining({ kind: 'variable', name: 'recovered_value' }),
    ]));
  });

  it('recovers split function-definition signatures without a semicolon', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(
      scanCppMacroDefinitions('#define DEFINE_SERIALIZE(T) int T::serialize() const'),
    );
    const source = [
      'class Value { public: int serialize() const; };',
      'DEFINE_SERIALIZE(Value)',
      '{',
      '  return 0;',
      '}',
    ].join('\n');
    const result = extractFromSource(
      'split.cpp', source, 'cpp', undefined,
      new Set(['DEFINE_SERIALIZE']), new Set(), definitions,
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'method', name: 'serialize', startLine: 2 }),
    ]));
  });

  it('filters template parameter names misparsed as generated fields', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(scanCppMacroDefinitions([
      '#define WRAPPER(Name) template <class T> class Name { T &allocator_; };',
    ].join('\n')));
    const result = extractFromSource(
      'wrapper.cpp', 'WRAPPER(TAllocator)', 'cpp', undefined,
      new Set(['WRAPPER']), new Set(), definitions,
    );

    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', name: 'TAllocator' }),
      expect.objectContaining({ kind: 'field', name: 'allocator_' }),
    ]));
    expect(result.nodes.some(node => node.kind === 'field' && node.name === 'T')).toBe(false);
  });

  it('does not let line comments in a multi-line macro swallow later declarations', () => {
    const definitions = selectUnambiguousCppMacroDefinitions(scanCppMacroDefinitions([
      '#define METHODS(C, ...) int C::first(); __VA_ARGS__ int C::second();',
    ].join('\n')));
    const expanded = expandDeclarationMacros([
      'METHODS(Value,',
      '  // explanation for the inserted declaration',
      '  int marker_;)',
    ].join('\n'), definitions);

    expect(expanded.source).toContain('Value::first');
    expect(expanded.source).toContain('Value::second');
    expect(expanded.source).not.toContain('// explanation');
  });

  it('propagates declarations from common C++ .ipp macro headers through indexAll', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-decl-macro-'));
    let graph: CodeGraph | undefined;
    try {
      fs.writeFileSync(
        path.join(directory, 'declarations.ipp'),
        '#define DECLARE_RECORD(Name) struct Name { int value; };\n',
      );
      fs.writeFileSync(path.join(directory, 'consumer.cpp'), 'DECLARE_RECORD(RecoveredRecord)\n');
      graph = await CodeGraph.init(directory, { silent: true });
      await graph.indexAll();
      const rows = (graph as any).db.db.prepare(
        "SELECT name, kind, file_path FROM nodes WHERE name IN ('RecoveredRecord', 'value')",
      ).all() as Array<{ name: string; kind: string; file_path: string }>;

      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'RecoveredRecord', kind: 'struct', file_path: 'consumer.cpp' }),
        expect.objectContaining({ name: 'value', kind: 'field', file_path: 'consumer.cpp' }),
      ]));
    } finally {
      graph?.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
