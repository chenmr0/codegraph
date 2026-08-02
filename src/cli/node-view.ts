/**
 * `codegraph node` CLI command — rendering core.
 *
 * Mirrors the MCP `codegraph_node` tool's two modes so the same capability
 * works in scripts / CI / git hooks without a running MCP server:
 *
 *   1. FILE MODE (a `file` with no `symbol`) — read a whole source file like
 *      the Read tool (numbered lines, `offset`/`limit` paging), with a
 *      one-line blast-radius header. `symbolsOnly` returns the structural
 *      outline instead. Config/data files are summarized by key only (values
 *      withheld for safety, #383); an unreadable file falls back to its
 *      symbol map.
 *   2. SYMBOL MODE (a `symbol`, optionally pinned by `file`/`line`) — a
 *      symbol's location / signature / docstring, plus its full source (or a
 *      container outline) and its call trail (callees / callers, with
 *      synthesized-edge notes) and C/C++ declaration-definition links.
 *      Same-name overloads are all returned in one call.
 *
 * Output is plain text (no ANSI) plus a structured `json` payload for
 * `--json`. Logic is shared with the MCP handler via `../mcp/node-helpers`
 * (symbol resolution + synthesized-edge labeling) so the two stay in lockstep.
 */

import type CodeGraph from '../index';
import type { Node, Edge } from '../types';
import { validatePathWithinRoot, CONFIG_LEAF_LANGUAGES } from '../utils';
import { isGeneratedFile } from '../extraction/generated-detection';
import { readFileSync } from 'fs';
import {
  CONTAINER_NODE_KINDS,
  displaySymbol,
  lastQualifierPart,
  numberSourceLines,
  matchesSymbol,
  synthEdgeNote,
} from '../mcp/node-helpers';

export interface NodeViewArgs {
  /** Symbol name (bare or qualified). When omitted with `file`, enters file mode. */
  symbol?: string;
  /** File path or basename. Alone → file mode; with `symbol` → disambiguation hint. */
  file?: string;
  /** 1-based line used to pin a specific overload (symbol mode). */
  line?: number;
  /** File mode: 1-based start line (like Read). */
  offset?: number;
  /** File mode: max line count (like Read). */
  limit?: number;
  /** Symbol mode: include the symbol's full source (like `includeCode`). */
  includeCode?: boolean;
  /** File mode: return the symbol outline instead of the source. */
  symbolsOnly?: boolean;
}

export interface NodeViewResult {
  json: unknown;
  text: string;
}

// Read-parity ceilings — match the MCP handler's handleFileView so the CLI
// never silently truncates more aggressively than the tool an agent uses.
const CHAR_BUDGET = 38_000;
const DEFAULT_LIMIT = 2000;
const TRAIL_CAP = 12;
const DECL_DEF_CAP = 6;
const OUTLINE_CAP = 200;
const MULTI_BODY_BUDGET = 12_000;
const MULTI_HARD_CAP = 16;
const MULTI_LIST_CAP = 20;

/** Trail entry: a connected node + the edge that reached it. */
interface TrailEntry {
  name: string;
  kind: string;
  filePath: string;
  startLine?: number;
  synth?: string;
}

/**
 * Build the `codegraph node` view. Returns `{ text, json }`; the CLI command
 * prints one based on `--json`.
 */
export async function buildNodeView(cg: CodeGraph, args: NodeViewArgs): Promise<NodeViewResult> {
  const symbol = args.symbol?.trim() ?? '';
  const fileHint = args.file?.trim() || undefined;

  // FILE MODE: a file with no symbol reads the file (or its outline).
  if (!symbol && fileHint) {
    return buildFileView(cg, fileHint, {
      offset: args.offset,
      limit: args.limit,
      symbolsOnly: args.symbolsOnly === true,
    });
  }

  return buildSymbolView(cg, symbol, {
    fileHint,
    lineHint: args.line,
    includeCode: args.includeCode === true,
  });
}

