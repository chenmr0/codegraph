import type CodeGraph from '../index';
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { basename, extname } from 'path';
import { rgPath as bundledRgPath } from '@vscode/ripgrep';
import { CONFIG_LEAF_LANGUAGES, validatePathWithinRoot } from '../utils';

/**
 * A deliberately high, but finite, ceiling for rare negative-evidence scans.
 * Unlike text_search this path only runs after an exact graph lookup failed.
 * A response may claim absence only when every eligible indexed source file
 * was read successfully; reaching this ceiling produces INCONCLUSIVE instead.
 */
const RAW_EVIDENCE_MAX_SCANNED_BYTES = 512 * 1024 * 1024;
const RAW_EVIDENCE_DEFAULT_TIMEOUT_MS = 8_000;
const RAW_EVIDENCE_MAX_QUERIES = 8;
const RAW_EVIDENCE_MAX_SNIPPETS = 6;
const RAW_EVIDENCE_MAX_LINE_CHARS = 300;
const RAW_EVIDENCE_MAX_RG_OUTPUT_BYTES = 64 * 1024 * 1024;
const RAW_EVIDENCE_MAX_RG_TARGETS_PER_BATCH = 256;
const RAW_EVIDENCE_MAX_RG_TARGET_CHARS = 24_000;

export interface RawEvidenceSpec {
  /** Label shown to the agent; normally the original symbol/signature. */
  label: string;
  /** Existing identifier or literal to search in current on-disk source. */
  needle: string;
  /** Optional case-insensitive indexed path substring. */
  path?: string;
  /** Identifier mode enforces code-identifier boundaries. */
  mode?: 'identifier' | 'literal';
  /** Structured reason that requested the raw evidence. */
  purpose?: 'generic' | 'declaration_only';
}

interface RawEvidenceSnippet {
  file: string;
  line: number;
  text: string;
}

interface RawEvidenceState {
  spec: RawEvidenceSpec;
  normalizedPath?: string;
  eligibleFiles: number;
  scannedFiles: number;
  scannedBytes: number;
  unreadableFiles: number;
  matchingLines: number;
  snippets: RawEvidenceSnippet[];
}

export interface RawEvidenceReport {
  states: RawEvidenceState[];
  totalScannedFiles: number;
  totalScannedBytes: number;
  budgetReached: boolean;
  timeBudgetReached: boolean;
  cancelled: boolean;
  omittedQueries: number;
  backend: 'ripgrep' | 'hybrid' | 'node';
  /** True when an unchanged, actively-watched source epoch reused this scan. */
  cacheHit: boolean;
}

interface RawEvidenceCacheBucket {
  epoch: number | null;
  entries: Map<string, RawEvidenceReport>;
}

const RAW_EVIDENCE_CACHE_MAX_ENTRIES = 32;
const rawEvidenceCache = new WeakMap<CodeGraph, RawEvidenceCacheBucket>();

function normalizedPath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
  return normalized || undefined;
}

function normalizedSpecs(inputSpecs: RawEvidenceSpec[]): RawEvidenceSpec[] {
  return inputSpecs
    .map((spec) => ({
      ...spec,
      label: spec.label.trim(),
      needle: spec.needle.trim(),
      path: spec.path?.trim() || undefined,
      mode: spec.mode ?? 'identifier' as const,
      purpose: spec.purpose ?? 'generic' as const,
    }))
    .filter((spec) => spec.label.length > 0 && spec.needle.length > 0)
    .slice(0, RAW_EVIDENCE_MAX_QUERIES);
}

function specScanKey(spec: RawEvidenceSpec): string {
  return [
    spec.needle,
    normalizedPath(spec.path) ?? '',
    spec.mode ?? 'identifier',
  ].join('\u0000');
}

function reportCacheKey(specs: RawEvidenceSpec[], maxScannedBytes: number): string {
  return [
    String(maxScannedBytes),
    process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND ?? '',
    process.env.CODEGRAPH_RG_PATH ?? '',
    ...specs.map(specScanKey).sort(),
  ].join('\u0001');
}

