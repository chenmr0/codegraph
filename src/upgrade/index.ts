/**
 * `codegraph upgrade`
 *
 * Self-update for the CLI from the Huawei internal npm registry.
 *
 * This fork is published as `@sdd/codegraph-wx` on
 * `https://cmc.centralrepo.rnd.huawei.com/...`. Upgrading:
 *
 *   1. configures npm to point at the Huawei registries
 *      (`npm config set registry / @sdd:registry / strict-ssl false`) —
 *      idempotent, so re-runs are harmless;
 *   2. resolves the latest published version via
 *      `npm view @sdd/codegraph-wx version`;
 *   3. if the running version is older, runs
 *      `npm install -g @sdd/codegraph-wx@<version>`.
 *
 * Detection (`detectInstallMethod`) recognizes npm-global / npm-local / npx /
 * source checkouts from the running file's path. The previous bundle
 * (vendored-node) and GitHub-releases paths have been removed — this build is
 * only ever installed via the Huawei npm registry.
 *
 * Windows note: a running `node.exe` is locked, but `npm install -g` replaces
 * `dist/*.js` (not the node binary), so there is no file-lock issue. The
 * running process keeps its already-loaded code in memory; the *next*
 * `codegraph` invocation uses the new version — open a new terminal to see it.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

export const NPM_PACKAGE = '@sdd/codegraph-wx';

/** Huawei internal npm registries (default + @sdd scope) + TLS relax. */
export const HUAWEI_REGISTRY = 'https://cmc.centralrepo.rnd.huawei.com/npm/';
export const HUAWEI_SDD_REGISTRY = 'https://cmc.centralrepo.rnd.huawei.com/artifactory/api/npm/product_npm/';

// ---------------------------------------------------------------------------
// Install-method detection (pure — fully unit-testable via injected probes)
// ---------------------------------------------------------------------------

export type InstallMethod =
  | { kind: 'npm'; scope: 'global' | 'local' }
  | { kind: 'npx' }
  | { kind: 'source'; root: string }
  | { kind: 'unknown'; reason: string };

export interface DetectInput {
  /** `__filename` of the running CLI module — `<…>/dist/bin/codegraph.js`. */
  filename: string;
  platform: NodeJS.Platform;
  cwd: string;
  /** Injectable existence probe (defaults to fs.existsSync) — for tests. */
  exists?: (p: string) => boolean;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function detectInstallMethod(input: DetectInput): InstallMethod {
  const exists = input.exists ?? fs.existsSync;
  const isWin = input.platform === 'win32';
  // Path math keyed on the TARGET platform so detection is host-independent
  // (a Windows layout resolves correctly even when unit-tested on macOS/Linux).
  const P = isWin ? path.win32 : path.posix;
  const binDir = P.dirname(input.filename); // <…>/bin
  const norm = toPosix(input.filename);

  // npx cache: <…>/_npx/<hash>/node_modules/@sdd/codegraph-wx/…
  if (norm.includes('/_npx/')) {
    return { kind: 'npx' };
  }

  // npm install (global or local): lives under a node_modules tree.
  if (norm.includes('/node_modules/')) {
    const underCwd = norm.startsWith(toPosix(P.resolve(input.cwd)) + '/');
    return { kind: 'npm', scope: underCwd ? 'local' : 'global' };
  }

  // Source checkout: running <repo>/dist/bin/codegraph.js with a sibling .git.
  const repoRoot = P.resolve(binDir, '..', '..');
  if (exists(P.join(repoRoot, 'package.json')) && exists(P.join(repoRoot, '.git'))) {
    return { kind: 'source', root: repoRoot };
  }

  return { kind: 'unknown', reason: `unrecognized install layout at ${input.filename}` };
}

// ---------------------------------------------------------------------------
// Version helpers (pure)
// ---------------------------------------------------------------------------

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export function parseSemver(version: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!m) return null;
  return {
    major: parseInt(m[1]!, 10),
    minor: parseInt(m[2]!, 10),
    patch: parseInt(m[3]!, 10),
    pre: m[4] ?? null,
  };
}

/** Returns >0 if a>b, <0 if a<b, 0 if equal. Throws on unparseable input. */
export function compareVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (!sa || !sb) throw new Error(`cannot compare versions: "${a}" vs "${b}"`);
  if (sa.major !== sb.major) return sa.major - sb.major;
  if (sa.minor !== sb.minor) return sa.minor - sb.minor;
  if (sa.patch !== sb.patch) return sa.patch - sb.patch;
  // A prerelease is "less than" its release (1.0.0-rc < 1.0.0).
  if (sa.pre && !sb.pre) return -1;
  if (!sa.pre && sb.pre) return 1;
  if (sa.pre && sb.pre) return sa.pre < sb.pre ? -1 : sa.pre > sb.pre ? 1 : 0;
  return 0;
}