// ============================================================================
// File mode
// ============================================================================

interface FileViewOpts {
  offset?: number;
  limit?: number;
  symbolsOnly: boolean;
}

async function buildFileView(cg: CodeGraph, fileArg: string, opts: FileViewOpts): Promise<NodeViewResult> {
  const allFiles = cg.getFiles();
  if (allFiles.length === 0) {
    return result({ mode: 'no-index' }, 'No files indexed. Run `codegraph index` first.');
  }

  const wantLower = normalizePath(fileArg).toLowerCase();
  let resolved = allFiles.find((f) => f.path.toLowerCase() === wantLower);
  let candidates: typeof allFiles = [];
  if (!resolved) {
    candidates = allFiles.filter((f) => f.path.toLowerCase().endsWith('/' + wantLower));
    if (candidates.length === 1) resolved = candidates[0];
  }
  if (!resolved && candidates.length === 0) {
    candidates = allFiles.filter((f) => f.path.toLowerCase().includes(wantLower));
    if (candidates.length === 1) resolved = candidates[0];
  }
  if (!resolved && candidates.length > 1) {
    const list = candidates.slice(0, 25).map((f) => `- ${f.path}`).join('\n');
    return result(
      { mode: 'file-ambiguous', query: fileArg, candidates: candidates.slice(0, 25).map((f) => f.path) },
      [`"${fileArg}" matches ${candidates.length} indexed files — pass a longer path:`, '', list].join('\n'),
    );
  }
  if (!resolved) {
    return result(
      { mode: 'file-not-found', query: fileArg },
      `No indexed file matches "${fileArg}". Codegraph indexes source files; configs/docs it doesn't parse won't appear — Read those directly.`,
    );
  }

  const filePath = resolved.path;
  const nodes = cg.getNodesInFile(filePath)
    .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
    .sort((a, b) => a.startLine - b.startLine);
  const dependents = cg.getFileDependents(filePath);
  const depSummary = formatDependents(dependents);

  // symbolsOnly → the cheap structural overview, no source.
  if (opts.symbolsOnly) {
    const symbols = nodes.slice(0, OUTLINE_CAP).map(symbolJson);
    const lines = [`**${filePath}** — ${nodes.length} symbol${nodes.length === 1 ? '' : 's'}, ${depSummary}`, ''];
    if (nodes.length) lines.push(...symbolMapLines(nodes));
    else lines.push('_No indexed symbols in this file._');
    lines.push('', '> Drop --symbols-only (or pass --offset/--limit) to read the source, like Read.');
    return result(
      { mode: 'file-symbols', filePath, symbolCount: nodes.length, dependents, symbols },
      lines.join('\n'),
    );
  }

  // SECURITY (#383): never dump a raw config/data file — summarize by key.
  if (CONFIG_LEAF_LANGUAGES.has(resolved.language)) {
    const keys = nodes.slice(0, OUTLINE_CAP).map(symbolJson);
    const lines = [`**${filePath}** — configuration/data file, ${depSummary}`, ''];
    if (nodes.length) lines.push(...symbolMapLines(nodes, '### Keys (values withheld for safety)'));
    lines.push('', '> Values may be secrets, so codegraph indexes keys only. Read the file directly if you need a value.');
    return result(
      { mode: 'file-config', filePath, dependents, keys },
      lines.join('\n'),
    );
  }

  // Read the current bytes from disk through the security chokepoint (#527).
  const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
  let content: string | null = null;
  if (abs) {
    try { content = readFileSync(abs, 'utf-8'); } catch { content = null; }
  }
  if (content === null) {
    const symbols = nodes.slice(0, OUTLINE_CAP).map(symbolJson);
    const lines = [`**${filePath}** — could not read from disk (it may have moved since indexing). ${depSummary}`, ''];
    if (nodes.length) lines.push(...symbolMapLines(nodes));
    lines.push('', `> Read \`${filePath}\` directly for its current content.`);
    return result(
      { mode: 'file-unreadable', filePath, dependents, symbols },
      lines.join('\n'),
    );
  }

  const fileLines = content.split('\n');
  const total = fileLines.length;
  const offset = Math.max(1, opts.offset ?? 1);
  if (offset > total) {
    return result(
      { mode: 'file-empty-window', filePath, totalLines: total, dependents },
      `**${filePath}** has ${total} line${total === 1 ? '' : 's'} — offset ${offset} is past the end. ${depSummary}`,
    );
  }
  const maxLines = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const start = offset - 1; // 0-based
  const header = `**${filePath}** — ${total} lines, ${nodes.length} symbol${nodes.length === 1 ? '' : 's'} · ${depSummary}`;

  const numbered: string[] = [];
  let used = header.length + 8;
  let i = start;
  for (; i < total && numbered.length < maxLines; i++) {
    const ln = `${i + 1}\t${fileLines[i]}`;
    if (used + ln.length + 1 > CHAR_BUDGET && numbered.length > 0) break;
    numbered.push(ln);
    used += ln.length + 1;
  }
  const shownEnd = start + numbered.length;
  const complete = offset === 1 && shownEnd >= total;

  const out: string[] = [header, '', ...numbered];
  if (!complete) {
    const parts: string[] = [`(showing lines ${offset}–${shownEnd} of ${total}`];
    if (shownEnd < total) parts.push(`— pass --offset ${shownEnd + 1} for the next page`);
    parts.push(')');
    out.push('', parts.join(' '));
  }

  return result(
    {
      mode: 'file',
      filePath,
      totalLines: total,
      symbolCount: nodes.length,
      dependents,
      offset,
      limit: maxLines,
      shownLines: [offset, shownEnd],
      complete,
      source: numbered.join('\n'),
    },
    out.join('\n'),
  );
}

