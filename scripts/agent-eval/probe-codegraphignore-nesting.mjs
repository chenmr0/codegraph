#!/usr/bin/env node
// 端到端实测 .codegraphignore 的「根目录排除 + 嵌套多级白名单」语义。
// 目录结构（tmp 全新项目，非 git 仓 → 文件系统 walk 路径；含 ! 规则也强制 walk）：
//   hert_bbu/bbu/api/api.cpp      ← 想唯一保留的子树
//   hert_bbu/bbu/bbu_other.cpp
//   hert_bbu/hert_top.cpp
//   src/main.cpp
//   README.md                     （非源码文件，不参与）
// 分别测试两种写法：
//   A. 用户的原始写法：/*  +  !/hert_bbu/bbu/api/
//   B. gitignore 标准逐级放行写法
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'D:/python_code/codegraph/dist/bin/codegraph.js';
const run = (args, cwd) => execSync(`node "${CLI}" ${args}`, { cwd, encoding: 'utf-8' });

const makeProject = () => {
  const root = mkdtempSync(join(tmpdir(), 'cgi-'));
  for (const [dir, file] of [
    ['hert_bbu/bbu/api', 'api.cpp'],
    ['hert_bbu/bbu', 'bbu_other.cpp'],
    ['hert_bbu', 'hert_top.cpp'],
    ['src', 'main.cpp'],
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, file), `int ${file.replace(/\W/g, '_')}() { return 0; }\n`);
  }
  writeFileSync(join(root, 'README.md'), '# x\n');
  return root;
};

const scenarios = [
  {
    name: 'A. 原始写法 /* + !/hert_bbu/bbu/api/',
    patterns: '/*\n!/hert_bbu/bbu/api/\n',
  },
  {
    name: 'B. 逐级放行写法',
    patterns: [
      '/*',
      '!/hert_bbu/',
      '/hert_bbu/*',
      '!/hert_bbu/bbu/',
      '/hert_bbu/bbu/*',
      '!/hert_bbu/bbu/api/',
    ].join('\n'),
  },
];

for (const sc of scenarios) {
  const root = makeProject();
  try {
    writeFileSync(join(root, '.codegraphignore'), sc.patterns);
    run(`init "${root}"`, root);
    let out = '';
    try {
      out = run(`files -p "${root}" --format flat`, root);
    } catch (e) {
      out = '(files 失败) ' + e.message;
    }
    const indexed = out.split(/\r?\n/).filter(l => l.trim() && !l.includes('indexed') && !l.includes('files'));
    console.log(`\n=== ${sc.name} ===`);
    console.log(sc.patterns.split('\n').map(l => '    |' + l).join('\n'));
    console.log(`  索引到 ${indexed.length} 个文件:`);
    for (const f of indexed) console.log('   ', f.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 对照：ignore 包版本
console.log('\nignore 包版本:', JSON.parse(readFileSync('D:/python_code/codegraph/node_modules/ignore/package.json', 'utf-8')).version);

// ---- 场景 C/D：`/*`（无否定规则）在 git 仓 vs 非 git 仓的行为是否一致 ----
// git 快路径对 ls-files 列出的完整路径做纯匹配（/* 只匹配第一层段）；
// walk 路径目录命中即剪枝。理论上两者对 /* 的行为会不同——验证。
const makeTree = () => {
  const root = mkdtempSync(join(tmpdir(), 'cgi2-'));
  for (const [dir, file] of [
    ['.', 'main.cpp'],                  // 根层散文件
    ['src', 'main.cpp'],                // 一层子目录
    ['hert_bbu/bbu/api', 'api.cpp'],    // 深层嵌套
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, file), `int f() { return 0; }\n`);
  }
  return root;
};

for (const [name, git] of [
  ['C. git 仓 + /*（git 快路径，纯匹配）', true],
  ['D. 非 git 仓 + /*（walk，目录剪枝）', false],
]) {
  const root = makeTree();
  try {
    writeFileSync(join(root, '.codegraphignore'), '/*\n');
    if (git) {
      execSync('git init -q && git add -A', { cwd: root, encoding: 'utf-8' });
    }
    run(`init "${root}"`, root);
    const out = run(`files -p "${root}" --format flat`, root);
    const kept = out.split(/\r?\n/)
      .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter(l => /\.(cpp|ts|py|h|hpp)$/.test(l));
    console.log(`\n=== ${name} ===`);
    console.log(`  索引保留 ${kept.length} 个: ${kept.join(' | ') || '(无)'}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}