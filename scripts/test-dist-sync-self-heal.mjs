import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const distIndex = path.join(repoRoot, 'dist', 'index.js');
const parseWorker = path.join(repoRoot, 'dist', 'extraction', 'parse-worker.js');
const selectedCase = process.argv[2];

if (!selectedCase) {
  assert.ok(fs.existsSync(distIndex), 'dist/index.js is missing; run npm run build first');
  assert.ok(fs.existsSync(parseWorker), 'dist parse-worker.js is missing');

  for (const caseName of ['direct-index-files', 'sync-self-heal']) {
    const child = spawnSync(process.execPath, [scriptPath, caseName], {
      cwd: repoRoot,
      env: { ...process.env, CODEGRAPH_PARSE_WORKERS: '1' },
      stdio: 'inherit',
    });
    assert.equal(child.status, 0, `${caseName} failed in the dist build`);
  }

  console.log('dist single-file grammar and sync self-heal regressions passed');
  process.exit(0);
}

const requireFromDist = createRequire(distIndex);
const packageExports = requireFromDist(distIndex);
const CodeGraph = packageExports.default ?? packageExports.CodeGraph;

assert.ok(CodeGraph, 'CodeGraph export is missing from dist/index.js');

function hasCall(graph, callerName, targetName) {
  const caller = graph
    .getNodesByName(callerName)
    .find((node) => node.kind === 'function');
  const target = graph
    .getNodesByName(targetName)
    .find((node) => node.kind === 'function');
  if (!caller || !target) return false;
  return graph
    .getOutgoingEdges(caller.id)
    .some((edge) => edge.kind === 'calls' && edge.target === target.id);
}

function unresolvedTargetRefs(graph, targetName) {
  return graph.queries
    .getUnresolvedReferences()
    .filter((ref) => ref.referenceName.endsWith(targetName));
}

function waitForTimestampTick() {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

async function runDirectIndexFilesCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dist-direct-index-'));
  let graph;
  try {
    fs.writeFileSync(
      path.join(root, 'single.cpp'),
      'namespace cg_dist { int direct_index_symbol() { return 1; } }\n',
    );
    graph = await CodeGraph.init(root);
    const result = await graph.indexFiles(['single.cpp']);
    assert.equal(result.filesIndexed, 1);
    assert.equal(graph.getNodesByName('direct_index_symbol').length, 1);
  } finally {
    graph?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runSyncSelfHealCase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dist-self-heal-'));
  const defsPath = path.join(root, 'defs.h');
  let graph;

  const writeDefs = (version) => fs.writeFileSync(
    defsPath,
    `#pragma once
namespace cg_ns {
inline int cg_target_${version}(int value) { return value + 1; }
}
`,
  );
  const writeCaller = (index) => fs.writeFileSync(
    path.join(root, `caller_${index}.cpp`),
    `#include "defs.h"
int cg_caller_${index}(int value) {
  return cg_ns::cg_target_v1(value);
}
`,
  );

  try {
    writeDefs('v1');
    writeCaller(0);
    writeCaller(1);

    graph = await CodeGraph.init(root);
    await graph.indexAll();
    assert.equal(Number(hasCall(graph, 'cg_caller_0', 'cg_target_v1')), 1);
    assert.equal(Number(hasCall(graph, 'cg_caller_1', 'cg_target_v1')), 1);

    await waitForTimestampTick();
    writeDefs('v2');
    const renamed = await graph.sync({ paths: ['defs.h'] });
    assert.notEqual(renamed.complete, false);
    assert.equal(Number(hasCall(graph, 'cg_caller_0', 'cg_target_v1')), 0);
    assert.equal(Number(hasCall(graph, 'cg_caller_1', 'cg_target_v1')), 0);
    assert.equal(unresolvedTargetRefs(graph, 'cg_target_v1').length, 4);

    await waitForTimestampTick();
    writeDefs('v1');
    const restored = await graph.sync({ paths: ['defs.h'] });
    assert.notEqual(restored.complete, false);
    assert.equal(Number(hasCall(graph, 'cg_caller_0', 'cg_target_v1')), 1);
    assert.equal(Number(hasCall(graph, 'cg_caller_1', 'cg_target_v1')), 1);
    assert.equal(unresolvedTargetRefs(graph, 'cg_target_v1').length, 0);
  } finally {
    graph?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (selectedCase === 'direct-index-files') {
  await runDirectIndexFilesCase();
} else if (selectedCase === 'sync-self-heal') {
  await runSyncSelfHealCase();
} else {
  throw new Error(`Unknown regression case: ${selectedCase}`);
}
