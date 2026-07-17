/**
 * 回归：返回类型为 #define 宏 + 参数含 `* BORROW` 形参时函数定义丢失
 *
 * 真实电信基带代码中大量函数形如：
 *   SAFE RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 LTOP_GetCpriStatus(DEV_X* BORROW pstPortId, ...)
 *
 * 丢失由两个因素叠加触发：
 *   1. 返回类型是一个 #define 宏（VOS_UINT32），preprocessStatementMacros 把它替换成 0;，
 *      使函数失去返回类型锚点——tree-sitter-c 需要一个返回类型 token 才能把
 *      `funcname(params){}` 识别为 function_definition。
 *   2. 参数里 `int* BORROW x` 在 `*` 与形参名之间多了一个标识符，参数列表畸形，
 *      使 tree-sitter 无法用"隐式 int 返回"的旧式函数形式兜底识别。
 *
 * 守卫 2b 保留被 `funcname(` 紧跟的宏返回类型作为锚点（修复第 1 点），从而让
 * tree-sitter 容忍第 2 点的畸形参数。本用例固化该修复，防止回归。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('macro return type + BORROW pointer param does not lose function', () => {

  // 模拟用户代码中的宏：SAFE / RRE_ATTRIBUTE_VISIBILITY / BORROW 为空宏（存储类/属性），
  // VOS_UINT32 / VOS_BOOL 为类型宏，VOS_FALSE / VOS_NULL_LONG / VOS_NULL_PTR 为常量宏。
  const macroNames = new Set([
    'SAFE',
    'RRE_ATTRIBUTE_VISIBILITY',
    'BORROW',
    'VOS_UINT32',
    'VOS_BOOL',
    'VOS_NULL_LONG',
    'VOS_NULL_PTR',
    'VOS_FALSE',
  ]);

  it('VOS_UINT32 return + BORROW pointer params → function found', () => {
    const source = `
SAFE RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 LTOP_GetCpriStatus(int* BORROW pstPortId, int* BORROW pbConfig)
{
    return 0;
}
`;
    const result = extractFromSource('test.c', source, undefined, undefined, macroNames);
    const fn = result.nodes.find(n => n.kind === 'function' && n.name === 'LTOP_GetCpriStatus');
    expect(fn).toBeDefined();
  });

  it('VOS_BOOL return + no params → function found', () => {
    const source = `
SAFE RRE_ATTRIBUTE_VISIBILITY VOS_BOOL cdevpxyMptWillReboot(VOS_VOID)
{
    return VOS_FALSE;
}
`;
    const result = extractFromSource('test.c', source, undefined, undefined, macroNames);
    const fn = result.nodes.find(n => n.kind === 'function' && n.name === 'cdevpxyMptWillReboot');
    expect(fn).toBeDefined();
  });

  it('VOS_VOID return (typedef, NOT in macroNames) → function found', () => {
    const source = `
SAFE RRE_ATTRIBUTE_VISIBILITY VOS_VOID cdevpxySetCbusResetTaskId(int status)
{
    int x = status;
}
`;
    const result = extractFromSource('test.c', source, undefined, undefined, macroNames);
    const fn = result.nodes.find(n => n.kind === 'function' && n.name === 'cdevpxySetCbusResetTaskId');
    expect(fn).toBeDefined();
  });

  it('VOS_UINT32 return, no SAFE/RRE_ATTR prefix, BORROW pointer param → function found', () => {
    const source = `
VOS_UINT32 LDEV_GetBoardType(int* BORROW pulBoardType)
{
    return 0;
}
`;
    const result = extractFromSource('test.c', source, undefined, undefined, macroNames);
    const fn = result.nodes.find(n => n.kind === 'function' && n.name === 'LDEV_GetBoardType');
    expect(fn).toBeDefined();
  });

  it('all functions and globals together in one file → all found, no spurious nodes', () => {
    const source = `
SAFE RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 LTOP_GetCpriStatus(int* BORROW pstPortId, int* BORROW pbConfig)
{
    return 0;
}

SAFE RRE_ATTRIBUTE_VISIBILITY VOS_VOID LDEV_RegPreHwTstFunc(int pfnPreProc)
{
    int x = 0;
}

SAFE RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 LDEV_GetBoardType(int* BORROW pulBoardType)
{
    return 0;
}

SAFE RRE_ATTRIBUTE_VISIBILITY VOS_UINT32 LDEV_RegClientRegisterInfoCallback(int pfn)
{
    return 0;
}

int g_LDEVPXY_neNameInfo;
VOS_UINT32 g_CDEV_ulSlaveBbuSubrackSrn = VOS_NULL_LONG;

SAFE RRE_ATTRIBUTE_VISIBILITY VOS_VOID cdevpxySetCbusResetTaskId(int status)
{
    int x = status;
}

SAFE RRE_ATTRIBUTE_VISIBILITY VOS_BOOL cdevpxyMptWillReboot(VOS_VOID)
{
    return VOS_FALSE;
}

int g_LDEV_stHeiChannelUsed;
VOS_BOOL g_DDEVPXY_bLocalStable = VOS_FALSE;
`;
    const result = extractFromSource('test.c', source, undefined, undefined, macroNames);

    const fnNames = result.nodes.filter(n => n.kind === 'function').map(n => n.name);
    const varNames = result.nodes.filter(n => n.kind === 'variable').map(n => n.name);

    const expectedFns = [
      'LTOP_GetCpriStatus',
      'LDEV_RegPreHwTstFunc',
      'LDEV_GetBoardType',
      'LDEV_RegClientRegisterInfoCallback',
      'cdevpxySetCbusResetTaskId',
      'cdevpxyMptWillReboot',
    ];
    const expectedVars = [
      'g_LDEVPXY_neNameInfo',
      'g_CDEV_ulSlaveBbuSubrackSrn',
      'g_LDEV_stHeiChannelUsed',
      'g_DDEVPXY_bLocalStable',
    ];

    for (const name of expectedFns) {
      expect(fnNames, `function ${name} should be indexed`).toContain(name);
    }
    for (const name of expectedVars) {
      expect(varNames, `variable ${name} should be indexed`).toContain(name);
    }

    // 精度：存储类/属性宏（SAFE / RRE_ATTRIBUTE_VISIBILITY）被替换成 0; 后
    // 不应残留为虚假变量节点。
    expect(varNames).not.toContain('SAFE');
    expect(varNames).not.toContain('RRE_ATTRIBUTE_VISIBILITY');
  });
});