function cloneReportForSpecs(
  report: RawEvidenceReport,
  specs: RawEvidenceSpec[],
  cacheHit: boolean,
): RawEvidenceReport {
  const requested = new Map(specs.map((spec) => [specScanKey(spec), spec]));
  return {
    ...report,
    cacheHit,
    states: report.states.map((state) => {
      const spec = requested.get(specScanKey(state.spec)) ?? state.spec;
      return {
        ...state,
        spec: { ...spec },
        snippets: state.snippets.map((snippet) => ({ ...snippet })),
      };
    }),
  };
}

function isIdentifierChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_$]/.test(value);
}

function lineContains(line: string, needle: string, mode: 'identifier' | 'literal'): boolean {
  if (mode === 'literal') return line.includes(needle);
  let from = 0;
  while (from <= line.length - needle.length) {
    const index = line.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? undefined : line[index - 1];
    const afterIndex = index + needle.length;
    const after = afterIndex >= line.length ? undefined : line[afterIndex];
    if (!isIdentifierChar(before) && !isIdentifierChar(after)) return true;
    from = index + Math.max(1, needle.length);
  }
  return false;
}

function applicableStates(states: RawEvidenceState[], filePath: string): RawEvidenceState[] {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return states.filter((state) => !state.normalizedPath || normalized.includes(state.normalizedPath));
}

function recordMatchingLine(
  states: RawEvidenceState[],
  filePath: string,
  lineNumber: number,
  line: string,
): void {
  for (const state of applicableStates(states, filePath)) {
    if (!lineContains(line, state.spec.needle, state.spec.mode ?? 'identifier')) continue;
    state.matchingLines++;
    if (state.snippets.length >= RAW_EVIDENCE_MAX_SNIPPETS) continue;
    const compact = line.replace(/\r?\n$/, '').trimEnd();
    state.snippets.push({
      file: filePath,
      line: lineNumber,
      text: compact.length <= RAW_EVIDENCE_MAX_LINE_CHARS
        ? compact
        : `${compact.slice(0, RAW_EVIDENCE_MAX_LINE_CHARS)}…`,
    });
  }
}

interface ScanProgress {
  totalScannedFiles: number;
  totalScannedBytes: number;
  budgetReached: boolean;
  timeBudgetReached: boolean;
  cancelled: boolean;
}

export interface RawEvidenceScanOptions {
  /** Wall-clock budget for inventory, ripgrep, and the Node fallback together. */
  timeoutMs?: number;
  /** Optional caller cancellation; the active ripgrep child is terminated. */
  signal?: AbortSignal;
}

function scanDeadline(timeoutMs: number): number {
  return Date.now() + Math.max(0, timeoutMs);
}

function scanExpired(deadline: number, signal: AbortSignal | undefined): boolean {
  return Date.now() >= deadline || signal?.aborted === true;
}

async function scanFilesWithNode(
  cg: CodeGraph,
  files: ReturnType<CodeGraph['getFiles']>,
  states: RawEvidenceState[],
  maxScannedBytes: number,
  deadline: number,
  signal?: AbortSignal,
  progress: ScanProgress = {
    totalScannedFiles: 0,
    totalScannedBytes: 0,
    budgetReached: false,
    timeBudgetReached: false,
    cancelled: false,
  },
): Promise<ScanProgress> {
  for (const file of files) {
    if (scanExpired(deadline, signal)) {
      if (signal?.aborted) progress.cancelled = true;
      else progress.timeBudgetReached = true;
      break;
    }
    const applicable = applicableStates(states, file.path);
    if (applicable.length === 0) continue;
    if (progress.totalScannedBytes + file.size > maxScannedBytes) {
      progress.budgetReached = true;
      break;
    }
    const abs = validatePathWithinRoot(cg.getProjectRoot(), file.path);
    if (!abs) {
      for (const state of applicable) state.unreadableFiles++;
      continue;
    }
    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch {
      for (const state of applicable) state.unreadableFiles++;
      continue;
    }
    const actualBytes = Buffer.byteLength(content, 'utf-8');
    progress.totalScannedBytes += actualBytes;
    progress.totalScannedFiles++;
    for (const state of applicable) {
      state.scannedFiles++;
      state.scannedBytes += actualBytes;
    }

    // Avoid allocating line arrays for the overwhelmingly common no-hit file.
    if (!applicable.some((state) => content.includes(state.spec.needle))) continue;
    const lines = content.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      recordMatchingLine(applicable, file.path, lineIndex + 1, lines[lineIndex]!);
    }
  }
  return progress;
}