// ============================================================================
// Symbol mode
// ============================================================================

interface SymbolViewOpts {
  fileHint?: string;
  lineHint?: number;
  includeCode: boolean;
}

async function buildSymbolView(cg: CodeGraph, symbol: string, opts: SymbolViewOpts): Promise<NodeViewResult> {
  let matches = findSymbolMatches(cg, symbol);
  if (matches.length === 0) {
    return result(
      { mode: 'symbol-not-found', symbol },
      `Symbol "${symbol}" not found in the codebase`,
    );
  }

  // Disambiguate an overloaded name to a specific definition pinned by file/line.
  if (matches.length > 1 && (opts.fileHint || opts.lineHint !== undefined)) {
    const narrowed = narrowMatches(matches, opts.fileHint, opts.lineHint);
    if (narrowed.length > 0) matches = narrowed;
  }

  if (matches.length === 1) {
    const node = matches[0]!;
    const rendered = await renderSymbolSection(cg, node, opts.includeCode);
    return result(
      { mode: 'symbol', symbol, match: await symbolMatchJson(cg, node, opts.includeCode) },
      rendered,
    );
  }

  // Multiple definitions share this name — return them ALL.
  const header = `**${matches.length} definitions named "${symbol}"**`;
  if (!opts.includeCode) {
    const list = matches.map((n) => `- \`${displaySymbol(n)}\` (${n.kind}) — ${n.filePath}:${n.startLine}`);
    return result(
      { mode: 'symbol-multi', symbol, count: matches.length, listed: matches.map(nodeJson), rendered: [] },
      [header, '', 'Re-query with --code to get every body in one call — no need to pick one first.', '', ...list].join('\n'),
    );
  }

  const rendered: string[] = [];
  const listed: Node[] = [];
  let used = 0;
  for (const n of matches) {
    if (rendered.length >= MULTI_HARD_CAP) { listed.push(n); continue; }
    const section = await renderSymbolSection(cg, n, true);
    if (rendered.length === 0 || used + section.length <= MULTI_BODY_BUDGET) {
      rendered.push(section);
      used += section.length;
    } else {
      listed.push(n);
    }
  }

  const out: string[] = [
    header,
    `Returning ${rendered.length} in full${listed.length ? `; ${listed.length} more listed below` : ''} — pick the one you need (no Read required).`,
    '',
    rendered.join('\n\n---\n\n'),
  ];
  if (listed.length) {
    const shownList = listed.slice(0, MULTI_LIST_CAP);
    out.push('', '### Other definitions', ...shownList.map((n) => `- \`${displaySymbol(n)}\` (${n.kind}) — ${n.filePath}:${n.startLine}`));
    if (listed.length > MULTI_LIST_CAP) out.push(`- … +${listed.length - MULTI_LIST_CAP} more`);
  }

  return result(
    {
      mode: 'symbol-multi',
      symbol,
      count: matches.length,
      rendered: rendered,
      listed: listed.slice(0, MULTI_LIST_CAP).map(nodeJson),
    },
    out.join('\n'),
  );
}

