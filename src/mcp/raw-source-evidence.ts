import type CodeGraph from '../index';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
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
const RAW_EVIDENCE_MAX_QUERIES = 8;
const RAW_EVIDENCE_MAX_SNIPPETS = 6;
const RAW_EVIDENCE_MAX_LINE_CHARS = 300;

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
}

function scanFilesWithNode(
  cg: CodeGraph,
  files: ReturnType<CodeGraph['getFiles']>,
  states: RawEvidenceState[],
  maxScannedBytes: number,
  progress: ScanProgress = { totalScannedFiles: 0, totalScannedBytes: 0, budgetReached: false },
): ScanProgress {
  for (const file of files) {
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
      content = readFileSync(abs, 'utf-8');
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

/**
 * Use the bundled ripgrep binary as an acceleration layer while preserving
 * CodeGraph's exact indexed-file completeness contract. `rg --files` audits
 * which indexed files the search invocation can see; any uncovered indexed
 * files are read by the Node fallback before absence can be claimed.
 */
function scanWithRipgrep(
  cg: CodeGraph,
  files: ReturnType<CodeGraph['getFiles']>,
  states: RawEvidenceState[],
  maxScannedBytes: number,
): { progress: ScanProgress; backend: 'ripgrep' | 'hybrid' } | null {
  if (process.env.CODEGRAPH_RAW_EVIDENCE_BACKEND === 'node') return null;
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
  const maxBuffer = 64 * 1024 * 1024;

  const inventory = spawnSync(executable, ['--files', '--null', ...common, '.'], {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    windowsHide: true,
  });
  if (inventory.error || inventory.status !== 0 || typeof inventory.stdout !== 'string') return null;
  const visible = new Set(
    inventory.stdout.split('\0').map(normalizeRgPath).filter(Boolean),
  );
  const byPath = new Map(files.map((file) => [normalizeRgPath(file.path), file]));
  const covered = files.filter((file) => visible.has(normalizeRgPath(file.path)));
  const missing = files.filter((file) => !visible.has(normalizeRgPath(file.path)));
  if (covered.length === 0 && files.length > 0) return null;

  const patterns = [...new Set(states.map((state) => state.spec.needle))];
  const searchArgs = [
    '--json', '--fixed-strings', '--case-sensitive', '--text', ...common,
    ...patterns.flatMap((pattern) => ['--regexp', pattern]),
    '.',
  ];
  const search = spawnSync(executable, searchArgs, {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    windowsHide: true,
  });
  if (search.error || (search.status !== 0 && search.status !== 1) || typeof search.stdout !== 'string') return null;

  const progress: ScanProgress = {
    totalScannedFiles: covered.length,
    totalScannedBytes: covered.reduce((sum, file) => sum + file.size, 0),
    budgetReached: false,
  };
  for (const file of covered) {
    for (const state of applicableStates(states, file.path)) {
      state.scannedFiles++;
      state.scannedBytes += file.size;
    }
  }

  for (const rawLine of search.stdout.split(/\r?\n/)) {
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

  if (missing.length > 0) {
    scanFilesWithNode(cg, missing, states, maxScannedBytes, progress);
  }
  return { progress, backend: missing.length > 0 ? 'hybrid' : 'ripgrep' };
}

/**
 * Scan current on-disk contents of indexed source files once for several
 * graph misses. This is grep-equivalent evidence, but with explicit scope and
 * completeness accounting so a partial scan can never masquerade as absence.
 */
export function scanRawSourceEvidence(
  cg: CodeGraph,
  inputSpecs: RawEvidenceSpec[],
  maxScannedBytes = RAW_EVIDENCE_MAX_SCANNED_BYTES,
): RawEvidenceReport {
  const specs = normalizedSpecs(inputSpecs);
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
  const files = cg.getFiles().filter((file) => !CONFIG_LEAF_LANGUAGES.has(file.language));
  const states: RawEvidenceState[] = specs.map((spec) => {
    const path = normalizedPath(spec.path);
    return {
      spec,
      normalizedPath: path,
      eligibleFiles: files.filter((file) => !path || file.path.replace(/\\/g, '/').toLowerCase().includes(path)).length,
      scannedFiles: 0,
      scannedBytes: 0,
      unreadableFiles: 0,
      matchingLines: 0,
      snippets: [],
    };
  });

  const accelerated = scanWithRipgrep(cg, files, states, maxScannedBytes);
  const progress = accelerated?.progress ?? scanFilesWithNode(cg, files, states, maxScannedBytes);

  const report: RawEvidenceReport = {
    states,
    totalScannedFiles: progress.totalScannedFiles,
    totalScannedBytes: progress.totalScannedBytes,
    budgetReached: progress.budgetReached,
    omittedQueries: Math.max(0, inputSpecs.length - specs.length),
    backend: accelerated?.backend ?? 'node',
    cacheHit: false,
  };
  // A file event or sync that landed during the scan invalidates the snapshot;
  // do not cache it. With no active watcher we deliberately trade speed for
  // current-source correctness.
  const completeForCache = !report.budgetReached && report.states.every((state) =>
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

/** Render stable, auditable statuses for model consumption. */
export function formatRawSourceEvidence(report: RawEvidenceReport): string {
  const out: string[] = [
    '## Grep-equivalent current-source evidence',
    '',
    report.cacheHit
      ? `> Reused a source-epoch cache entry from a complete server-side ${report.backend === 'node' ? 'Node fallback' : report.backend} scan covering ${report.totalScannedFiles} indexed source file(s) (${formatBytes(report.totalScannedBytes)}). No pending source edits were observed.`
      : `> One bounded server-side ${report.backend === 'node' ? 'Node fallback' : report.backend} scan covered ${report.totalScannedFiles} indexed source file(s) (${formatBytes(report.totalScannedBytes)}). Generated indexed source was included. This is raw text evidence, not an additional AST claim.`,
  ];
  for (const state of report.states) {
    const complete = !report.budgetReached && state.eligibleFiles > 0 &&
      state.scannedFiles === state.eligibleFiles && state.unreadableFiles === 0;
    const declarationOnly = state.spec.purpose === 'declaration_only';
    const status = declarationOnly
      ? 'DECLARATION_ONLY'
      : state.matchingLines > 0
      ? 'RAW_MATCHES'
      : complete
        ? 'CONFIRMED_ABSENT'
        : 'INCONCLUSIVE';
    out.push(
      '',
      `### ${state.spec.label}`,
      `- Status: **${status}**`,
      `- Needle: \`${state.spec.needle.replace(/`/g, '\\`')}\` (${state.spec.mode ?? 'identifier'})`,
      `- Scope: ${state.spec.path ? `indexed source paths containing \`${state.spec.path}\`` : 'all indexed source files'}`,
      `- Coverage: ${state.scannedFiles}/${state.eligibleFiles} eligible files; ${formatBytes(state.scannedBytes)}; ${state.unreadableFiles} unreadable`,
      `- Matching source lines: ${state.matchingLines}`,
    );
    for (const snippet of state.snippets) {
      out.push(`  - \`${snippet.file}:${snippet.line}\`  ${snippet.text}`);
    }
    if (state.matchingLines > state.snippets.length) {
      out.push(`  - … ${state.matchingLines - state.snippets.length} additional matching line(s) omitted from the response`);
    }
    if (declarationOnly) {
      const rawCoverage = complete
        ? state.matchingLines <= state.snippets.length
          ? 'Every current-source line containing the callable identifier is shown above.'
          : 'The complete current-source occurrence count is authoritative; representative lines are shown above.'
        : 'Raw-source coverage is incomplete, but the structured declaration-only state is unchanged.';
      out.push(
        '- Structured verdict: the exact callable overload has a declaration but no paired indexed definition.',
        `- Raw-evidence verdict: ${rawCoverage} Other overloads and call sites are supporting text evidence, not definitions of this exact overload. Do not run Grep merely to repeat this occurrence scan.`,
      );
    } else if (status === 'CONFIRMED_ABSENT') {
      out.push('- Verdict: the identifier/literal is absent from the complete current-source scope; do not run Grep to reconfirm it.');
    } else if (status === 'RAW_MATCHES') {
      const completeness = complete
        ? state.matchingLines <= state.snippets.length
          ? 'The scan is complete and every matching source line is shown.'
          : 'The scan is complete; the total match count is authoritative and representative lines are shown.'
        : 'The scan scope is incomplete, but the displayed matches are current-source evidence.';
      out.push(`- Verdict: current source contains the raw text above. ${completeness} If the graph lookup was empty, treat this as an index/parser gap; do not run Grep merely to rediscover these matches.`);
    } else {
      out.push(`- Verdict: absence is not proven${report.budgetReached ? ' because the scan budget was reached' : ''}; narrow the indexed path and retry before drawing a conclusion.`);
    }
  }
  if (report.omittedQueries > 0) {
    out.push('', `> ${report.omittedQueries} additional evidence quer${report.omittedQueries === 1 ? 'y was' : 'ies were'} omitted by the ${RAW_EVIDENCE_MAX_QUERIES}-query cap.`);
  }
  return out.join('\n');
}
