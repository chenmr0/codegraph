#!/usr/bin/env node

/**
 * Compare Phase 2 reference-resolution optimizations against their rollback
 * switches. Targets must be disposable snapshots: each run removes only the
 * target's `.codegraph` directory and fingerprints the complete result.
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
const optionNames = new Set(['--runs', '--out', '--cli', '--mode']);
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (optionNames.has(args[i])) {
    i++;
  } else if (!args[i].startsWith('--')) {
    targets.push(path.resolve(args[i]));
  }
}
if (targets.length === 0) {
  throw new Error(
    'Usage: node scripts/benchmark-phase2-projects.mjs ' +
      '[--runs 2] [--mode both|rollback|optimized] [--out DIR] SNAPSHOT...'
  );
}

const runsPerMode = Math.max(1, Number(option('--runs', '2')) || 2);
const skipWarmup = args.includes('--skip-warmup');
const selectedMode = option('--mode', 'both');
if (!['both', 'rollback', 'optimized'].includes(selectedMode)) {
  throw new Error('--mode must be one of: both, rollback, optimized');
}
const cliPath = path.resolve(
  option('--cli', path.join(process.cwd(), 'dist', 'bin', 'codegraph.js'))
);
const outputDir = path.resolve(
  option('--out', path.join(tmpdir(), `codegraph-phase2-results-${Date.now()}`))
);
mkdirSync(outputDir, { recursive: true });

const phase2Flags = [
  'CODEGRAPH_NO_PARALLEL_RESOLVE',
  'CODEGRAPH_NO_RESOLVE_INDEX_DEFER',
  'CODEGRAPH_NO_RESOLVE_EQUIVALENCE_CACHE',
  'CODEGRAPH_RESOLVE_WORKERS',
  'CODEGRAPH_PARALLEL_RESOLVE_MIN',
];

function environmentFor(mode) {
  const env = {
    ...process.env,
    CI: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CODEGRAPH_SYNTH_TIMINGS: '1',
  };
  for (const name of phase2Flags) delete env[name];
  if (mode === 'rollback') {
    env.CODEGRAPH_NO_PARALLEL_RESOLVE = '1';
    env.CODEGRAPH_NO_RESOLVE_INDEX_DEFER = '1';
    env.CODEGRAPH_NO_RESOLVE_EQUIVALENCE_CACHE = '1';
  }
  return env;
}

function cleanIndex(projectDir) {
  rmSync(path.join(projectDir, '.codegraph'), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
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
          reject(
            new Error(
              `${tag} failed with code ${code}, signal ${signal ?? 'none'}\n` +
                readFileSync(logPath, 'utf8').slice(-5000)
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
  return Number(Object.values(db.prepare(sql).get())[0]);
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

  const result = {
    sha256: hash.digest('hex'),
    counts: {
      files: scalar(db, 'SELECT count(*) FROM files'),
      nodes: scalar(db, 'SELECT count(*) FROM nodes'),
      edges: scalar(db, 'SELECT count(*) FROM edges'),
      unresolvedRefs: scalar(db, 'SELECT count(*) FROM unresolved_refs'),
      ftsRows: scalar(db, 'SELECT count(*) FROM nodes_fts'),
    },
    integrity: db.prepare('PRAGMA integrity_check').get().integrity_check,
    foreignKeyErrors: [...db.prepare('PRAGMA foreign_key_check').iterate()].length,
    ftsTriggers: scalar(
      db,
      `SELECT count(*) FROM sqlite_master
       WHERE type='trigger' AND name IN ('nodes_ai','nodes_ad','nodes_au')`
    ),
  };
  db.close();
  return result;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function runSequence(repetitions) {
  if (selectedMode !== 'both') {
    return new Array(repetitions).fill(selectedMode);
  }
  const sequence = [];
  for (let i = 0; i < repetitions; i++) {
    if (i % 2 === 0) sequence.push('rollback', 'optimized');
    else sequence.push('optimized', 'rollback');
  }
  return sequence;
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
  if (!skipWarmup) {
    console.log(`[${label}] warm-up optimized`);
    await runIndex(projectDir, 'optimized', `${label}-warmup-optimized`);
  }

  const runs = [];
  const ordinal = { rollback: 0, optimized: 0 };
  for (const mode of runSequence(runsPerMode)) {
    ordinal[mode]++;
    const tag = `${label}-${mode}-${ordinal[mode]}`;
    console.log(`[${label}] starting ${mode} ${ordinal[mode]}/${runsPerMode}`);
    const timing = await runIndex(projectDir, mode, tag);
    const graph = fingerprint(projectDir);
    runs.push({
      mode,
      ordinal: ordinal[mode],
      wallMs: timing.wallMs,
      logPath: timing.logPath,
      graph,
    });
    writeFileSync(
      path.join(outputDir, `${label}-checkpoint.json`),
      `${JSON.stringify({ label, runs }, null, 2)}\n`,
      'utf8'
    );
    console.log(
      `[${label}] ${mode}: ${timing.wallMs}ms, ` +
        `${graph.counts.nodes} nodes, ${graph.counts.edges} edges, ` +
        `sha=${graph.sha256.slice(0, 12)}`
    );
  }

  const rollbackTimes = runs
    .filter((run) => run.mode === 'rollback')
    .map((run) => run.wallMs);
  const optimizedTimes = runs
    .filter((run) => run.mode === 'optimized')
    .map((run) => run.wallMs);
  const rollbackMedianMs = rollbackTimes.length ? median(rollbackTimes) : null;
  const optimizedMedianMs = optimizedTimes.length ? median(optimizedTimes) : null;
  const summary = {
    rollbackMedianMs,
    optimizedMedianMs,
    speedup:
      rollbackMedianMs !== null && optimizedMedianMs !== null
        ? rollbackMedianMs / optimizedMedianMs
        : null,
    reduction:
      rollbackMedianMs !== null && optimizedMedianMs !== null
        ? (rollbackMedianMs - optimizedMedianMs) / rollbackMedianMs
        : null,
    graphFingerprintsMatch:
      new Set(runs.map((run) => run.graph.sha256)).size === 1,
    healthOk: runs.every(
      (run) =>
        run.graph.integrity === 'ok' &&
        run.graph.foreignKeyErrors === 0 &&
        run.graph.ftsTriggers === 3 &&
        run.graph.counts.ftsRows === run.graph.counts.nodes
    ),
  };
  report.projects.push({ label, runs, summary });
  console.log(`[${label}] ${JSON.stringify(summary)}`);
  cleanIndex(projectDir);
}

const reportPath = path.join(outputDir, 'phase2-comparison.json');
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`RESULT_JSON ${reportPath}`);
