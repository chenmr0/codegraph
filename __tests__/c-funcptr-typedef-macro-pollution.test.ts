/**
 * C 函数指针 typedef 丢名 + 全量建库宏污染误炸 回归测试。
 *
 * 三个独立缺陷（见 plans/cheeky-napping-seal.md）：
 *   - 现象 A：`typedef [SAFE] TYPE (*NAME)(...)` 名字被抽成 `*NAME` / `TYPE (*NAME)`，
 *     外加 bogus `SAFE` type_alias。空体前缀宏 SAFE/BORROW 没被预空白，使 tree-sitter
 *     走错误恢复路径把真名字埋进 parameter_list。
 *   - 现象 B：全项目 `#define` 并集（globalMacroNames）里有名字与函数指针声明的返回类型
 *     同名时，preprocessStatementMacros 把 `TYPE (*name)(params)` 误判为宏调用并替换
 *     成 `0;`，炸掉字段和所在 struct/typedef（"小模块能搜、全量搜不到"）。
 *
 * 三处修复：
 *   - Fix A：预空白空体对象式宏（bodylessMacroNames）。
 *   - Fix B：extractName / extractField 的 parenthesized_declarator 多解包一层
 *     pointer/reference_declarator。
 *   - Fix C：preprocessStatementMacros 护栏加 `nextTok === '('`，识别函数指针 declarator。
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

const HEAD = `typedef unsigned int VOS_UINT32;
typedef unsigned int VOS_BOOL;
typedef unsigned int VOS_UINTPTR;
typedef unsigned int VOS_PID;
typedef unsigned char VOS_UINT8;
typedef char VOS_CHAR;
typedef int HTIMER;
#define VOS_VOID void
`;

describe('Fix B — parenthesized_declarator function-pointer typedef / field naming', () => {
  it('`typedef TYPE (*NAME)(...)` (no prefix macro) is named NAME, not *NAME', () => {
    const result = extractFromSource(
      'test.h',
      `${HEAD}typedef VOS_BOOL (*V1_NoSafe_FnPtr)(VOS_VOID);
typedef VOS_BOOL V6_PlainFunc(VOS_VOID);`,
    );
    const aliases = namesOf(result, 'type_alias');
    expect(aliases).toContain('V1_NoSafe_FnPtr');
    expect(aliases).toContain('V6_PlainFunc');
    // Pre-fix bug: name was `*V1_NoSafe_FnPtr`.
    expect(aliases.some((n) => n.startsWith('*'))).toBe(false);
  });

  it('struct function-pointer field is named cleanly, not `(*field)`', () => {
    const result = extractFromSource(
      'test.h',
      `${HEAD}typedef struct {
  VOS_UINT32 (*g_TR_FnltlmOspfMsgInit)(VOS_VOID);
  VOS_UINT32 (*g_TR_FnLtlmMtnTlvInit)(VOS_VOID);
} TLM_MODE_FUNC_LIST_LTLM_OSPF_MTN_STRUCT;`,
    );
    const methods = namesOf(result, 'method');
    expect(methods).toContain('g_TR_FnltlmOspfMsgInit');
    expect(methods).toContain('g_TR_FnLtlmMtnTlvInit');
    expect(methods.some((n) => n.startsWith('(*'))).toBe(false);
    expect(namesOf(result, 'struct')).toContain('TLM_MODE_FUNC_LIST_LTLM_OSPF_MTN_STRUCT');
  });
});

describe('Fix A — blank bodyless object-like prefix macros (SAFE/BORROW)', () => {
  // Bodyless macros collected project-wide by ensureGlobalMacroNames; passed
  // as the 6th arg to simulate a full-build macro set.
  const bodyless = new Set(['SAFE', 'BORROW']);
  const macros = new Set(['SAFE', 'BORROW', 'VOS_VOID', 'VOS_UINT32', 'VOS_BOOL']);

  it('`typedef SAFE TYPE (*NAME)(...)` is named NAME, with no bogus SAFE type_alias', () => {
    const result = extractFromSource(
      'test.h',
      `${HEAD}typedef SAFE VOS_BOOL (*CDhcpIsTailDhcpEstablish)(VOS_VOID);
typedef SAFE VOS_UINT32 (*LDEV_GET_SFP_ELBL_FUNC)(VOS_UINT32 ulSfpGpp, VOS_CHAR* BORROW pcELbl);`,
      undefined,
      undefined,
      macros,
      bodyless,
    );
    const aliases = namesOf(result, 'type_alias');
    expect(aliases).toContain('CDhcpIsTailDhcpEstablish');
    expect(aliases).toContain('LDEV_GET_SFP_ELBL_FUNC');
    // Pre-fix: bogus `SAFE` type_alias node + mangled `VOS_BOOL (*CDhcp...)`.
    expect(aliases).not.toContain('SAFE');
    expect(aliases.some((n) => n.includes('(*'))).toBe(false);
  });

  it('`SAFE extern TYPE func(...)` still parses as a function (no regression)', () => {
    const result = extractFromSource(
      'test.h',
      `${HEAD}SAFE extern VOS_UINT32 VOS_StartRelTimer(HTIMER * BORROW relaTimerHandle, VOS_PID pid, VOS_UINT32 interval, VOS_UINT32 name, VOS_UINTPTR param, VOS_UINT8 mode);`,
      undefined,
      undefined,
      macros,
      bodyless,
    );
    expect(namesOf(result, 'function')).toContain('VOS_StartRelTimer');
  });

  it('bodyless macro inside a parameter list (`T * BORROW name`) is blanked', () => {
    // BORROW sits at parenDepth=1; blanking must NOT be gated by parenDepth.
    const result = extractFromSource(
      'test.h',
      `${HEAD}typedef SAFE VOS_UINT32 (*LDEV_GET_SFP_ELBL_FUNC)(VOS_UINT32 ulSfpGpp, VOS_CHAR* BORROW pcELbl);`,
      undefined,
      undefined,
      macros,
      bodyless,
    );
    expect(namesOf(result, 'type_alias')).toContain('LDEV_GET_SFP_ELBL_FUNC');
  });
});

describe('Fix C — full-build macro pollution does not炸 TYPE (*name)(params)', () => {
  // Simulate a project-wide `#define VOS_UINT32 ...` (object-like, with body) that
  // pollutes globalMacroNames. Without Fix C, the struct function-pointer field
  // `VOS_UINT32 (*cb)(VOS_VOID)` gets `0;`-replaced and the whole struct typedef
  // vanishes ("small module works, full build returns nothing").
  const polluted = new Set(['VOS_UINT32', 'VOS_BOOL', 'VOS_VOID', 'SAFE', 'BORROW']);
  const bodyless = new Set(['SAFE', 'BORROW']);

  it('struct with function-pointer fields survives a same-named global #define', () => {
    const result = extractFromSource(
      'test.h',
      `${HEAD}typedef struct {
  VOS_UINT32 (*g_TR_FnltlmOspfMsgInit)(VOS_VOID);
  VOS_UINT32 (*g_TR_FnLtlmMtnTlvInit)(VOS_VOID);
} TLM_MODE_FUNC_LIST_LTLM_OSPF_MTN_STRUCT;`,
      undefined,
      undefined,
      polluted,
      bodyless,
    );
    expect(namesOf(result, 'struct')).toContain('TLM_MODE_FUNC_LIST_LTLM_OSPF_MTN_STRUCT');
    const methods = namesOf(result, 'method');
    expect(methods).toContain('g_TR_FnltlmOspfMsgInit');
    expect(methods).toContain('g_TR_FnLtlmMtnTlvInit');
  });

  it('function-pointer typedef survives a same-named global #define', () => {
    const result = extractFromSource(
      'test.h',
      `${HEAD}typedef SAFE VOS_BOOL (*CDhcpIsTailDhcpEstablish)(VOS_VOID);`,
      undefined,
      undefined,
      polluted,
      bodyless,
    );
    expect(namesOf(result, 'type_alias')).toContain('CDhcpIsTailDhcpEstablish');
  });

  it('non-function-pointer declaration `TYPE func(...)` still works (Guard 2b path intact)', () => {
    // Fix C's `nextTok === '('` guard must not regress the existing return-type
    // handling for a plain function declaration.
    const result = extractFromSource(
      'test.h',
      `${HEAD}VOS_UINT32 my_plain_func(VOS_PID pid, VOS_UINT32 interval);`,
      undefined,
      undefined,
      polluted,
      bodyless,
    );
    expect(namesOf(result, 'function')).toContain('my_plain_func');
  });

  it('node count is stable — no ERROR-driven explosion from the pollution', () => {
    const result = extractFromSource(
      'test.h',
      `${HEAD}typedef struct {
  VOS_UINT32 (*g_TR_FnltlmOspfMsgInit)(VOS_VOID);
  VOS_UINT32 (*g_TR_FnLtlmMtnTlvInit)(VOS_VOID);
} TLM_MODE_FUNC_LIST_LTLM_OSPF_MTN_STRUCT;`,
      undefined,
      undefined,
      polluted,
      bodyless,
    );
    // 1 file + 8 typedefs/macros in HEAD + 1 struct + 2 methods ≈ small. No flood.
    expect(result.nodes.length).toBeLessThan(40);
    expect(result.nodes.every((n) => n.name !== undefined)).toBe(true);
  });
});