/**
 * Resolve a (bare or qualified) symbol to every matching definition, ranked
 * with generated files last. Mirrors the MCP handler's `findSymbolMatches`.
 */
function findSymbolMatches(cg: CodeGraph, symbol: string): Node[] {
  const isQualified = /[.\/]|::/.test(symbol);

  if (!isQualified) {
    const exact = cg.getNodesByName(symbol);
    if (exact.length > 0) {
      return [...exact].sort((a, b) => (isGeneratedFile(a.filePath) ? 1 : 0) - (isGeneratedFile(b.filePath) ? 1 : 0));
    }
    const fuzzy = cg.searchNodes(symbol, { limit: 10 });
    return fuzzy[0] ? [fuzzy[0].node] : [];
  }

  const limit = 50;
  let results = cg.searchNodes(symbol, { limit });
  if (results.length === 0) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
  }
  if (results.length === 0) return [];

  const exactMatches = results.filter((r) => matchesSymbol(r.node, symbol));
  if (exactMatches.length === 0) {
    return isQualified ? [] : results[0] ? [results[0].node] : [];
  }
  return [...exactMatches]
    .sort((a, b) => (isGeneratedFile(a.node.filePath) ? 1 : 0) - (isGeneratedFile(b.node.filePath) ? 1 : 0))
    .map((r) => r.node);
}

/**
 * Narrow an overloaded set by file (path suffix/substring) then by line
 * (body-containing def, else nearest start). Only narrows — a hint that
 * matches nothing is ignored. Mirrors the MCP handler's disambiguator.
 */
function narrowMatches(matches: Node[], fileHint?: string, lineHint?: number): Node[] {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  let narrowed = matches;
  if (fileHint) {
    const fh = norm(fileHint);
    const byFile = narrowed.filter((n) => norm(n.filePath).endsWith(fh) || norm(n.filePath).includes(fh));
    if (byFile.length > 0) narrowed = byFile;
  }
  if (lineHint !== undefined && narrowed.length > 1) {
    const containing = narrowed.filter((n) => n.startLine <= lineHint && (n.endLine ?? n.startLine) >= lineHint);
    narrowed = containing.length > 0
      ? containing
      : [...narrowed].sort((a, b) => Math.abs(a.startLine - lineHint) - Math.abs(b.startLine - lineHint)).slice(0, 1);
  }
  return narrowed;
}

/** Render one symbol: details + (source or outline) + trail + decl/def links. */
async function renderSymbolSection(cg: CodeGraph, node: Node, includeCode: boolean): Promise<string> {
  let code: string | null = null;
  let outline: string | null = null;
  if (includeCode) {
    if (CONTAINER_NODE_KINDS.has(node.kind)) {
      outline = buildContainerOutline(cg, node);
    }
    if (!outline) {
      code = await cg.getCode(node.id);
    }
  }
  return formatNodeDetails(node, code, outline) + formatTrail(cg, node);
}