export function isUpdateAvailable(current: string, latest: string): boolean {
  try {
    return compareVersions(latest, current) > 0;
  } catch {
    // If either is unparseable (e.g. a dev "0.0.0-unknown"), treat differing
    // strings as "update available" so the user isn't stuck.
    return normalizeVersion(current) !== normalizeVersion(latest);
  }
}

/** `0.9.9` / `v0.9.9` → `v0.9.9` (display normalization). */
export function normalizeVersion(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t : `v${t}`;
}

/** Strip a leading `v`: `v0.9.9` → `0.9.9` (npm version specs carry no "v"). */
export function stripV(v: string): string {
  const t = v.trim();
  return t.startsWith('v') ? t.slice(1) : t;
}

/**
 * Parse the version out of `npm view <pkg> version` stdout. `npm view` may
 * print advisory lines (deprecation notices, registry warnings) before the
 * version, so we take the last trimmed line that parses as a semver. Pure so
 * it's unit-tested without touching the network.
 */
export function parseNpmViewVersion(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (parseSemver(line)) return line;
  }
  return null;
}

// ---------------------------------------------------------------------------
// npm registry configuration + latest-version resolution (network)
// ---------------------------------------------------------------------------

/**
 * Run `npm config set` for the Huawei registries + `strict-ssl false`. Uses
 * `deps.run` so the command sequence is unit-testable via a mock. Returns 0 on
 * success, the failing exit code otherwise. Idempotent — safe to run on every
 * upgrade.
 */
export function ensureNpmRegistryConfig(deps: UpgradeDeps): number {
  const npm = deps.platform === 'win32' ? 'npm.cmd' : 'npm';
  const settings: Array<[string, string]> = [
    ['registry', HUAWEI_REGISTRY],
    ['@sdd:registry', HUAWEI_SDD_REGISTRY],
    ['strict-ssl', 'false'],
  ];
  for (const [key, val] of settings) {
    const code = deps.run(npm, ['config', 'set', key, val], process.env);
    if (code !== 0) {
      deps.error(`\`npm config set ${key} ${val}\` exited with code ${code}.`);
      return code;
    }
  }
  return 0;
}

/**
 * Resolve the latest published version of `@sdd/codegraph-wx` via
 * `npm view <pkg> version`. Requires the Huawei registry to be configured
 * (run `ensureNpmRegistryConfig` first). Returns a `v`-prefixed tag.
 */
export async function resolveLatestVersion(timeoutMs = 30000): Promise<string> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['view', NPM_PACKAGE, 'version'], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (r.error) {
    const msg = r.error.message;
    if (msg.includes('timed out')) {
      throw new Error(
        `npm view timed out after ${timeoutMs}ms — could not reach the Huawei npm registry. Check network and \`npm config\`.`
      );
    }
    throw new Error(`could not run \`npm view ${NPM_PACKAGE} version\`: ${msg}`);
  }
  if (r.status !== 0) {
    throw new Error(
      `\`npm view ${NPM_PACKAGE} version\` exited with code ${r.status}. Check npm registry config and network.`
    );
  }
  const v = parseNpmViewVersion(r.stdout ?? '');
  if (!v) {
    throw new Error(
      `could not parse a version from \`npm view ${NPM_PACKAGE} version\` output: ${JSON.stringify(r.stdout)}`
    );
  }
  return normalizeVersion(v);
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface UpgradeOptions {
  /** Pin a specific version (positional arg or CODEGRAPH_VERSION). */
  version?: string;
  /** Report current vs latest, don't change anything. */
  check?: boolean;
  /** Reinstall even if already on the resolved version. */
  force?: boolean;
}

