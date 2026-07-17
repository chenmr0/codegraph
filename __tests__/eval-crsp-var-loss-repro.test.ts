// 复现: 整仓构建后 crsp 模块部分符号 NOT FOUND（单模块/少模块构建 100%）
// 假设根因: preprocessStatementMacros 的 Guard 2b 只保护「类型宏 + 函数定义(ident+'(')」模式,
//   未保护「类型宏 + 变量声明(变量名后跟 '=' 或 ';')」模式。整仓构建时全仓宏集合含
//   #define 出来的类型宏(如 VOS_UINT32), 变量声明的类型被替换成 `0;`, 变量声明被破坏成
//   赋值表达式, 变量节点丢失。typedef 出来的类型(如 HTIMER)不在宏集合里, 不受影响。
// 运行: npx vitest run __tests__/eval-crsp-var-loss-repro.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

// 模拟 crsp 模块文件: 类型宏定义在别处头文件, 本文件只使用。
// 丢失符号(类型为 #define 宏): VOS_UINT32 / HWTST_TEST_CTRL_STRU / LDAP_CONST / LDAP_CHAR
// 能找到符号(类型为 typedef): DEV_HEI_CHANNEL_USED_INFO / HTIMER
// 变体矩阵: 覆盖各种变量声明形态, 找出整仓模式下丢失的条件
const CRSP_SRC = `
VOS_UINT32 g_b_init_lit = 0;
VOS_UINT32 g_c_init_macro = VOS_NULL_LONG;
VOS_UINT32 g_c2 = VOS_NULL_LONG;
HWTST_TEST_CTRL_STRU g_a_noinit;
VOS_UINT32 *g_d_ptr_noinit;
VOS_UINT32 *g_e_ptr_init = VOS_NULL_PTR;
VOS_UINT32 g_f_arr[8];
VOS_UINT32 g_g_multi, g_h_multi;
static VOS_UINT32 g_i_static;
const VOS_UINT32 g_j_const = 1;
VOS_UINT32 g_k_init_brace = {0};
LDAP_CONST LDAP_CHAR *LdapApiGetTestVersion(void);
VOS_UINT32 LdapApiGetVersion2(void);
#define DEV_NODE_RUNINFONAME_MAX_LEN 32
#define sendmsg(a, b, c) vrp_sendmsg(a, b, c)
#define CDEV_BBP_RUN_INFO_PRIO_MASK 0xFF
#define LDEV_BBP_CPRI_TYPE 0
`;

// 整仓构建收集到的宏名集合(模拟 platform + 10 模块扫描得到)
// VOS_UINT32 / HWTST_TEST_CTRL_STRU / LDAP_CONST / LDAP_CHAR / VOS_NULL_LONG / VOS_NULL_PTR
// 都是 #define 出来的, 进入宏集合; HTIMER / DEV_HEI_CHANNEL_USED_INFO 是 typedef, 不进集合。
const WHOLE_REPO_MACROS = new Set([
  'VOS_UINT32', 'VOS_NULL_LONG', 'VOS_NULL_PTR',
  'HWTST_TEST_CTRL_STRU',
  'LDAP_CONST', 'LDAP_CHAR',
]);

const TARGET_SYMBOLS = [
  'g_b_init_lit', 'g_c_init_macro', 'g_c2', 'g_a_noinit',
  'g_d_ptr_noinit', 'g_e_ptr_init', 'g_f_arr', 'g_g_multi', 'g_h_multi',
  'g_i_static', 'g_j_const', 'g_k_init_brace',
  'LdapApiGetTestVersion', 'LdapApiGetVersion2',
  'DEV_NODE_RUNINFONAME_MAX_LEN', 'sendmsg',
];

interface NodeLite { kind: string; name: string; isDeclaration?: boolean; startLine?: number }

function extract(macroNames?: Set<string>): NodeLite[] {
  const r = extractFromSource('crsp_dev.c', CRSP_SRC, 'c' as any, undefined, macroNames);
  return r.nodes.map(n => ({ kind: n.kind, name: n.name, isDeclaration: n.isDeclaration, startLine: n.startLine }));
}

describe('crsp 符号丢失复现: 整仓宏模式 vs 单文件无宏模式', () => {
  beforeAll(async () => { await initGrammars(); await loadAllGrammars(); });

  it('对比两种模式提取的节点', () => {
    const noMacro = extract(undefined);
    const withMacro = extract(WHOLE_REPO_MACROS);

    const lines: string[] = [];
    lines.push('\n=== [单文件无宏模式] (对应单模块构建) 全部节点 ===');
    for (const n of noMacro) lines.push(`  ${n.kind} ${n.name}${n.isDeclaration ? ' [decl]' : ''} @${n.startLine}`);
    lines.push('\n=== [整仓宏模式] (对应 platform+10模块) 全部节点 ===');
    for (const n of withMacro) lines.push(`  ${n.kind} ${n.name}${n.isDeclaration ? ' [decl]' : ''} @${n.startLine}`);

    lines.push('\n=== 目标符号在两种模式下的存在性 ===');
    const noMacroNames = new Set(noMacro.map(n => n.name));
    const withMacroNames = new Set(withMacro.map(n => n.name));
    let lostInMacro = 0;
    for (const sym of TARGET_SYMBOLS) {
      const a = noMacroNames.has(sym) ? '有' : '无';
      const b = withMacroNames.has(sym) ? '有' : '无';
      const lost = a === '有' && b === '无';
      if (lost) lostInMacro++;
      lines.push(`  ${sym.padEnd(38)} 无宏=${a}  整仓=${b}  ${lost ? '★ 整仓丢失!' : ''}`);
    }
    lines.push(`\n=== 整仓宏模式下丢失的符号数: ${lostInMacro} ===`);
    console.log(lines.join('\n'));
    expect(true).toBe(true);
  });

  it('断言: 修复后整仓宏模式下变量声明不再丢失', () => {
    const withMacro = extract(WHOLE_REPO_MACROS);
    const names = new Set(withMacro.map(n => n.name));
    // 修复前丢失的形态: 修复后应全部保留
    expect(names.has('g_a_noinit')).toBe(true);
    expect(names.has('g_f_arr')).toBe(true);
    expect(names.has('g_g_multi')).toBe(true);
    expect(names.has('g_h_multi')).toBe(true);
    expect(names.has('g_i_static')).toBe(true);
    // 对照: 修复前就在的仍应在
    expect(names.has('g_b_init_lit')).toBe(true);
    expect(names.has('g_c_init_macro')).toBe(true);
    expect(names.has('g_d_ptr_noinit')).toBe(true);
    expect(names.has('g_e_ptr_init')).toBe(true);
    expect(names.has('g_j_const')).toBe(true);
    expect(names.has('g_k_init_brace')).toBe(true);
  });
});