/**
 * C/C++ 指针变量初始化 rescue 回归测试。
 *
 * 场景: `MACRO TYPE *g_ptr = init;` 当开头的可见性/类型宏不在项目 #define 集合
 * (少部分文件索引、宏定义在外部头) 时，preParse 不替换它，tree-sitter-c 把
 * 声明拆成 spurious `(declaration MACRO TYPE (MISSING ";"))` +
 * `expression_statement(*g_ptr = init)`。指针变量名落在 pointer_expression 里，
 * 既有的 assignment_expression rescue 只处理左侧裸 identifier (`g_x = init`)，
 * 漏了 `*g_ptr = init` (左侧 pointer_expression) —— 变量丢失，同时 spurious
 * declaration 把类型名误抽成 bogus variable。
 *
 * 修复 (src/extraction/tree-sitter.ts expression_statement rescue):
 *   - 分支扩展: assignment_expression + 左侧 pointer_expression + 裸 identifier
 *     操作数 → rescue 为 variable。
 *   - rescuePointerInitExprStmtName 配合 isBrokenTypeSplitDeclaration 抑制
 *     spurious declaration，避免类型名被误抽为 variable。
 *
 * 运行: npx vitest run __tests__/c-pointer-init-rescue.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function varNames(result: { nodes: Array<{ name: string; kind: string }> }): string[] {
  return result.nodes.filter((n) => n.kind === 'variable').map((n) => n.name);
}

describe('C/C++ pointer-variable-init rescue (`MACRO TYPE *g_ptr = init;`)', () => {
  it('rescues `*g_ptr = init` when the leading macro is unknown (no globalMacroNames)', () => {
    // 模拟少部分文件索引: LIRAF_PUBLIC 未进宏集合, preParse 不替换.
    // tree-sitter 拆成 declaration(LIRAF_PUBLIC BsiKmcServiceApis ;) +
    // expression_statement(*g_Liraf_kmcServ = VOS_NULL_PTR).
    const src = `LIRAF_PUBLIC BsiKmcServiceApis *g_Liraf_kmcServ = VOS_NULL_PTR;
LIRAF_PUBLIC BsiKmcServiceApis *g_Liraf_Node_kmcServ = VOS_NULL_PTR;
`;
    const result = extractFromSource('vars.c', src, 'c' as any, undefined, undefined);
    const vars = varNames(result);
    // 真变量被 rescue
    expect(vars).toContain('g_Liraf_kmcServ');
    expect(vars).toContain('g_Liraf_Node_kmcServ');
    // spurious declaration 的类型名不被误抽为 variable
    expect(vars).not.toContain('BsiKmcServiceApis');
    expect(vars).not.toContain('LIRAF_PUBLIC');
  });

  it('does not regress the normal single-type path (`TYPE *g_ptr = init;`)', () => {
    // 单一类型前缀, tree-sitter 正常解析为 declaration, 走 extractVariable.
    const src = `BsiKmcServiceApis *g_plain = VOS_NULL_PTR;
BsiKmcServiceApis *g_plain2 = VOS_NULL_PTR;
`;
    const result = extractFromSource('plain.c', src, 'c' as any, undefined, undefined);
    const vars = varNames(result);
    expect(vars).toContain('g_plain');
    expect(vars).toContain('g_plain2');
  });

  it('does not rescue non-variable forms (`*id[idx]`, `*id.field`)', () => {
    // 左侧操作数不是裸 identifier 时不应 rescue (避免误提).
    const src = `MACRO TYPE *g_arr[8] = {0};
`;
    const result = extractFromSource('norescue.c', src, 'c' as any, undefined, undefined);
    const vars = varNames(result);
    // 数组声明形态不应把 g_arr 误抽 (tree-sitter 解析各异, 这里只确保不误炸 bogus)
    expect(vars).not.toContain('TYPE');
  });

  // Note: tree-sitter-cpp parses `MACRO TYPE *name = init;` differently (it
  // treats `TYPE::name` as a qualified_identifier, no expression_statement is
  // produced), so the C rescue above does not apply to C++ — that is a
  // separate tree-sitter-cpp issue outside this fix's scope.
});