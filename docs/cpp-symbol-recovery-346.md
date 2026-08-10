# C/C++ 346 个符号漏失样本归因与修复

## 口径

- 真值：OceanBase `ground_truth_5000.json` 中、clangd 给出且 CodeGraph 已定义目标节点类型的 3106 个符号。
- 原始命中：2760/3106（88.86%）。
- 漏失集：346 个；判定条件为名称精确一致、同文件、起始行允许 ±3 行。
- 本文结果是对固定漏失文件的提取回放，不等价于全库重建后的独立盲测。

## 完整归因

| 原始归因 | 数量 | 修复后找回 | 结论 |
|---|---:|---:|---|
| 声明型宏展开符号 | 264 | 257 | 剩余 7 个均为 clangd 将模板类型引用误报为 variable |
| 匿名类型 | 16 | 16 | 匿名 struct/union/enum 全部恢复 |
| 模板声明 | 17 | 13 | 剩余 4 个均为 `::type`/type-trait 类型引用误报 |
| 宏或生成符号 | 6 | 6 | 全部恢复 |
| 位置/来源不明 | 4 | 4 | 全部恢复 |
| 构造/析构 | 5 | 5 | 全部恢复 |
| 源码拼写但 AST 丢失 | 13 | 12 | 剩余 1 个是宏调用名 `DEFINE_TO_YSON_KV`；真实生成方法 `to_yson` 已恢复 |
| 普通变量声明 | 21 | 20 | 剩余 1 个是 X-macro 调用名 `PCODE_DEF`，不是 variable |

按节点类别：class/struct 94/94、method 123/123、field 39/39、constant 43/43、enum 3/3、function 8/9、variable 23/35。function 的 1 个和 variable 的 12 个均为真值污染，不应合成同名假节点。

## 修复后的固定样本结果

- 原始含噪口径：3093/3106 = **99.58%**。
- 剔除 13 个已逐项确认的 clangd 错分类/宏调用名：3093/3093 = **100%**。
- 相对原始结果实际新增找回：333 个。

13 个非目标符号为：

- `ob_meta_copy.h` 中 11 个模板表达式类型引用：`ObIAllocator`、`::type`、`std::is_move_assignable`；源码位置没有相应变量声明。
- `ob_rpc_packet_list.h` 的 `PCODE_DEF`：X-macro 调用名；实际符号由不同 include 上下文生成。
- `ob_tenant_role.cpp` 的 `DEFINE_TO_YSON_KV`：宏调用名；实际生成的 `ObTenantRole::to_yson` 已被索引。

## 通用修复模式

1. 实现保守的项目级声明宏恢复：仅使用无歧义宏定义，仅在声明作用域展开，保留调用行定位，不合并调用/引用边。
2. 补齐标准宏实参规则：普通实参先展开，`#`/`##` 使用原始实参；支持递归、变参、字符串化、token paste 和多层辅助宏。
3. 将宏体行注释安全折叠，避免多声明宏压成一行后被 `//` 吞掉。
4. 对已损坏文件增加“宏调用行隔离解析”兜底，并限制只补全缺失的变量或限定方法。
5. 识别匿名 struct/union/enum，补齐 union body 遍历与 typedef 匿名类型。
6. 补齐模板前向声明、成员模板原型、显式模板实例化及模板参数中 `::` 的正确消歧。
7. 将函数指针/成员函数指针声明为 field，而不是 method；内联类型后的尾随字段使用完整声明范围。
8. 对错误 AST 吞掉的源码限定方法定义做窄范围恢复；要求限定名、平衡参数和真实函数体，避免把调用识别为定义。
9. 支持 `.hh`、`.ipp`、`.inl`、`.tcc` 等常见 C++ 源文件/宏定义载体。

以上规则均基于 C/C++ 语法或预处理器语义，不包含 OceanBase 路径、类名或宏名特判。

## 复现

归因脚本：

```text
node scripts/analyze-clangd-misses.mjs \
  --gt <ground_truth_5000.json> \
  --db <codegraph.db> \
  --source-root <project-root> \
  --out <analysis.json>
```

关键回归测试：

```text
npx vitest run __tests__/cpp-declaration-macros.test.ts __tests__/cpp-generic-symbol-recovery.test.ts
```
