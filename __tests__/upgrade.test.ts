import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectInstallMethod,
  parseSemver,
  compareVersions,
  isUpdateAvailable,
  normalizeVersion,
  stripV,
  parseNpmViewVersion,
  ensureNpmRegistryConfig,
  reindexAdvisory,
  runUpgrade,
  NPM_PACKAGE,
  HUAWEI_REGISTRY,
  HUAWEI_SDD_REGISTRY,
  type InstallMethod,
  type UpgradeDeps,
} from '../src/upgrade';
import { EXTRACTION_VERSION } from '../src/extraction/extraction-version';
import { CodeGraph } from '../src';

// ---------------------------------------------------------------------------
// detectInstallMethod — structural detection from the running file's path
// ---------------------------------------------------------------------------

describe('detectInstallMethod', () => {
  it('detects a global npm install', () => {
    const filename = '/usr/local/lib/node_modules/@sdd/codegraph-wx/dist/bin/codegraph.js';
    const m = detectInstallMethod({
      filename,
      platform: 'linux',
      cwd: '/home/u/project',
      exists: () => false,
    });
    expect(m).toEqual({ kind: 'npm', scope: 'global' });
  });

  it('detects a local (project) npm install as local', () => {
    const cwd = '/home/u/project';
    const filename = `${cwd}/node_modules/@sdd/codegraph-wx/dist/bin/codegraph.js`;
    const m = detectInstallMethod({ filename, platform: 'linux', cwd, exists: () => false });
    expect(m).toEqual({ kind: 'npm', scope: 'local' });
  });

  it('detects an npx run from the _npx cache', () => {
    const filename = '/home/u/.npm/_npx/abc123/node_modules/@sdd/codegraph-wx/dist/bin/codegraph.js';
    const m = detectInstallMethod({ filename, platform: 'linux', cwd: '/home/u', exists: () => false });
    expect(m).toEqual({ kind: 'npx' });
  });

  it('detects a source checkout via sibling package.json + .git', () => {
    const repo = '/home/u/dev/codegraph';
    const filename = `${repo}/dist/bin/codegraph.js`;
    const present = new Set([`${repo}/package.json`, `${repo}/.git`]);
    const m = detectInstallMethod({
      filename,
      platform: 'darwin',
      cwd: repo,
      exists: (p) => present.has(p.replace(/\\/g, '/')),
    });
    expect(m).toEqual({ kind: 'source', root: repo });
  });

  it('returns unknown for an unrecognized layout', () => {
    const m = detectInstallMethod({
      filename: '/opt/weird/place/codegraph.js',
      platform: 'linux',
      cwd: '/tmp',
      exists: () => false,
    });
    expect(m.kind).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// version helpers
// ---------------------------------------------------------------------------

describe('version helpers', () => {
  it('parseSemver handles v-prefix and prerelease', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
    expect(parseSemver('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, pre: 'rc.1' });
    expect(parseSemver('not-a-version')).toBeNull();
  });

  it('compareVersions orders correctly incl. prerelease < release', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('v2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  it('isUpdateAvailable compares, and falls back to string-inequality for unparseable', () => {
    expect(isUpdateAvailable('0.9.8', '0.9.9')).toBe(true);
    expect(isUpdateAvailable('0.9.9', '0.9.9')).toBe(false);
    expect(isUpdateAvailable('0.9.9', '0.9.8')).toBe(false);
    // dev sentinel can't parse → any difference means "update available"
    expect(isUpdateAvailable('0.0.0-unknown', '0.9.9')).toBe(true);
  });

  it('normalizeVersion / stripV round-trip', () => {
    expect(normalizeVersion('0.9.9')).toBe('v0.9.9');
    expect(normalizeVersion('v0.9.9')).toBe('v0.9.9');
    expect(stripV('v0.9.9')).toBe('0.9.9');
    expect(stripV('0.9.9')).toBe('0.9.9');
  });

  it('parseNpmViewVersion takes the last semver-shaped line (skips advisory noise)', () => {
    expect(parseNpmViewVersion('0.9.9\n')).toBe('0.9.9');
    expect(parseNpmViewVersion('npm warn ... deprecation\n0.9.10\n')).toBe('0.9.10');
    expect(parseNpmViewVersion('\n  v1.2.3  \n')).toBe('v1.2.3');
    expect(parseNpmViewVersion('not a version\nstill not')).toBeNull();
    expect(parseNpmViewVersion('')).toBeNull();
  });

  it('reindexAdvisory mentions the refresh commands + daemon restart hint', () => {
    const a = reindexAdvisory();
    expect(a).toContain('codegraph sync');
    expect(a).toContain('codegraph index -f');
    expect(a).toMatch(/daemon/i);
    expect(a).toMatch(/restart/i);
  });
});

// ---------------------------------------------------------------------------
// ensureNpmRegistryConfig — the three `npm config set` commands
// ---------------------------------------------------------------------------

describe('ensureNpmRegistryConfig', () => {
  function makeDeps(platform: NodeJS.Platform, runExit: (args: string[]) => number = () => 0) {
    const runs: Array<{ cmd: string; args: string[] }> = [];
    const errors: string[] = [];
    const deps: UpgradeDeps = {
      currentVersion: '0.9.9',
      method: { kind: 'npm', scope: 'global' },
      resolveLatest: async () => 'v0.9.9',
      run: (cmd, args) => {
        runs.push({ cmd, args });
        return runExit(args);
      },
      hasCommand: () => true,
      log: () => {},
      warn: () => {},
      error: (m) => errors.push(m),
      platform,
    };
    return { deps, runs, errors };
  }

  it('runs the three npm config set commands in order with the Huawei URLs', () => {
    const { deps, runs, errors } = makeDeps('linux');
    expect(ensureNpmRegistryConfig(deps)).toBe(0);
    expect(errors).toHaveLength(0);
    expect(runs).toHaveLength(3);
    expect(runs[0].args).toEqual(['config', 'set', 'registry', HUAWEI_REGISTRY]);
    expect(runs[1].args).toEqual(['config', 'set', '@sdd:registry', HUAWEI_SDD_REGISTRY]);
    expect(runs[2].args).toEqual(['config', 'set', 'strict-ssl', 'false']);
  });

  it('uses npm.cmd on win32', () => {
    const { deps, runs } = makeDeps('win32');
    ensureNpmRegistryConfig(deps);
    expect(runs.every((r) => r.cmd === 'npm.cmd')).toBe(true);
  });

  it('stops and returns the failing exit code when a config set fails', () => {
    const { deps, runs, errors } = makeDeps('linux', (args) =>
      args[2] === '@sdd:registry' ? 1 : 0
    );
    expect(ensureNpmRegistryConfig(deps)).toBe(1);
    expect(runs).toHaveLength(2); // registry succeeded, @sdd:registry failed, strict-ssl not run
    expect(errors.join('\n')).toMatch(/@sdd:registry/);
  });
});

// ---------------------------------------------------------------------------
// runUpgrade orchestration — mocked side-effects
// ---------------------------------------------------------------------------

interface Calls {
  runs: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }>;
  logs: string[];
  errors: string[];
}

function makeDeps(
  overrides: Partial<UpgradeDeps> & { method: InstallMethod; currentVersion: string },
  runExit = 0
): { deps: UpgradeDeps; calls: Calls } {
  const calls: Calls = { runs: [], logs: [], errors: [] };
  const deps: UpgradeDeps = {
    currentVersion: overrides.currentVersion,
    method: overrides.method,
    resolveLatest: overrides.resolveLatest ?? (async () => 'v0.9.9'),
    run: (cmd, args, env) => {
      calls.runs.push({ cmd, args, env });
      // `npm install` is the real action under test; `npm config set` always
      // succeeds in the orchestrator tests so we can isolate install behavior.
      if (args[0] === 'install') return runExit;
      return 0;
    },
    hasCommand: overrides.hasCommand ?? ((c) => c === 'curl'),
    log: (m) => calls.logs.push(m),
    warn: (m) => calls.logs.push(m),
    error: (m) => calls.errors.push(m),
    platform: overrides.platform ?? 'linux',
  };
  return { deps, calls };
}

/** The `npm install` call, if any, among the recorded runs. */
function installRun(calls: Calls) {
  return calls.runs.find((r) => r.args[0] === 'install');
}

describe('runUpgrade', () => {
  it('does nothing (no install) when already up to date, but still configures the registry', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.9' });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(installRun(calls)).toBeUndefined();
    expect(calls.runs.filter((r) => r.args[0] === 'config')).toHaveLength(3);
    expect(calls.logs.join('\n')).toMatch(/up to date/i);
  });

  it('--check reports an available update without installing (registry still configured)', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({ check: true }, deps);
    expect(code).toBe(0);
    expect(installRun(calls)).toBeUndefined();
    expect(calls.runs.filter((r) => r.args[0] === 'config')).toHaveLength(3);
    expect(calls.logs.join('\n')).toMatch(/update is available/i);
  });

  it('npm global: configures registry then runs npm install -g @pkg@latest', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    const inst = installRun(calls);
    expect(inst).toBeDefined();
    expect(inst!.cmd).toBe('npm');
    expect(inst!.args).toEqual(['install', '-g', `${NPM_PACKAGE}@latest`]);
    // registry config ran first
    expect(calls.runs[0].args[0]).toBe('config');
  });

  it('npm on win32 uses npm.cmd for both config and install', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.8',
      platform: 'win32',
    });
    await runUpgrade({}, deps);
    expect(calls.runs.every((r) => r.cmd === 'npm.cmd')).toBe(true);
    expect(installRun(calls)!.cmd).toBe('npm.cmd');
  });

  it('npm: a pinned version is passed through as @<version>', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'npm', scope: 'global' },
      currentVersion: '0.9.9',
    });
    await runUpgrade({ version: '0.9.8' }, deps);
    expect(installRun(calls)!.args).toEqual(['install', '-g', `${NPM_PACKAGE}@0.9.8`]);
  });

  it('npm: surfaces a non-zero install exit as failure', async () => {
    const { deps, calls } = makeDeps(
      { method: { kind: 'npm', scope: 'global' }, currentVersion: '0.9.8' },
      1
    );
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.errors.join('\n')).toMatch(/npm exited/i);
  });

  it('npm: a failing registry config aborts before resolve/install', async () => {
    // Custom run: fail the first `npm config set`.
    const calls: Calls = { runs: [], logs: [], errors: [] };
    const deps: UpgradeDeps = {
      currentVersion: '0.9.8',
      method: { kind: 'npm', scope: 'global' },
      resolveLatest: async () => 'v0.9.9',
      run: (cmd, args) => {
        calls.runs.push({ cmd, args });
        return args[0] === 'config' && args[2] === 'registry' ? 1 : 0;
      },
      hasCommand: () => true,
      log: (m) => calls.logs.push(m),
      warn: (m) => calls.logs.push(m),
      error: (m) => calls.errors.push(m),
      platform: 'linux',
    };
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(installRun(calls)).toBeUndefined();
    expect(calls.errors.join('\n')).toMatch(/npm config set registry/);
  });

  it('npx: nothing to upgrade, no registry config', async () => {
    const { deps, calls } = makeDeps({ method: { kind: 'npx' }, currentVersion: '0.9.8' });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/nothing to upgrade/i);
  });

  it('source: tells the user to git pull, runs nothing', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'source', root: '/dev/codegraph' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(0);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toMatch(/git pull/);
  });

  it('unknown: errors and suggests a manual reinstall', async () => {
    const { deps, calls } = makeDeps({
      method: { kind: 'unknown', reason: 'weird layout' },
      currentVersion: '0.9.8',
    });
    const code = await runUpgrade({}, deps);
    expect(code).toBe(1);
    expect(calls.runs).toHaveLength(0);
    expect(calls.logs.join('\n')).toContain(NPM_PACKAGE);
  });
});

// ---------------------------------------------------------------------------
// Re-index staleness — real index, real metadata stamp
// ---------------------------------------------------------------------------

describe('index extraction-version stamp / isIndexStale', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-upgrade-stamp-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the current extraction version on full index and is not stale', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    const cg = await CodeGraph.init(dir, { index: false });
    // No index yet → not stale (nothing to refresh).
    expect(cg.isIndexStale()).toBe(false);

    await cg.indexAll();
    const info = cg.getIndexBuildInfo();
    expect(info.extractionVersion).toBe(EXTRACTION_VERSION);
    expect(typeof info.version).toBe('string');
    expect(cg.isIndexStale()).toBe(false);
    cg.destroy();
  });

  it('flags an index stamped by an older extraction version as stale', async () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export function hello() { return 1; }\n');
    const cg = await CodeGraph.init(dir, { index: false });
    await cg.indexAll();

    // Simulate an index built by an older engine.
    (cg as unknown as { queries: { setMetadata(k: string, v: string): void } }).queries.setMetadata(
      'indexed_with_extraction_version',
      String(EXTRACTION_VERSION - 1)
    );
    expect(cg.isIndexStale()).toBe(true);
    cg.destroy();
  });
});