function rgGlobArgs(files: ReturnType<CodeGraph['getFiles']>): string[] | null {
  const extensions = new Set<string>();
  const extensionless = new Set<string>();
  for (const file of files) {
    const extension = extname(file.path);
    if (extension) extensions.add(extension);
    else extensionless.add(basename(file.path));
  }
  // A project with hundreds of extensionless source basenames would create an
  // unwieldy rg command. The deterministic Node backend remains correct there.
  if (extensionless.size > 32) return null;
  const args: string[] = [];
  for (const extension of [...extensions].sort()) args.push('--glob', `*${extension}`);
  for (const name of [...extensionless].sort()) args.push('--glob', name);
  return args;
}

function normalizeRgPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').toLowerCase();
}

interface RipgrepResult {
  stdout: string;
  status: number | null;
  error?: Error;
  interruption?: 'timeout' | 'cancelled' | 'output_limit';
}

/** Run one rg process without blocking the daemon's event loop. */
function runRipgrep(
  executable: string,
  args: string[],
  cwd: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<RipgrepResult> {
  if (scanExpired(deadline, signal)) {
    return Promise.resolve({
      stdout: '',
      status: null,
      interruption: signal?.aborted ? 'cancelled' : 'timeout',
    });
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stdoutBytes = 0;
    let interruption: RipgrepResult['interruption'];
    let settled = false;
    let processError: Error | undefined;
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ stdout, status, error: processError, interruption });
    };
    const stop = (reason: NonNullable<RipgrepResult['interruption']>) => {
      if (interruption) return;
      interruption = reason;
      child.kill();
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), Math.max(1, deadline - Date.now()));
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (interruption) return;
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > RAW_EVIDENCE_MAX_RG_OUTPUT_BYTES) {
        stop('output_limit');
        return;
      }
      stdout += chunk;
    });
    child.once('error', (error) => {
      processError = error;
      finish(null);
    });
    child.once('close', (status) => finish(status));
  });
}

/**
 * Global evidence legitimately scans `.`. When every spec has a path,
 * however, pass only the union of matching indexed files to rg. Chunking keeps
 * Windows command lines bounded without widening a 13 KiB file assertion into
 * a 374 MiB repository scan.
 */
function rgTargetBatches(
  files: ReturnType<CodeGraph['getFiles']>,
  states: RawEvidenceState[],
): string[][] {
  if (states.some((state) => !state.normalizedPath)) return [['.']];
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const file of files) {
    const target = file.path.replace(/\\/g, '/');
    const cost = target.length + 1;
    if (current.length > 0 && (
      current.length >= RAW_EVIDENCE_MAX_RG_TARGETS_PER_BATCH ||
      chars + cost > RAW_EVIDENCE_MAX_RG_TARGET_CHARS
    )) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(target);
    chars += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function recordRipgrepOutput(
  output: string,
  visible: Set<string>,
  byPath: Map<string, ReturnType<CodeGraph['getFiles']>[number]>,
  states: RawEvidenceState[],
): void {
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine) continue;
    let message: any;
    try { message = JSON.parse(rawLine); } catch { continue; }
    if (message?.type !== 'match') continue;
    const rawPath = message.data?.path?.text;
    const sourceLine = message.data?.lines?.text;
    const lineNumber = message.data?.line_number;
    if (typeof rawPath !== 'string' || typeof sourceLine !== 'string' || typeof lineNumber !== 'number') continue;
    const file = byPath.get(normalizeRgPath(rawPath));
    if (!file || !visible.has(normalizeRgPath(file.path))) continue;
    recordMatchingLine(states, file.path, lineNumber, sourceLine);
  }
}

/**
 * Use the bundled ripgrep binary as an acceleration layer while preserving
 * CodeGraph's exact indexed-file completeness contract. `rg --files` audits
 * which indexed files the search invocation can see; any uncovered indexed
 * files are read by the Node fallback before absence can be claimed.
 */
