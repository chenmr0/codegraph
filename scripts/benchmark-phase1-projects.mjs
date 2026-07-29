#!/usr/bin/env node

/**
 * Compare Phase 1 fresh-index optimizations against their rollback switches.
 *
 * The caller supplies disposable project snapshots. Each run deletes only the
 * snapshot's .codegraph directory, invokes the same built CLI, and fingerprints
 * the complete persisted graph after indexing.
 */

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const positional = args.filter(
  (value, index) => !value.startsWith('--') && args[index - 1]?.startsWith('--') !== true
);
const targets = positional.map((value) => path.resolve(value));
if (targets.length === 0) {
  throw new Error(
    'Usage: node scripts/benchmark-phase1-projects.mjs [--runs 3] [--out DIR] PROJECT...'
  );
}

const runsPerMode = Math.max(1, Number(option('--runs', '3')) || 3);
const skipWarmup = args.includes('--skip-warmup');
const cliPath = path.resolve(
  option('--cli', path.join(process.cwd(), 'dist', 'bin', 'codegraph.js'))
);
const outputDir = path.resolve(
  option(
    '--out',
    path.join(tmpdir(), `codegraph-phase1-results-${Date.now()}`)
  )
);
mkdirSync(outputDir, { recursive: true });

const phase1Flags = [
  'CODEGRAPH_PARSE_WORKERS',
  'CODEGRAPH_NO_STORE_WORKER',
  'CODEGRAPH_NO_FAST_INIT',
  'CODEGRAPH_NO_BULK_FTS',
  'CODEGRAPH_NO_PARSE_INDEX_DEFER',
  'CODEGRAPH_NO_BATCH_WRITES',
];

const rollbackValues = {
  CODEGRAPH_PARSE_WORKERS: '1',
  CODEGRAPH_NO_STORE_WORKER: '1',
  CODEGRAPH_NO_FAST_INIT: '1',
  CODEGRAPH_NO_BULK_FTS: '1',
  CODEGRAPH_NO_PARSE_INDEX_DEFER: '1',
  CODEGRAPH_NO_BATCH_WRITES: '1',
};

function cleanIndex(projectDir) {
  const indexDir = path.join(projectDir, '.codegraph');
  rmSync(indexDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}

function environmentFor(mode) {
  const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const name of phase1Flags) delete env[name];
  if (mode === 'rollback') Object.assign(env, rollbackValues);
  return env;
}

