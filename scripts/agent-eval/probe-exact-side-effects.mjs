#!/usr/bin/env node
// exact:true 的负面影响实测：对每个"可能变差"的场景，跑 exact / no-exact 两种模式对比。
//  A. 距离1的 typo（no-exact 的 fuzzy 应能救回，exact 应返回 0）
//  B. 大小写变体（no-exact 的 FTS 大小写不敏感能命中，exact 应返回 0）
//  C. 多级限定名 a::b::c（验证 exact 的 tail 枚举不漏）
//  D. 海量重载名的 impact 复刻（exact 的遍历起点更多 → 是否反而更慢）
//  E. 同名节点数 top（exact 无 SQL LIMIT 全量枚举的内存峰值论证）
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
const require = createRequire(import.meta.url);
const CodeGraph = require('../../dist/index.js').default;

const PROJECT = 'D:/c_proj/oceanbase';
const t = (label, fn) => {
  const t0 = performance.now();
  const r = fn();
  console.log(`${label}: ${(performance.now() - t0).toFixed(0)} ms`);
  return r;
};

const cg = await CodeGraph.open(PROJECT);
const both = (label, query) => {
  const a = cg.searchNodes(query, { limit: 50 });
  const b = cg.searchNodes(query, { limit: 50, exact: true });
  const names = (r) => r.length + ' hits, top=' + (r[0]?.node.qualifiedName ?? r[0]?.node.name ?? '(无)');
  console.log(`${label} [no-exact]: ${names(a)}`);
  console.log(`${label} [exact  ]: ${names(b)}`);
  return [a, b];
};

console.log('--- A. 距离1 typo ---');
both('A. "to_strng"        ', 'to_strng');

console.log('\n--- B. 大小写变体 ---');
both('B. "TO_STRing"        ', 'TO_STRing');

console.log('\n--- C. 多级限定名 ---');
const raw = new DatabaseSync(PROJECT + '/.codegraph/codegraph.db', { readOnly: true });
const multi = raw.prepare(
  "SELECT qualified_name FROM nodes WHERE qualified_name LIKE '%::%::%' AND kind='method' AND length(qualified_name) < 50 LIMIT 1"
).all();
raw.close();
if (multi[0]) {
  const q = multi[0].qualified_name;
  const [a, b] = both(`C. "${q}"`, q);
  const hit = (r) => r.filter(m => m.node.qualifiedName === q).length;
  console.log(`   全限定精确命中: no-exact ${hit(a)} / exact ${hit(b)}`);
}

console.log('\n--- D. impact 复刻（to_string，depth 2）---');
// 复刻 CLI impact 的循环：拉 matches → exactMatch 过滤（no-exact 路径）→ 逐节点 getImpactRadius
const sym = 'to_string';
const mkMatches = (exact) => cg.searchNodes(sym, { limit: 50, ...(exact ? { exact: true } : {}) });
const cliFilter = (ms) => {
  const kept = ms.filter(m => m.node.name === sym || m.node.name.endsWith('.' + sym) || m.node.name.endsWith('::' + sym));
  return (kept.length > 0 ? kept : ms.slice(0, 1));
};
for (const [label, exact] of [['no-exact', false], ['exact  ', true]]) {
  const ms = mkMatches(exact);
  const targets = cliFilter(ms);
  console.log(`   ${label}: matches=${ms.length}, CLI 过滤后遍历起点=${targets.length}`);
  t(`   ${label} impact 遍历`, () => {
    let n = 0;
    for (const m of targets) { const r = cg.getImpactRadius(m.node.id, 2); n += r.nodes.size; }
    console.log(`      (累计 impact 节点 ${n})`);
  });
}

console.log('\n--- E. 同名节点数 top5 ---');
const raw2 = new DatabaseSync(PROJECT + '/.codegraph/codegraph.db', { readOnly: true });
for (const r of raw2.prepare('SELECT name, count(*) c FROM nodes GROUP BY name ORDER BY c DESC LIMIT 5').all()) {
  console.log(`   ${String(r.c).padStart(6)} × ${r.name}`);
}
raw2.close();
cg.destroy();