#!/usr/bin/env node
// 链路分解探针：在真实 oceanbase 库上分解 callers 的每一步耗时。
//   A. import CodeGraph 模块
//   B. CodeGraph.open()
//   C. searchNodes(sym, {limit:50})         — callers 实际调用（不带 exact，FTS 优先）
//   D. searchNodes(mid-substring)           — FTS 不命中 → LIKE 全表扫描
//   E. searchNodes(nonexistent)             — FTS+LIKE 都不命中 → fuzzy（DISTINCT name 全扫）
//   F. searchNodes(sym, {limit:50, exact:true}) — query 命令路径（索引）
//   G. getDirectRelationshipGroups          — callers 的遍历步骤
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CodeGraph = require('../../dist/index.js').default;

const PROJECT = process.argv[2] || 'D:/c_proj/oceanbase';

const t = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
  return r;
};

console.log('--- A. module import ---');
const cg = await t('B. CodeGraph.open()', () => CodeGraph.open(PROJECT));

const sym = 'to_string';            // 库里真实存在，FTS 可命中
const midSub = 'SQLSession';        // ObSQLSessionInfo 的中间子串：FTS 前缀不命中，LIKE 命中
const noexist = 'SQLSessionXyzq';   // 不存在：FTS/LIKE 均不命中 → fuzzy

console.log(`\n--- searchNodes 链路（sym=${sym}） ---`);
const m1 = await t('C. searchNodes(sym, {limit:50})  [FTS 命中]', () =>
  cg.searchNodes(sym, { limit: 50 }));
console.log(`   -> ${m1.length} hits, top=${m1[0]?.node.name}`);

await t('C2. searchNodes(sym) again  [warm]', () =>
  cg.searchNodes(sym, { limit: 50 }));

const m4 = await t('F. searchNodes(sym, {exact:true})  [query 路径]', () =>
  cg.searchNodes(sym, { limit: 50, exact: true }));
console.log(`   -> ${m4.length} hits`);

console.log(`\n--- FTS 不命中的形态 ---`);
const m2 = await t('D. searchNodes("SQLSession")  [→LIKE 全表扫]', () =>
  cg.searchNodes(midSub, { limit: 50 }));
console.log(`   -> ${m2.length} hits, top=${m2[0]?.node.name}`);

await t('D2. 同查询再来一次 [warm]', () =>
  cg.searchNodes(midSub, { limit: 50 }));

const m3 = await t('E. searchNodes("SQLSessionXyzq")  [→fuzzy DISTINCT 全扫]', () =>
  cg.searchNodes(noexist, { limit: 50 }));
console.log(`   -> ${m3.length} hits`);

await t('E2. 同查询再来一次 [warm]', () =>
  cg.searchNodes(noexist, { limit: 50 }));

console.log(`\n--- callers 遍历步骤 ---`);
if (m1.length > 0) {
  await t('G. getDirectRelationshipGroups(top-1, incoming)', () =>
    cg.getDirectRelationshipGroups(m1[0].node.id, 'incoming'));
  // callers CLI 对最多 50 个 match 逐个调用；对 to_string 这类高频重载名
  // 取前几个 exact match 实测
  const exactMatches = m1.filter(m => m.node.name === sym).slice(0, 10);
  await t(`G2. 遍历 ${exactMatches.length} 个 exact match`, () => {
    for (const m of exactMatches) cg.getDirectRelationshipGroups(m.node.id, 'incoming');
  });
}

cg.destroy();