async function scanWithRipgrep(
  cg: CodeGraph,
  files: ReturnType<CodeGraph['getFiles']>,
  states: RawEvidenceState[],
  maxScannedBytes: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<{ progress: ScanProgress; backend: 'ripgrep' | 'hybrid' } | null> {
  if (process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND === 'node') return null;
  if (files.length === 0) return null;
  const indexedBytes = files.reduce((sum, file) => sum + file.size, 0);
  const forceRipgrep = process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND === 'ripgrep';
  // Process startup dominates tiny repositories. Keep the zero-dependency
  // in-process scan there; rg becomes the clear win once file count or bytes
  // are material (the OceanBase case is 14k files / 374 MiB).
  if (!forceRipgrep && files.length < 200 && indexedBytes < 4 * 1024 * 1024) return null;
  if (indexedBytes > maxScannedBytes) return null;
  const globArgs = rgGlobArgs(files);
  if (!globArgs) return null;
  const executable = process.env.CODEGRAPH_RG_PATH?.trim() || bundledRgPath;
  const cwd = cg.getProjectRoot();
  const common = ['--hidden', '--no-messages', ...globArgs];
  const targetBatches = rgTargetBatches(files, states);
  if (targetBatches.length === 0) return null;
  const visible = new Set<string>();
  for (const targets of targetBatches) {
    const inventory = await runRipgrep(executable, ['--files', '--null', ...common, '--', ...targets], cwd, deadline, signal);
    if (inventory.interruption) {
      return {
        progress: {
          totalScannedFiles: 0,
          totalScannedBytes: 0,
          budgetReached: inventory.interruption === 'output_limit',
          timeBudgetReached: inventory.interruption === 'timeout',
          cancelled: inventory.interruption === 'cancelled',
        },
        backend: 'ripgrep',
      };
    }
    if (inventory.error || inventory.status !== 0) return null;
    for (const file of inventory.stdout.split('\0').map(normalizeRgPath).filter(Boolean)) visible.add(file);
  }
  const byPath = new Map(files.map((file) => [normalizeRgPath(file.path), file]));
  const covered = files.filter((file) => visible.has(normalizeRgPath(file.path)));
  const missing = files.filter((file) => !visible.has(normalizeRgPath(file.path)));
  if (covered.length === 0 && files.length > 0) return null;

  const patterns = [...new Set(states.map((state) => state.spec.needle))];
  const searchOutputs: string[] = [];
  for (const targets of targetBatches) {
    const search = await runRipgrep(executable, [
      '--json', '--fixed-strings', '--case-sensitive', '--text', ...common,
      ...patterns.flatMap((pattern) => ['--regexp', pattern]),
      '--', ...targets,
    ], cwd, deadline, signal);
    searchOutputs.push(search.stdout);
    if (search.interruption) {
      for (const output of searchOutputs) recordRipgrepOutput(output, visible, byPath, states);
      return {
        progress: {
          totalScannedFiles: 0,
          totalScannedBytes: 0,
          budgetReached: search.interruption === 'output_limit',
          timeBudgetReached: search.interruption === 'timeout',
          cancelled: search.interruption === 'cancelled',
        },
        backend: 'ripgrep',
      };
    }
    if (search.error || (search.status !== 0 && search.status !== 1)) return null;
  }

  const progress: ScanProgress = {
    totalScannedFiles: covered.length,
    totalScannedBytes: covered.reduce((sum, file) => sum + file.size, 0),
    budgetReached: false,
    timeBudgetReached: false,
    cancelled: false,
  };
  for (const file of covered) {
    for (const state of applicableStates(states, file.path)) {
      state.scannedFiles++;
      state.scannedBytes += file.size;
    }
  }

  for (const output of searchOutputs) recordRipgrepOutput(output, visible, byPath, states);

  if (missing.length > 0) {
    await scanFilesWithNode(cg, missing, states, maxScannedBytes, deadline, signal, progress);
  }
  return { progress, backend: missing.length > 0 ? 'hybrid' : 'ripgrep' };
}

/**
 * Scan current on-disk contents of indexed source files once for several
 * graph misses. Completeness accounting remains internal so a partial scan can
 * never masquerade as absence, while model-facing output stays grep-like.
 */
export async function scanRawSourceEvidence(
  cg: CodeGraph,
  inputSpecs: RawEvidenceSpec[],
  maxScannedBytes = RAW_EVIDENCE_MAX_SCANNED_BYTES,
  options: RawEvidenceScanOptions = {},
): Promise<RawEvidenceReport> {
  const specs = normalizedSpecs(inputSpecs);
  const configuredTimeoutText = process.env.CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS?.trim();
  const configuredTimeout = configuredTimeoutText ? Number(configuredTimeoutText) : Number.NaN;
  const timeoutMs = options.timeoutMs ?? (
    Number.isFinite(configuredTimeout) && configuredTimeout >= 0
      ? configuredTimeout
      : RAW_EVIDENCE_DEFAULT_TIMEOUT_MS
  );
  const deadline = scanDeadline(timeoutMs);
  const pending = cg.getPendingFiles();
  const cacheable = cg.isWatching() && pending.length === 0;
  const epoch = cg.getLastIndexedAt();
  const cacheKey = reportCacheKey(specs, maxScannedBytes);
  if (!cacheable) {
    rawEvidenceCache.delete(cg);
  } else {
    let bucket = rawEvidenceCache.get(cg);
    if (bucket?.epoch !== epoch) {
      bucket = { epoch, entries: new Map() };
      rawEvidenceCache.set(cg, bucket);
    }
    const cached = bucket.entries.get(cacheKey);
    if (cached) {
      bucket.entries.delete(cacheKey);
      bucket.entries.set(cacheKey, cached);
      return cloneReportForSpecs(cached, specs, true);
    }
  }
  const allFiles = cg.getFiles().filter((file) => !CONFIG_LEAF_LANGUAGES.has(file.language));
  const states: RawEvidenceState[] = specs.map((spec) => {
    const path = normalizedPath(spec.path);
    return {
      spec,
      normalizedPath: path,
      eligibleFiles: allFiles.filter((file) => !path || file.path.replace(/\\/g, '/').toLowerCase().includes(path)).length,
      scannedFiles: 0,
      scannedBytes: 0,
      unreadableFiles: 0,
      matchingLines: 0,
      snippets: [],
    };
  });
  // This union is the authoritative search scope. Passing it into both rg and
  // the fallback ensures path-constrained misses never enumerate or read the
  // rest of the repository merely to discard those results afterward.
  const files = allFiles.filter((file) => applicableStates(states, file.path).length > 0);

  const accelerated = await scanWithRipgrep(cg, files, states, maxScannedBytes, deadline, options.signal);
  const progress = accelerated?.progress ?? await scanFilesWithNode(
    cg,
    files,
    states,
    maxScannedBytes,
    deadline,
    options.signal,
  );

  const report: RawEvidenceReport = {
    states,
    totalScannedFiles: progress.totalScannedFiles,
    totalScannedBytes: progress.totalScannedBytes,
    budgetReached: progress.budgetReached,
    timeBudgetReached: progress.timeBudgetReached,
    cancelled: progress.cancelled,
    omittedQueries: Math.max(0, inputSpecs.length - specs.length),
    backend: accelerated?.backend ?? 'node',
    cacheHit: false,
  };
  // A file event or sync that landed during the scan invalidates the snapshot;
  // do not cache it. With no active watcher we deliberately trade speed for
  // current-source correctness.
  const completeForCache = !report.budgetReached && !report.timeBudgetReached && !report.cancelled && report.states.every((state) =>
    state.eligibleFiles > 0 &&
    state.scannedFiles === state.eligibleFiles &&
    state.unreadableFiles === 0
  );
  if (cacheable && completeForCache && cg.getPendingFiles().length === 0 && cg.getLastIndexedAt() === epoch) {
    let bucket = rawEvidenceCache.get(cg);
    if (!bucket || bucket.epoch !== epoch) {
      bucket = { epoch, entries: new Map() };
      rawEvidenceCache.set(cg, bucket);
    }
    bucket.entries.set(cacheKey, cloneReportForSpecs(report, specs, false));
    while (bucket.entries.size > RAW_EVIDENCE_CACHE_MAX_ENTRIES) {
      const oldest = bucket.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      bucket.entries.delete(oldest);
    }
  }
  return report;
}

function formatMatchCount(count: number): string {
  return `${count} raw-source match${count === 1 ? '' : 'es'}`;
}

function appendCompactSnippets(out: string[], state: RawEvidenceState): void {
  const byFile = new Map<string, RawEvidenceSnippet[]>();
  for (const snippet of state.snippets) {
    const entries = byFile.get(snippet.file) ?? [];
    entries.push(snippet);
    byFile.set(snippet.file, entries);
  }
  for (const [file, snippets] of byFile) {
    out.push(`${file}:`);
    for (const snippet of snippets) out.push(`  Line ${snippet.line}: ${snippet.text}`);
  }
  if (state.matchingLines > state.snippets.length) {
    out.push(`  … ${state.matchingLines - state.snippets.length} more match(es) not shown`);
  }
}

function incompleteReason(report: RawEvidenceReport, state: RawEvidenceState): string {
  if (report.cancelled) return 'request cancelled';
  if (report.timeBudgetReached) return 'time budget reached';
  if (report.budgetReached) return 'scan budget reached';
  if (state.unreadableFiles > 0) return `${state.unreadableFiles} unreadable file(s)`;
  if (state.eligibleFiles === 0) return 'no eligible indexed files';
  return 'scope not fully scanned';
}

/** Render compact grep-like results while preserving absence safety. */
export function formatRawSourceEvidence(report: RawEvidenceReport): string {
  const out: string[] = [];
  for (const state of report.states) {
    const complete = !report.budgetReached && !report.timeBudgetReached && !report.cancelled && state.eligibleFiles > 0 &&
      state.scannedFiles === state.eligibleFiles && state.unreadableFiles === 0;
    const declarationOnly = state.spec.purpose === 'declaration_only';
    const label = state.spec.label.replace(/`/g, '\\`');
    const needle = state.spec.needle.replace(/`/g, '\\`');
    if (out.length > 0) out.push('');

    if (declarationOnly) {
      out.push(`No indexed definition for \`${label}\` (DECLARATION_ONLY; do not rerun Grep).`);
      if (state.matchingLines > 0) {
        out.push(`Found ${formatMatchCount(state.matchingLines)} for \`${needle}\`:`);
        appendCompactSnippets(out, state);
        out.push('Raw matches may be other overloads or call sites, not definitions of this exact overload.');
      }
      if (!complete) {
        out.push(`Scan incomplete: ${incompleteReason(report, state)}; ${state.scannedFiles}/${state.eligibleFiles} files scanned.`);
      }
      continue;
    }

    if (state.matchingLines > 0) {
      out.push(`Found ${formatMatchCount(state.matchingLines)} for \`${label}\` (RAW_MATCHES; possible index/parser gap):`);
      appendCompactSnippets(out, state);
      if (!complete) {
        out.push(`Scan incomplete: ${incompleteReason(report, state)}; more matches may exist (${state.scannedFiles}/${state.eligibleFiles} files scanned).`);
      }
      continue;
    }

    const scope = state.spec.path ? ` in \`${state.spec.path.replace(/`/g, '\\`')}\`` : '';
    if (complete) {
      out.push(
        `No raw-source matches for \`${label}\`${scope} — complete scan of ${state.scannedFiles} file(s) ` +
        '(CONFIRMED_ABSENT; do not rerun Grep).',
      );
    } else {
      out.push(
        `Raw-source scan incomplete for \`${label}\`${scope} ` +
        `(INCONCLUSIVE: ${incompleteReason(report, state)}; ${state.scannedFiles}/${state.eligibleFiles} files scanned). Absence is not proven.`,
      );
    }
  }
  if (report.omittedQueries > 0) {
    out.push('', `${report.omittedQueries} additional quer${report.omittedQueries === 1 ? 'y was' : 'ies were'} omitted by the ${RAW_EVIDENCE_MAX_QUERIES}-query cap.`);
  }
  return out.join('\n');
}