function buildContainerOutline(cg: CodeGraph, node: Node): string {
  const children = cg.getChildren(node.id)
    .filter((c) => c.kind !== 'import' && c.kind !== 'export')
    .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  if (children.length === 0) return '';
  const lines = [`**Members (${children.length}):**`, ''];
  for (const c of children) {
    const loc = c.startLine ? `:${c.startLine}` : '';
    const sig = c.signature ? ` — \`${c.signature}\`` : '';
    lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
  }
  return lines.join('\n');
}

function formatNodeDetails(node: Node, code: string | null, outline?: string | null): string {
  const location = node.startLine ? `:${node.startLine}` : '';
  const lines: string[] = [
    `## ${node.name} (${node.kind})`,
    '',
    `**Location:** ${node.filePath}${location}`,
  ];
  if (node.signature) lines.push(`**Signature:** \`${node.signature}\``);
  if (node.docstring && node.docstring.length < 200) lines.push('', node.docstring);

  if (outline) {
    lines.push('', outline, '',
      `> Structural outline only. Read \`${node.filePath}\` or call codegraph node on a specific member for its body.`);
  } else if (code) {
    const numbered = node.startLine ? numberSourceLines(code, node.startLine) : code;
    lines.push('', '```' + node.language, numbered, '```');
  }
  return lines.join('\n');
}

/** The call trail: direct callees + callers, each with file:line (+ synth note). */
function formatTrail(cg: CodeGraph, node: Node): string {
  const declDef = formatDeclDef(cg, node);
  const callees = dedupeTrail(cg.getCallees(node.id), node.id);
  const callers = dedupeTrail(cg.getCallers(node.id), node.id);
  if (callees.length === 0 && callers.length === 0) return declDef;

  const lines: string[] = ['', '### Trail — codegraph node any of these to follow it (no Read needed)'];
  if (callees.length > 0) {
    lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmtTrailEntry).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
  }
  if (callers.length > 0) {
    lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmtTrailEntry).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
  }
  return (declDef ? declDef + '\n' : '') + lines.join('\n');
}

function fmtTrailEntry(e: TrailEntry): string {
  const loc = e.startLine ? `:${e.startLine}` : '';
  const base = `${e.name} (${e.filePath}${loc})`;
  return e.synth ? `${base} [${e.synth}]` : base;
}

function dedupeTrail(edges: Array<{ node: Node; edge: Edge }>, selfId: string): TrailEntry[] {
  const seen = new Set<string>([selfId]);
  const out: TrailEntry[] = [];
  for (const e of edges) {
    if (seen.has(e.node.id)) continue;
    seen.add(e.node.id);
    const synth = synthEdgeNote(e.edge);
    out.push({
      name: e.node.name,
      kind: e.node.kind,
      filePath: e.node.filePath,
      startLine: e.node.startLine,
      synth: synth?.compact,
    });
  }
  return out;
}

