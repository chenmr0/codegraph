// 复现: 整仓构建后 crsp 模块 LdapApiGetTestVersion NOT FOUND。
// 真实定义(用户确认): `#define LDAP_CONST const` 与 `typedef char LDAP_CHAR;`
// 都在被 #include 的 ldap_types.h 里。tree-sitter 不解析 #include, crsp/ldap_api.h
// 孤立解析。当 ldap_types.h 未被本次索引(如 platform+10 模块未纳入该头)时,
// `#define LDAP_CONST const` 不进 globalMacroNames, preprocessStatementMacros
// 不替换 LDAP_CONST, 保留双标识符 `LDAP_CONST LDAP_CHAR *name(void);`。
// tree-sitter-c 把它劈裂成:
//   (declaration type:(type_identifier) declarator:(identifier) (MISSING ";"))
//   (expression_statement (pointer_expression (call_expression name args)))
// 函数名落进 call_expression -> 不产生 function 节点 -> 丢失; 同时 LDAP_CHAR 被
// 当成虚假 variable。
//
// 修复(src/extraction/tree-sitter.ts):
//   主方案 — expression_statement 分支识别 pointer_expression(call_expression)
//            形态, 配合前一个被劈裂的 declaration, 重建函数声明节点。
//   加固   — variableTypes 分支跳过被劈裂的虚假 declaration, 不再产出虚假变量。
//
// 运行: npx vitest run __tests__/eval-crsp-split-prototype-rescue.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

interface NodeLite { kind: string; name: string; isDeclaration?: boolean }

function extract(src: string, macroNames?: Set<string>): NodeLite[] {
  const r = extractFromSource('crsp_dev.h', src, 'c' as any, undefined, macroNames);
  return r.nodes.map(n => ({ kind: n.kind, name: n.name, isDeclaration: n.isDeclaration }));
}

function namesOf(nodes: NodeLite[]): Set<string> { return new Set(nodes.map(n => n.name)); }
function varNames(nodes: NodeLite[]): Set<string> {
  return new Set(nodes.filter(n => n.kind === 'variable').map(n => n.name));
}
function funcNames(nodes: NodeLite[]): Set<string> {
  return new Set(nodes.filter(n => n.kind === 'function').map(n => n.name));
}

describe('crsp 劈裂函数声明救援: 定义头未索引(首宏不在宏集合)', () => {
  beforeAll(async () => { await initGrammars(); await loadAllGrammars(); });

  it('主方案: `T1 T2 *name(void)` 首宏不在集合 -> 救援为函数声明', () => {
    // LDAP_CONST 不在宏集合(定义头未索引); LDAP_CHAR 是 typedef, 也不在集合。
    // 这是真实丢失场景。
    const src = `LDAP_CONST LDAP_CHAR *LdapApiGetTestVersion(void);\n`;
    const nodes = extract(src, new Set()); // 空集合, 模拟定义头未索引
    expect(funcNames(nodes).has('LdapApiGetTestVersion')).toBe(true);
    // 应标记为声明(无函数体)
    const fn = nodes.find(n => n.name === 'LdapApiGetTestVersion');
    expect(fn?.isDeclaration).toBe(true);
  });

  it('加固: 救援后不产出虚假的 LDAP_CHAR 变量', () => {
    const src = `LDAP_CONST LDAP_CHAR *LdapApiGetTestVersion(void);\n`;
    const nodes = extract(src, new Set());
    expect(varNames(nodes).has('LDAP_CHAR')).toBe(false);
    expect(varNames(nodes).has('LDAP_CONST')).toBe(false);
  });

  it('主方案: 带 static 的劈裂形态也能救援', () => {
    const src = `static LDAP_CONST LDAP_CHAR *LdapApiGetTestVersion(void);\n`;
    const nodes = extract(src, new Set());
    expect(funcNames(nodes).has('LdapApiGetTestVersion')).toBe(true);
  });

  it('对照(已能找到): 首宏在集合被替换 -> 仍找到, 且不重复产出函数', () => {
    // LDAP_CONST 在集合 -> 被 preParse 替换成 0; -> 单标识符正常解析。
    const src = `#define LDAP_CONST const\n#define LDAP_CHAR char\nLDAP_CONST LDAP_CHAR *LdapApiGetTestVersion(void);\n`;
    const nodes = extract(src, new Set(['LDAP_CONST', 'LDAP_CHAR']));
    const fns = nodes.filter(n => n.kind === 'function' && n.name === 'LdapApiGetTestVersion');
    expect(fns.length).toBe(1); // 不重复
  });

  it('对照(已能找到): 带类型参数 `*name(int x)` -> 正常函数声明, 不走救援', () => {
    const src = `LDAP_CONST LDAP_CHAR *f(int x, int y);\n`;
    const nodes = extract(src, new Set());
    expect(funcNames(nodes).has('f')).toBe(true);
  });

  it('防误触发: 变量 `static T1 T2 *g[] = {}` 仍是变量, 不被当成函数', () => {
    const src = `static LDAP_CONST LDAP_UINT8 *g_pucDbgLvl[] = {\n};\n`;
    const nodes = extract(src, new Set());
    expect(varNames(nodes).has('g_pucDbgLvl')).toBe(true);
    expect(funcNames(nodes).has('g_pucDbgLvl')).toBe(false);
  });

  it('防误触发: 语句宏 `MYMACRO(x);` 不被当成函数', () => {
    // 没有 pointer_expression 包裹, 不命中救援; 也不应产出名为 MYMACRO 的函数。
    const src = `MYMACRO(x);\n`;
    const nodes = extract(src, new Set());
    expect(funcNames(nodes).has('MYMACRO')).toBe(false);
  });

  it('防误触发: 裸 `*foo(1);` 无前驱劈裂 declaration -> 不救援', () => {
    const src = `*foo(1);\n`;
    const nodes = extract(src, new Set());
    expect(funcNames(nodes).has('foo')).toBe(false);
  });

  it('端到端矩阵: 多形态同文件, 救援与既有行为并存', () => {
    const src = `
LDAP_CONST LDAP_CHAR *LdapApiGetTestVersion(void);
LDAP_INT32 LdapGetStrtTxnMsgId(LDAP_IN LDAP_UINT32 uiTxnId);
LDAP_VOID LdapApiClntDestroyTls(void);
static LDAP_CONST LDAP_UINT8 *g_pucDbgLvl[] = {
};
`;
    const nodes = extract(src, new Set()); // 全部定义头未索引
    const fns = funcNames(nodes);
    const vars = varNames(nodes);
    expect(fns.has('LdapApiGetTestVersion')).toBe(true);   // 救援
    expect(fns.has('LdapGetStrtTxnMsgId')).toBe(true);      // 单标识符+宏参数, 既有
    expect(fns.has('LdapApiClntDestroyTls')).toBe(true);   // 单标识符, 既有
    expect(vars.has('g_pucDbgLvl')).toBe(true);            // 变量, 既有
    expect(vars.has('LDAP_CHAR')).toBe(false);             // 加固: 无虚假变量
  });
});