function runIndex(projectDir, mode, tag) {
  return new Promise((resolve, reject) => {
    cleanIndex(projectDir);
    const logPath = path.join(outputDir, `${tag}.log`);
    const output = createWriteStream(logPath);
    const started = performance.now();
    const child = spawn(process.execPath, [cliPath, 'init', projectDir], {
      env: environmentFor(mode),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.pipe(output);
    child.stderr.pipe(output, { end: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      const wallMs = Math.round(performance.now() - started);
      output.end(() => {
        if (code !== 0) {
          const tail = readFileSync(logPath, 'utf8').slice(-4000);
          reject(
            new Error(
              `${tag} failed with code ${code}, signal ${signal ?? 'none'}\n${tail}`
            )
          );
          return;
        }
        resolve({ wallMs, logPath });
      });
    });
  });
}

function scalar(db, sql) {
  const row = db.prepare(sql).get();
  return Number(Object.values(row)[0]);
}

function fingerprint(projectDir) {
  const dbPath = path.join(projectDir, '.codegraph', 'codegraph.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const hash = createHash('sha256');
  const tables = [
    {
      name: 'nodes',
      sql: `SELECT id,kind,name,qualified_name,file_path,language,
                   start_line,end_line,start_column,end_column,
                   IFNULL(docstring,'') AS docstring,
                   IFNULL(signature,'') AS signature,
                   IFNULL(visibility,'') AS visibility,
                   is_exported,is_async,is_static,is_abstract,is_declaration,
                   IFNULL(decorators,'') AS decorators,
                   IFNULL(type_parameters,'') AS type_parameters,
                   IFNULL(return_type,'') AS return_type
            FROM nodes ORDER BY id`,
    },
    {
      name: 'edges',
      sql: `SELECT source,target,kind,IFNULL(metadata,'') AS metadata,
                   IFNULL(line,-1) AS line,IFNULL(col,-1) AS col,
                   IFNULL(provenance,'') AS provenance
            FROM edges
            ORDER BY source,target,kind,line,col,metadata,provenance`,
    },
    {
      name: 'unresolved_refs',
      sql: `SELECT from_node_id,reference_name,reference_kind,line,col,
                   IFNULL(candidates,'') AS candidates,
                   IFNULL(file_path,'') AS file_path,
                   IFNULL(language,'') AS language
            FROM unresolved_refs
            ORDER BY from_node_id,reference_name,reference_kind,line,col,
                     candidates,file_path,language`,
    },
    {
      name: 'files',
      sql: `SELECT path,content_hash,language,size,modified_at,node_count,
                   IFNULL(errors,'') AS errors
            FROM files ORDER BY path`,
    },
  ];

  for (const table of tables) {
    hash.update(`\n[${table.name}]\n`);
    for (const row of db.prepare(table.sql).iterate()) {
      hash.update(JSON.stringify(row));
      hash.update('\n');
    }
  }

  const counts = {
    files: scalar(db, 'SELECT count(*) FROM files'),
    nodes: scalar(db, 'SELECT count(*) FROM nodes'),
    edges: scalar(db, 'SELECT count(*) FROM edges'),
    unresolvedRefs: scalar(db, 'SELECT count(*) FROM unresolved_refs'),
    ftsRows: scalar(db, 'SELECT count(*) FROM nodes_fts'),
  };
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  let foreignKeyErrors = 0;
  for (const _row of db.prepare('PRAGMA foreign_key_check').iterate()) {
    foreignKeyErrors++;
  }
  const ftsTriggers = scalar(
    db,
    `SELECT count(*) FROM sqlite_master
     WHERE type='trigger' AND name IN ('nodes_ai','nodes_ad','nodes_au')`
  );
  db.close();
  return {
    sha256: hash.digest('hex'),
    counts,
    integrity,
    foreignKeyErrors,
    ftsTriggers,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function sequence(repetitions) {
  const balanced = ['rollback', 'optimized', 'optimized', 'rollback'];
  const result = [];
  const counts = { rollback: 0, optimized: 0 };
  let index = 0;
  while (counts.rollback < repetitions || counts.optimized < repetitions) {
    const mode = balanced[index++ % balanced.length];
    if (counts[mode] < repetitions) {
      result.push(mode);
      counts[mode]++;
    }
  }
  return result;
}

const report = {
  generatedAt: new Date().toISOString(),
  cliPath,
  system: {
    availableParallelism: availableParallelism(),
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  },
  projects: [],
};

for (const projectDir of targets) {
  const label = path.basename(projectDir);
  let warmFingerprint = null;
  if (!skipWarmup) {
    console.log(`\n[${label}] warm-up optimized run`);
    await runIndex(projectDir, 'optimized', `${label}-warmup-optimized`);
    warmFingerprint = fingerprint(projectDir);
    console.log(
      `[${label}] warm-up graph: ${warmFingerprint.counts.nodes} nodes, ` +
        `${warmFingerprint.counts.edges} edges`
    );
  } else {
    console.log(`\n[${label}] warm-up skipped`);
  }

  const runs = [];
  const checkpointPath = path.join(outputDir, `${label}-checkpoint.json`);
  const ordinal = { rollback: 0, optimized: 0 };
  for (const mode of sequence(runsPerMode)) {
    ordinal[mode]++;
    const tag = `${label}-${mode}-${ordinal[mode]}`;
    console.log(`[${label}] starting ${mode} ${ordinal[mode]}/${runsPerMode}`);
    const timing = await runIndex(projectDir, mode, tag);
    const graph = fingerprint(projectDir);
    const run = {
      mode,
      ordinal: ordinal[mode],
      wallMs: timing.wallMs,
      graph,
    };
    runs.push(run);
    writeFileSync(
      checkpointPath,
      `${JSON.stringify({ label, warmFingerprint, runs }, null, 2)}\n`,
      'utf8'
    );
    console.log(
      `[${label}] ${mode} ${ordinal[mode]}: ${timing.wallMs} ms, ` +
        `${graph.counts.files} files, ${graph.counts.nodes} nodes, ` +
        `${graph.counts.edges} edges, sha ${graph.sha256.slice(0, 12)}`
    );
  }

  const rollbackMedianMs = median(
    runs.filter((run) => run.mode === 'rollback').map((run) => run.wallMs)
  );
  const optimizedMedianMs = median(
    runs.filter((run) => run.mode === 'optimized').map((run) => run.wallMs)
  );
  const fingerprints = new Set(runs.map((run) => run.graph.sha256));
  const healthOk = runs.every(
    (run) =>
      run.graph.integrity === 'ok' &&
      run.graph.foreignKeyErrors === 0 &&
      run.graph.ftsTriggers === 3 &&
      run.graph.counts.ftsRows === run.graph.counts.nodes
  );
  const summary = {
    rollbackMedianMs,
    optimizedMedianMs,
    speedup: rollbackMedianMs / optimizedMedianMs,
    reduction:
      (rollbackMedianMs - optimizedMedianMs) / rollbackMedianMs,
    graphFingerprintsMatch: fingerprints.size === 1,
    healthOk,
  };
  report.projects.push({ label, runs, summary });
  console.log(
    `[${label}] median ${rollbackMedianMs} -> ${optimizedMedianMs} ms, ` +
      `${summary.speedup.toFixed(2)}x, ` +
      `${(summary.reduction * 100).toFixed(1)}% less; ` +
      `graphMatch=${summary.graphFingerprintsMatch}, health=${summary.healthOk}`
  );
  cleanIndex(projectDir);
}

const reportPath = path.join(outputDir, 'phase1-comparison.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`\nRESULT_JSON ${reportPath}`);
console.log(JSON.stringify(report.projects.map(({ label, summary }) => ({ label, ...summary }))));