/** Injectable side-effects so the orchestrator stays unit-testable. */
export interface UpgradeDeps {
  currentVersion: string;
  method: InstallMethod;
  resolveLatest: (pin?: string) => Promise<string>;
  /** Run a command inheriting stdio; returns its exit code (-1 = spawn failed). */
  run: (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => number;
  hasCommand: (cmd: string) => boolean;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  platform: NodeJS.Platform;
}

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

/** The honest, additive re-index reminder shown after a successful upgrade. */
export function reindexAdvisory(): string {
  return [
    c.dim('Your existing project indexes keep working, but were built by the previous version.'),
    c.dim('To pick up this version’s extraction improvements, refresh each project:'),
    `  ${c.cyan('codegraph sync')}        ${c.dim('# incremental, fast')}`,
    `  ${c.cyan('codegraph index -f')}    ${c.dim('# full rebuild')}`,
    c.dim('(`codegraph status` flags any index that predates the engine you’re running.)'),
    c.dim('If a CodeGraph MCP daemon is still running, it holds the OLD version in memory.'),
    c.dim('Restart it (or wait for its idle timeout) so the next `codegraph serve` picks up the new build.'),
  ].join('\n');
}

/**
 * Returns the process exit code (0 = success / nothing to do, 1 = failure).
 */
export async function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<number> {
  const { currentVersion, method } = deps;

  // npx / source: short-circuit before any registry work — nothing to install.
  if (method.kind === 'npx') {
    deps.log(c.green('npx always runs the latest version on demand — nothing to upgrade.'));
    deps.log(c.dim(`Force a fresh fetch with: npx ${NPM_PACKAGE}@latest`));
    return 0;
  }
  if (method.kind === 'source') {
    deps.warn(`Running from a source checkout at ${method.root}.`);
    deps.log(c.dim('Upgrade it with: git pull && npm run build'));
    return 0;
  }
  if (method.kind === 'unknown') {
    deps.error(`Couldn’t determine how CodeGraph was installed (${method.reason}).`);
    deps.log(c.dim(`Reinstall manually: npm install -g ${NPM_PACKAGE}`));
    return 1;
  }

  // npm: point npm at the Huawei registry first, so `npm view` / `npm install`
  // can reach it. Idempotent — safe on every upgrade/check.
  const cfg = ensureNpmRegistryConfig(deps);
  if (cfg !== 0) {
    return cfg;
  }

  // Resolve the target version (pinned or latest).
  let latest: string;
  try {
    latest = normalizeVersion(opts.version || (await deps.resolveLatest()));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const currentDisplay = normalizeVersion(currentVersion);
  deps.log(
    `${c.bold('CodeGraph')}  current ${c.cyan(currentDisplay)}  ${opts.version ? 'target' : 'latest'} ${c.cyan(latest)}`
  );

  const updateAvailable = isUpdateAvailable(currentVersion, latest);

  if (opts.check) {
    if (updateAvailable) {
      deps.log(c.yellow(`An update is available: ${currentDisplay} → ${latest}`));
      deps.log(c.dim('Run `codegraph upgrade` to install it.'));
    } else {
      deps.log(c.green(`You’re on the latest version (${currentDisplay}).`));
    }
    return 0;
  }

  if (!updateAvailable && !opts.force && !opts.version) {
    deps.log(c.green(`Already up to date (${currentDisplay}).`));
    deps.log(c.dim('Use `--force` to reinstall, or `codegraph upgrade <version>` to change versions.'));
    return 0;
  }

  // npm version specs have no leading "v" (`@0.9.8`, not `@v0.9.8` — the
  // latter resolves as a nonexistent dist-tag).
  return upgradeNpm(method, opts.version ? stripV(latest) : 'latest', deps);
}

function upgradeNpm(
  method: Extract<InstallMethod, { kind: 'npm' }>,
  versionSpec: string,
  deps: UpgradeDeps
): number {
  const npm = deps.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = method.scope === 'global'
    ? ['install', '-g', `${NPM_PACKAGE}@${versionSpec}`]
    : ['install', `${NPM_PACKAGE}@${versionSpec}`];
  deps.log(c.dim(`Running: ${npm} ${args.join(' ')}`));
  const code = deps.run(npm, args, process.env);
  if (code !== 0) {
    deps.error(`npm exited with code ${code}.`);
    if (method.scope === 'global') {
      deps.log(c.dim('If this is a permissions error (EACCES), your global prefix needs sudo, or use a'));
      deps.log(c.dim('Node version manager (nvm/fnm) so global installs don’t require root.'));
    }
    return 1;
  }
  deps.log('');
  deps.log(c.green('✓ Upgrade complete.') + c.dim(' Open a new terminal to see the new version.'));
  deps.log(reindexAdvisory());
  return 0;
}

// ---------------------------------------------------------------------------
// Production deps wiring (used by the CLI)
// ---------------------------------------------------------------------------

/**
 * True if `cmd` resolves to an executable on PATH. A pure-Node PATH scan — NOT
 * a spawned `command -v`/`which`: `command` is a shell builtin (no standalone
 * binary on Debian, though macOS ships one), and `which` isn't guaranteed
 * present on minimal images, so spawning either is unreliable. Scanning PATH
 * ourselves behaves identically on every platform.
 */
export function hasCommand(cmd: string): boolean {
  const isWin = process.platform === 'win32';
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (isWin) return true;
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
      } catch {
        /* not here / not executable — keep scanning */
      }
    }
  }
  return false;
}

export function defaultRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): number {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: env ?? process.env });
  if (r.error) return -1;
  return r.status ?? -1;
}