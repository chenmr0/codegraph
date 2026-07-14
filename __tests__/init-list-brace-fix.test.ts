import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// Regression tests for preprocessStatementMacros brace-context tracking.
// Before the fix, macros inside initializer lists / aggregate bodies were
// wrongly replaced with `0;` because only parenDepth was tracked, not brace
// context.  These tests cover the cases the fix must handle without breaking
// the original statement-level macro replacement (open5gs SWITCH/CASE/etc).
describe('preprocessStatementMacros brace-context fix', () => {

  // ── A. Simple initializer list ────────────────────────────────────────
  it('does NOT replace NULL inside a brace initializer (the original bug)', () => {
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
      undefined, undefined, macroNames
    );
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'my_handler')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_x')).toBeDefined();
  });

  // ── B. Bitwise-OR expression in initializer ───────────────────────────
  it('does NOT replace macro followed by | inside an initializer', () => {
    const macroNames = new Set(['OB_UTF8MB4', 'OB_CS_UTF8MB4_UCA_FLAGS']);
    const result = extractFromSource('test.c',
      'int arr[] = {\n' +
      '  OB_UTF8MB4 | 0x10,\n' +
      '  OB_CS_UTF8MB4_UCA_FLAGS | 0x20,\n' +
      '  0,\n' +
      '};\n' +
      'int g_after = 42;\n',
      undefined, undefined, macroNames
    );
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'arr')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_after')).toBeDefined();
  });

  // ── C. return { ... } initializer ─────────────────────────────────────
  it('does NOT replace NULL inside return { ... }', () => {
    const macroNames = new Set(['NULL']);
    const result = extractFromSource('test.c',
      'struct Pair { int a; int b; };\n' +
      'struct Pair get_pair(void) {\n' +
      '  return { NULL, 0 };\n' +
      '}\n' +
      'int g_after = 7;\n',
      undefined, undefined, macroNames
    );
    const fn = result.nodes.find(n => n.kind === 'function' && n.name === 'get_pair');
    expect(fn).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_after')).toBeDefined();
  });

  // ── D. Compound literal (type){ ... } ─────────────────────────────────
  it('does NOT replace NULL inside a compound literal (type){ ... }', () => {
    const macroNames = new Set(['NULL']);
    const result = extractFromSource('test.c',
      'struct S { int a; int b; };\n' +
      'struct S s = (struct S){ NULL, 0 };\n' +
      'int g_after = 99;\n',
      undefined, undefined, macroNames
    );
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 's')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_after')).toBeDefined();
  });

  // ── E. C++ uniform initialization int x{ ... } ────────────────────────
  it('does NOT replace NULL inside C++ uniform initialization x{ ... }', () => {
    const macroNames = new Set(['NULL']);
    const result = extractFromSource('test.cpp',
      'int g_val{ NULL };\n' +
      'int g_after = 5;\n',
      undefined, undefined, macroNames
    );
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_val')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_after')).toBeDefined();
  });

  // ── F. enum aggregate body ────────────────────────────────────────────
  it('does NOT replace NULL inside enum body', () => {
    const macroNames = new Set(['NULL']);
    const result = extractFromSource('test.c',
      'enum E { A = NULL, B = 2, C = 3 };\n' +
      'int g_after = 11;\n',
      undefined, undefined, macroNames
    );
    const e = result.nodes.find(n => n.kind === 'enum' && n.name === 'E');
    expect(e).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_after')).toBeDefined();
  });

  // ── G. Nested initializer lists ───────────────────────────────────────
  it('handles nested initializer lists { { NULL, NULL }, { NULL, NULL } }', () => {
    const macroNames = new Set(['NULL']);
    const result = extractFromSource('test.c',
      'struct Inner { void *a; void *b; };\n' +
      'struct Outer { struct Inner x; struct Inner y; };\n' +
      'struct Outer obj = { { NULL, NULL }, { NULL, NULL } };\n' +
      'int g_after = 33;\n',
      undefined, undefined, macroNames
    );
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'obj')).toBeDefined();
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_after')).toBeDefined();
  });

  // ── H. Original feature still works: statement-level macro in func body ─
  it('DOES replace statement-level macro in function body (original feature)', () => {
    const macroNames = new Set(['SWITCH']);
    const result = extractFromSource('test.c',
      'void f(void) {\n' +
      '  SWITCH(x)\n' +
      '  bar();\n' +
      '}\n' +
      'int g_after = 42;\n',
      undefined, undefined, macroNames
    );
    const fn = result.nodes.find(n => n.kind === 'function' && n.name === 'f');
    expect(fn).toBeDefined();
    const callees = result.unresolvedReferences
      .filter(r => r.fromNodeId === fn!.id && r.referenceKind === 'calls')
      .map(r => r.referenceName);
    expect(callees).toContain('bar');
    expect(result.nodes.find(n => n.kind === 'variable' && n.name === 'g_after')).toBeDefined();
  });

  // ── I. MACRO(params) { body } pattern preserved ───────────────────────
  it('preserves MACRO(params) { body } pattern (isMisparsedFunction)', () => {
    const macroNames = new Set(['FOREACH_X']);
    const result = extractFromSource('test.c',
      'void g(void) {\n' +
      '  FOREACH_X(items)\n' +
      '  {\n' +
      '    process_item();\n' +
      '  }\n' +
      '}\n',
      undefined, undefined, macroNames
    );
    expect(result.nodes.find(n => n.kind === 'function' && n.name === 'FOREACH_X')).toBeUndefined();
    const g = result.nodes.find(n => n.kind === 'function' && n.name === 'g');
    expect(g).toBeDefined();
    const callees = result.unresolvedReferences
      .filter(r => r.fromNodeId === g!.id && r.referenceKind === 'calls')
      .map(r => r.referenceName);
    expect(callees).toContain('process_item');
  });

  // ── J. open5gs full SWITCH/CASE/DEFAULT/END flow ──────────────────────
  it('keeps all calls inside a SWITCH/CASE/DEFAULT/END body attributed to the function', () => {
    const macroNames = new Set(['SWITCH', 'CASE', 'DEFAULT', 'END', 'RESOURCE_A', 'RESOURCE_B']);
    const code = `
int handle(oid_t id) {
  int rv = 0;
  SWITCH(id)
  CASE(RESOURCE_A)
    parse_a();
    rv = 1;
    break;
  CASE(RESOURCE_B)
    parse_b();
    add_client();
    rv = 2;
    break;
  DEFAULT
    ogs_error("unknown");
    rv = -1;
    break;
  END
  return rv;
}
`;
    const result = extractFromSource('test.c', code, undefined, undefined, macroNames);
    const fn = result.nodes.find(n => n.kind === 'function' && n.name === 'handle');
    expect(fn).toBeDefined();
    const callees = result.unresolvedReferences
      .filter(r => r.fromNodeId === fn!.id && r.referenceKind === 'calls')
      .map(r => r.referenceName);
    expect(callees).toContain('parse_a');
    expect(callees).toContain('parse_b');
    expect(callees).toContain('add_client');
    expect(callees).toContain('ogs_error');
  });

  // ── K. Class body with statement-level macro ─────────────────────────
  // `class Foo { ... TO_STRING_KV(...) };` — the class body `{` is preceded
  // by a type name (identifier), which must NOT be misclassified as an
  // initializer list.  Statement-level macros inside the class body (like
  // TO_STRING_KV) must be replaced so tree-sitter can parse the class.
  it('replaces statement-level macros inside class/struct bodies', () => {
    const macroNames = new Set(['TO_STRING_KV', 'K_', 'NULL']);
    const code = `
struct ObIvfRowkeyDistItem
{
  ObIvfRowkeyDistItem(): rowkey_idx_(-1), distance_(0.0f) {}
  int32_t rowkey_idx_;
  float distance_;
  TO_STRING_KV(K_(rowkey_idx), K_(distance))
};

class ObIvfPreFilter
{
public:
  ObIvfPreFilter(uint64_t tenant_id) : tenant_id_(tenant_id) {}
  ~ObIvfPreFilter() { reset(); }
  void reset();
  int init();
  TO_STRING_KV(K(tenant_id_))
public:
  uint64_t tenant_id_;
};
`;
    const result = extractFromSource('test.h', code, undefined, undefined, macroNames);
    // Both struct and class must be extracted (not swallowed by macro ERROR).
    const s = result.nodes.find(n => n.kind === 'struct' && n.name === 'ObIvfRowkeyDistItem');
    expect(s).toBeDefined();
    const c = result.nodes.find(n => n.kind === 'class' && n.name === 'ObIvfPreFilter');
    expect(c).toBeDefined();
  });

  // ── L. Enum body — macros in enumerator initializers NOT replaced ─────
  it('does NOT replace macros inside enum body initializers', () => {
    const macroNames = new Set(['FLAG_A', 'FLAG_B']);
    const code = `
enum Flags {
  VALUE_X = FLAG_A,
  VALUE_Y = FLAG_B | 0x10,
  VALUE_Z = 0
};
`;
    const result = extractFromSource('test.h', code, undefined, undefined, macroNames);
    const e = result.nodes.find(n => n.kind === 'enum' && n.name === 'Flags');
    expect(e).toBeDefined();
  });

  // ── M. enum class (scoped enum) body ─────────────────────────────────
  it('does NOT replace macros inside enum class body', () => {
    const macroNames = new Set(['FLAG_A', 'FLAG_B']);
    const code = `
enum class ScopedFlags {
  A_VAL = FLAG_A,
  B_VAL = FLAG_B
};
`;
    const result = extractFromSource('test.h', code, undefined, undefined, macroNames);
    const e = result.nodes.find(n => n.kind === 'enum' && n.name === 'ScopedFlags');
    expect(e).toBeDefined();
  });
});