/** C/C++ declaration ↔ definition link, surfacing a dead-end declaration's real trail. */
function formatDeclDef(cg: CodeGraph, node: Node): string {
  const out = cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'defines');
  const inc = cg.getIncomingEdges(node.id).filter((e) => e.kind === 'defines');
  if (out.length === 0 && inc.length === 0) return '';

  const ref = (id: string): string => {
    const n = cg.getNode(id);
    return n ? `\`${n.name}\` (${n.filePath}:${n.startLine})` : id;
  };
  const lines: string[] = ['', '### Declaration / Definition'];

  if (out.length > 0) {
    const refs = out.slice(0, DECL_DEF_CAP).map((e) => ref(e.target)).join(', ');
    const more = out.length > DECL_DEF_CAP ? `, +${out.length - DECL_DEF_CAP} more` : '';
    const label = out.length === 1 ? '**Declaration:**' : '**Declarations:**';
    lines.push(`${label} ${refs}${more}`);
  }

  if (inc.length > 0) {
    const refs = inc.slice(0, DECL_DEF_CAP).map((e) => ref(e.source)).join(', ');
    const more = inc.length > DECL_DEF_CAP ? `, +${inc.length - DECL_DEF_CAP} more` : '';
    const label = inc.length === 1 ? '**Definition:**' : '**Definitions:**';
    lines.push(`${label} ${refs}${more}`);

    const firstInc = inc[0];
    if (firstInc) {
      const defCallees = dedupeTrail(cg.getCallees(firstInc.source), node.id);
      const defCallers = dedupeTrail(cg.getCallers(firstInc.source), node.id);
      if (defCallees.length > 0) {
        const shown = defCallees.slice(0, DECL_DEF_CAP);
        lines.push(`**Definition calls →** ${shown.map(fmtTrailEntry).join(', ')}${defCallees.length > DECL_DEF_CAP ? `, +${defCallees.length - DECL_DEF_CAP} more` : ''}`);
      }
      if (defCallers.length > 0) {
        const shown = defCallers.slice(0, DECL_DEF_CAP);
        lines.push(`**Definition called by ←** ${shown.map(fmtTrailEntry).join(', ')}${defCallers.length > DECL_DEF_CAP ? `, +${defCallers.length - DECL_DEF_CAP} more` : ''}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================
// JSON shapes + small helpers
// ============================================================================

function symbolJson(n: Node) {
  return { name: n.name, kind: n.kind, signature: n.signature, startLine: n.startLine };
}

function nodeJson(n: Node) {
  return {
    name: n.name,
    kind: n.kind,
    filePath: n.filePath,
    startLine: n.startLine,
    endLine: n.endLine,
    signature: n.signature,
  };
}

async function symbolMatchJson(cg: CodeGraph, node: Node, includeCode: boolean) {
  let code: string | null = null;
  let outline: string | null = null;
  if (includeCode) {
    if (CONTAINER_NODE_KINDS.has(node.kind)) outline = buildContainerOutline(cg, node);
    if (!outline) code = await cg.getCode(node.id);
  }
  return {
    node: nodeJson(node),
    code,
    outline,
    callees: dedupeTrail(cg.getCallees(node.id), node.id),
    callers: dedupeTrail(cg.getCallers(node.id), node.id),
    declDef: declDefJson(cg, node),
  };
}

function declDefJson(cg: CodeGraph, node: Node) {
  const out = cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'defines');
  const inc = cg.getIncomingEdges(node.id).filter((e) => e.kind === 'defines');
  if (out.length === 0 && inc.length === 0) return null;
  return {
    declarations: out.map((e) => edgeRefJson(cg, e.target)),
    definitions: inc.map((e) => edgeRefJson(cg, e.source)),
  };
}

function edgeRefJson(cg: CodeGraph, id: string) {
  const n = cg.getNode(id);
  return n ? { name: n.name, kind: n.kind, filePath: n.filePath, startLine: n.startLine } : { id };
}

function symbolMapLines(nodes: Node[], heading = '### Symbols'): string[] {
  const lines = [heading];
  for (const n of nodes.slice(0, OUTLINE_CAP)) {
    const sig = n.signature ? ` ${n.signature.replace(/\s+/g, ' ').trim()}` : '';
    lines.push(`- \`${n.name}\` (${n.kind})${sig} — :${n.startLine}`);
  }
  if (nodes.length > OUTLINE_CAP) lines.push(`- … +${nodes.length - OUTLINE_CAP} more`);
  return lines;
}

function formatDependents(dependents: string[]): string {
  if (!dependents.length) return 'no other indexed file depends on it';
  return `used by ${dependents.length} file${dependents.length === 1 ? '' : 's'}: ${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? `, +${dependents.length - 8} more` : ''}`;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^(?:\.?\/+)+/, '').replace(/\/+$/, '');
}

function result(json: unknown, text: string): NodeViewResult {
  return { json, text };
}