#!/usr/bin/env node
// 诊断探针：callers/callees/impact 的 searchNodes(symbol, {limit:50})（不带 exact）
// 与 query 命令的 searchNodes(symbol, {exact:true}) 在大库上的 SQL 级成本对比。
// 只读打开，不触碰写入路径。
import { DatabaseSync } from 'node:sqlite';

const DB = process.argv[2] || 'D:/c_proj/oceanbase/.codegraph/codegraph.db';

const t = (label, fn) => {
  const t0 = performance.now();
  const r = fn();
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`${label}: ${ms} ms`);
  return r;
};

const db = new DatabaseSync(DB, { readOnly: true });

const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all().map(r => r.name);
console.log('tables:', tables.join(', '));
console.log('has nodes_fts:', tables.includes('nodes_fts'));

const { c: nodeCount } = t('count(*) nodes', () =>
  db.prepare('SELECT count(*) c FROM nodes').get());
console.log('nodes rows:', nodeCount.toLocaleString());

// 挑真实符号：库里真实存在的 method/function 名，覆盖短名与长名
const pickSym = db.prepare(
  "SELECT name, count(*) c FROM nodes WHERE kind IN ('function','method') AND length(name) BETWEEN 8 AND 30 GROUP BY name ORDER BY c DESC LIMIT 3"
).all();
const symbols = pickSym.map(r => r.name);
console.log('probe symbols:', JSON.stringify(pickSym));

for (const sym of symbols) {
  console.log(`\n=== ${sym} ===`);
  const eq = t('  name = ? (index)', () =>
    db.prepare('SELECT count(*) c FROM nodes WHERE name = ?').get(sym));
  console.log('  exact hits:', eq.c);
  t('  name LIKE ? (full scan)', () =>
    db.prepare('SELECT count(*) c FROM nodes WHERE name LIKE ?').get(`%${sym}%`));
  t('  name LIKE ? (2nd, warm)', () =>
    db.prepare('SELECT count(*) c FROM nodes WHERE name LIKE ?').get(`%${sym}%`));
  try {
    const fts = t('  nodes_fts MATCH "sym"*', () =>
      db.prepare('SELECT count(*) c FROM nodes_fts WHERE nodes_fts MATCH ?').get(`"${sym}"*`));
    console.log('  fts hits:', fts.c);
  } catch (e) {
    console.log('  fts MATCH failed:', e.message);
  }
}
db.close();