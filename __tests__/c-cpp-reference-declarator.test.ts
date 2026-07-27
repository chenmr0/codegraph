/**
 * C/C++ reference_declarator 命名/抽取回归测试。
 *
 * tree-sitter-cpp 把引用返回函数/引用数据成员的 declarator 包成
 * `reference_declarator`。三处解包点（extractName 默认路径、extractField
 * bodiless 成员声明、extractField 数据成员）原先都不解 reference_declarator，
 * 导致：
 *   - 引用返回函数/方法名带 `&` 和 `()`（`& get_instance()`）
 *   - bodiless 引用返回成员声明被整个丢弃
 *   - 引用数据成员字段被丢弃（OceanBase `columns_`）
 *
 * 见 __tests__/accuracy/REPORT.md 阶段三。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function namesOf(result: { nodes: Array<{ name: string; kind: string }> }, kind: string): string[] {
  return result.nodes.filter((n) => n.kind === kind).map((n) => n.name);
}

describe('C++ reference_declarator extraction', () => {
  it('in-class reference-return method is named cleanly (no `&` / `()`)', () => {
    const result = extractFromSource(
      'a.hpp',
      `class APIRegister {
public:
  static APIRegister& get_instance() {
    static APIRegister i;
    return i;
  }
};`,
    );
    // Must NOT be "& get_instance()" — the pre-fix bug.
    expect(namesOf(result, 'method')).not.toContain('& get_instance()');
    expect(namesOf(result, 'method')).toContain('get_instance');
  });

  it('free reference-return function is named cleanly', () => {
    const result = extractFromSource(
      'a.cpp',
      `static ObFIFOAllocator &get_global_allocator() {
  static ObFIFOAllocator a;
  return a;
}`,
    );
    expect(namesOf(result, 'function')).not.toContain('&get_global_allocator()');
    expect(namesOf(result, 'function')).toContain('get_global_allocator');
  });

  it('rvalue-reference (&&) and pointer+reference (*&) returns are named cleanly', () => {
    const result = extractFromSource(
      'a.cpp',
      `int&& baz() { static int x = 1; return x; }
int*& bar() { static int* p = nullptr; return p; }`,
    );
    const fns = namesOf(result, 'function');
    expect(fns).toContain('baz');
    expect(fns).toContain('bar');
    expect(fns.some((n) => n.includes('&&'))).toBe(false);
    expect(fns.some((n) => n.includes('&*') || n.includes('*&'))).toBe(false);
  });

  it('bodiless reference-return member declaration is extracted as a method, not dropped', () => {
    const result = extractFromSource(
      'a.hpp',
      `class Logger {
public:
  static Logger& instance();
  void writeLog();
};`,
    );
    const methods = namesOf(result, 'method');
    expect(methods).toContain('instance');
    expect(methods).toContain('writeLog');
    // No mangled name leaking the declarator text.
    expect(methods.some((n) => n.startsWith('&'))).toBe(false);
  });

  it('reference data member is extracted as a field, not dropped', () => {
    const result = extractFromSource(
      'a.hpp',
      `class LuaVtableGenerator {
private:
  std::vector<const char*>& columns_;
  int& ref_count_;
  int value_count_;
};`,
    );
    const fields = namesOf(result, 'field');
    expect(fields).toContain('columns_');
    expect(fields).toContain('ref_count_');
    expect(fields).toContain('value_count_');
  });

  it('regression: pointer-return still works (no behavior change)', () => {
    const result = extractFromSource(
      'a.cpp',
      `void* foo() { return nullptr; }
class C { void* bar(); };`,
    );
    const fns = namesOf(result, 'function');
    const methods = namesOf(result, 'method');
    expect(fns).toContain('foo');
    expect(methods).toContain('bar');
  });

  it('regression: out-of-line qualified definition still named cleanly', () => {
    const result = extractFromSource(
      'a.cpp',
      `void Logger::writeLog() {}
APIRegister& APIRegister::get_instance() { static APIRegister i; return i; }`,
    );
    const methods = namesOf(result, 'method');
    expect(methods).toContain('writeLog');
    expect(methods).toContain('get_instance');
  });

  // Free-function PROTOTYPE (bodiless declaration) at file/namespace scope with
  // reference return. tree-sitter-cpp wraps the function_declarator in a
  // reference_declarator; childForFieldName("declarator") returns null on
  // reference_declarator (a web-tree-sitter quirk that does NOT affect
  // pointer_declarator), so the prototype path's getChildByField came back
  // empty and the whole prototype was silently dropped — even though the
  // .cpp definition survived via extractName's namedChild(0) fallback and
  // class methods survived via extractField's by-type unwrap. This is the
  // user-reported TrmGetPidSrvRef case.
  it('free reference-return prototype is extracted, not dropped', () => {
    const result = extractFromSource(
      'trm_srv.h',
      `#ifndef TRM_SRV_H
#define TRM_SRV_H
typedef unsigned int VOS_UINT32;
class CTrmSrv { public: int x; };
CTrmSrv* TrmGetPidSrv(VOS_UINT32 ulPid);
CTrmSrv& TrmGetPidSrvRef(VOS_UINT32 ulPid);
#endif`,
    );
    const fns = namesOf(result, 'function');
    expect(fns).toContain('TrmGetPidSrv');
    expect(fns).toContain('TrmGetPidSrvRef');
    // No mangled name with the declarator text leaking through.
    expect(fns.some((n) => n.startsWith('&'))).toBe(false);
  });

  it('rvalue-reference (&&) and ref-to-pointer (*&) prototypes are extracted', () => {
    const result = extractFromSource(
      'a.h',
      `class Ostream {};
Ostream& makeRef(int x);
int&& rvalueProto(int x);
int*& refPtrProto(int x);`,
    );
    const fns = namesOf(result, 'function');
    expect(fns).toContain('makeRef');
    expect(fns).toContain('rvalueProto');
    expect(fns).toContain('refPtrProto');
    expect(fns.some((n) => n.includes('&&'))).toBe(false);
    expect(fns.some((n) => n.includes('*&') || n.includes('&*'))).toBe(false);
  });

  it('macro-prefixed reference-return prototype is extracted', () => {
    const result = extractFromSource(
      'a.h',
      `#define RRE_ATTRIBUTE_VISIBILITY __attribute__((visibility("default")))
class CTrmSrv {};
RRE_ATTRIBUTE_VISIBILITY CTrmSrv& TrmGetPidSrvRef();
CTrmSrv* TrmGetPidSrv();`,
    );
    const fns = namesOf(result, 'function');
    // After macro replacement, both prototypes must survive; the reference one
    // is the one that was previously dropped.
    expect(fns).toContain('TrmGetPidSrvRef');
    expect(fns).toContain('TrmGetPidSrv');
  });

  it('regression: pointer/value-return prototypes alongside reference prototypes', () => {
    const result = extractFromSource(
      'a.h',
      `class C {};
C* ptrProto(int x);
C& refProto(int x);
C  valProto(int x);
int& intRefProto(int x);`,
    );
    const fns = namesOf(result, 'function');
    expect(fns).toContain('ptrProto');
    expect(fns).toContain('refProto');
    expect(fns).toContain('valProto');
    expect(fns).toContain('intRefProto');
  });
});