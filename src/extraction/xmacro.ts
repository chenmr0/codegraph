/**
 * Self-contained X-macro enum recovery for C/C++.
 *
 * Background
 * -----------
 * tree-sitter's C/C++ grammars have no preprocessor. The "X-macro
 * *construction*" pattern puts three preprocessor directives INSIDE an enum
 * body:
 *
 *   // top of the same file — the X-macro data list, guarded by #ifdef
 *   #ifdef ITEM
 *   ITEM(META_A, ALPHA)
 *   ITEM(META_B, BETA)
 *   #endif
 *
 *   enum E {
 *     LITERAL = 0,
 *   #define ITEM(meta, name) name,
 *   #include "this_header.h"   // self-include re-runs the #ifdef ITEM block
 *   #undef ITEM
 *     MAX
 *   };
 *
 * The `#define` expands to `name,` and the self-`#include` pulls in the data
 * list above, so the enum ends up with `LITERAL, ALPHA, BETA, MAX`. Because
 * tree-sitter doesn't run the preprocessor, it can't see the generated
 * enumerators; and worse, the three directives are not legal
 * `field_declaration_list` children, so ERROR recovery swallows the entire
 * `enum_specifier` — the enum AND every directly-written enumerator vanish (0
 * nodes). A half-finished fix that only blanked the directive lines (recovering
 * the shell + hand-written enumerators but NOT the generated ones) was rejected
 * as incomplete; this module recovers both, and even when the macro guard is
 * unprovable (e.g. an A/B selector) it still blanks the directives to recover
 * the shell + hand-written members — just without synthesizing generated ones
 * it cannot prove.
 *
 * What this module does
 * ----------------------
 * It recovers BOTH the shell and the generated members, generically and
 * conservatively — no project / file / macro names are hard-coded, and no
 * filesystem is read. The macro's data list lives in the SAME source text (a
 * self-`#include` pulls in this very file), so we recover everything from the
 * single source string passed to the extractor.
 *
 *   detectXMacroConstructs(source, filePath)
 *     1. Lexically finds enum bodies (brace-context classification).
 *     2. Inside each enum body, recognizes the three-directive construct
 *        `#define M(formals) rep`, `#include "..."`, `#undef M` with a
 *        consistent macro name M, all closed within the enum body.
 *     3. Validates the `#include` is a SELF-include (normalized path suffix or
 *        basename matches filePath). A non-self include is NOT recovered.
 *     4. Analyzes the replacement body to uniquely identify which formal sits
 *        at the enumerator-name position (`name,` / `name = expr,` / `name`),
 *        rejecting stringify (`#`), token paste (`##`), and multi-candidate or
 *        ambiguous replacements.
 *     5. Returns the source with the three recognized directive lines blanked
 *        to equal-length spaces (newlines preserved — offsets/line numbers
 *        stay exact) so tree-sitter recovers the enum shell + hand-written
 *        enumerators, plus the list of constructs for member synthesis.
 *
 *   scanXMacroCalls(source, macroName, nameParamIndex, excludeRanges)
 *     Scans OUTSIDE enum bodies (and outside preprocessor directive lines) for
 *      `M(...)` invocations, correctly handling whitespace, comments, strings,
 *      nested parentheses, and cross-line arguments. Returns the identifier at
 *      the name-parameter position for each call (rejecting non-identifier
 *      actuals), anchored at the call's line.
 *
 * The extractor (tree-sitter.ts) drives both: it blanks before parse, then —
 * after the tree walk has created the real `enum` nodes + hand-written
 * `enum_member` nodes — it synthesizes `enum_member` nodes + `enum->member`
 * `contains` edges for the generated enumerators, deduped against the
 * hand-written ones.
 *
 * All offsets are JavaScript string indices, matching tree-sitter's
 * `startIndex`/`endIndex` (the codebase reads source via
 * `source.substring(node.startIndex, node.endIndex)`), and every transform is
 * byte-length-preserving so the parse-tree offsets map 1:1 onto the original
 * source.
 */

import type { Language } from '../types';

/** A byte range to blank: chars in [start, end) become spaces (newlines kept). */
export interface XMacroDirectiveRange {
  start: number;
  end: number;
}

/** A recognized self-include X-macro construct inside one enum body. */
export interface XMacroConstruct {
  /** The macro name shared by #define and #undef. */
  macroName: string;
  /** Formal parameter names (leading identifier of each formal). */
  formals: string[];
  /**
   * Index into `formals` of the parameter the replacement places at the
   * enumerator-name position. -1 means the replacement was ambiguous/invalid
   * (stringify, token paste, multi-candidate, no formal at the name spot): the
   * construct is rejected entirely — directives left untouched, nothing
   * blanked and no members synthesized — so unprovable input is not altered.
   */
  nameParamIndex: number;
  /** Raw replacement body text (trimmed, trailing line comments stripped). */
  replacement: string;
  /** Source range of the enum body, including its braces. */
  enumBodyStart: number;
  enumBodyEnd: number;
  /** The three directive ranges (define, include, undef), in source order. */
  directiveRanges: XMacroDirectiveRange[];
  /** Proven data-list calls used to synthesize the enum members. */
  calls: XMacroCall[];
}

export interface XMacroDetectionResult {
  /** Source with recognized construct directive lines blanked (length-preserving). */
  blankedSource: string;
  /** Recognized self-include constructs (for member synthesis). */
  constructs: XMacroConstruct[];
  /** Every enum body in the file; calls inside any enum are never X-list data. */
  enumBodyRanges: XMacroDirectiveRange[];
}

/** A call to the X-macro found in the data list. */
export interface XMacroCall {
  /** The identifier at the name-parameter position. */
  name: string;
  /** 1-based source line of the call's macro-name token. */
  line: number;
  /** 0-based source column of the macro-name token. */
  column: number;
  /** Original macro invocation text, retained for auditability. */
  invocation: string;
}

// Conservative caps so a pathological file can't drive the scanners runaway.
const MAX_CONSTRUCTS = 256;
const MAX_CALLS = 8192;
const MAX_ARGS = 256;
const MAX_MEMBERS = 8192;
const MAX_PAREN_DEPTH = 512;

const isIdentStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

/** Read the leading identifier of a formal segment (e.g. `name`, `args...`→`args`); '' for `...`. */
function leadingIdent(seg: string): string {
  const m = seg.trim().match(/^([A-Za-z_]\w*)/);
  return m ? m[1]! : '';
}

/**
 * Find the offset of the newline that terminates a preprocessor directive
 * starting at `hash`, honoring `\-`line continuation and skipping string,
 * char, and comment content so a `\n` inside one isn't mistaken for the end.
 * Returns source length if the directive runs to EOF.
 */
function findDirectiveEnd(source: string, hash: number): number {
  const n = source.length;
  let i = hash;
  while (i < n) {
    const c = source[i]!;
    if (c === '/' && source[i + 1] === '/') {
      // A line comment ends the directive content at the next newline.
      const e = source.indexOf('\n', i);
      return e === -1 ? n : e;
    }
    if (c === '/' && source[i + 1] === '*') {
      const e = source.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        const ch = source[i]!;
        i++;
        if (ch === '\\') { i++; continue; }
        if (ch === '"') break;
      }
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        const ch = source[i]!;
        i++;
        if (ch === '\\') { i++; continue; }
        if (ch === "'") break;
      }
      continue;
    }
    if (c === '\n') {
      // Line continuation: a backslash immediately before the newline (a `\r`
      // may sit between them on CRLF files) keeps the directive alive.
      let p = i - 1;
      if (p >= 0 && source[p] === '\r') p--;
      if (p >= 0 && source[p] === '\\') { i++; continue; }
      return i;
    }
    i++;
  }
  return n;
}

interface ParsedDirective {
  kind: 'define' | 'include' | 'undef' | 'other';
  /** Offset of the directive's `#`. */
  start: number;
  /** Offset of the terminating newline (exclusive) — blank [start, end). */
  end: number;
  /** Macro name (define/undef). */
  name?: string;
  isFunctionLike?: boolean;
  formals?: string[];
  /** Raw replacement text (define), trimmed, trailing line comment stripped. */
  replacement?: string;
  /** Include path for a quote include. */
  includePath?: string;
  /** True for `#include "..."`, false for `<...>` / malformed. */
  isQuoteInclude?: boolean;
}

/**
 * Parse a single preprocessor directive spanning [hash, dirEnd). Returns the
 * kind + salient fields. Only `define` (function-like), quote `include`, and
 * `undef` carry the fields the construct detector needs.
 */
function parseDirective(source: string, hash: number, dirEnd: number): ParsedDirective {
  const at = (idx: number): string => (idx >= 0 && idx < source.length) ? source[idx]! : '';
  let i = hash + 1;
  while (i < dirEnd && (at(i) === ' ' || at(i) === '\t')) i++;
  let ks = i;
  while (i < dirEnd && isIdentPart(at(i))) i++;
  const keyword = source.slice(ks, i);

  if (keyword === 'define') {
    while (i < dirEnd && (at(i) === ' ' || at(i) === '\t')) i++;
    let ns = i;
    while (i < dirEnd && isIdentPart(at(i))) i++;
    const name = source.slice(ns, i);
    let isFunctionLike = false;
    let formals: string[] = [];
    // Function-like iff `(` immediately follows the name (no space).
    if (i < dirEnd && at(i) === '(') {
      isFunctionLike = true;
      i++; // consume `(`
      const fstart = i;
      let depth = 1;
      while (i < dirEnd && depth > 0) {
        const ch = at(i);
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
        i++;
      }
      const formalsText = source.slice(fstart, i);
      i++; // consume `)`
      formals = formalsText
        .split(',')
        .map(leadingIdent)
        .filter((f) => f.length > 0);
    }
    let rep = source.slice(i, dirEnd).replace(/\\\r?\n/g, ' ').trim();
    // Strip a trailing line comment so `name, // note` → `name,`.
    const lc = rep.indexOf('//');
    if (lc !== -1) rep = rep.slice(0, lc).trim();
    return { kind: 'define', start: hash, end: dirEnd, name, isFunctionLike, formals, replacement: rep };
  }

  if (keyword === 'include') {
    while (i < dirEnd && (at(i) === ' ' || at(i) === '\t')) i++;
    if (i < dirEnd && at(i) === '"') {
      i++;
      const ps = i;
      while (i < dirEnd && at(i) !== '"') i++;
      return { kind: 'include', start: hash, end: dirEnd, includePath: source.slice(ps, i), isQuoteInclude: true };
    }
    // System include `<...>` or malformed — never a self-include candidate.
    return { kind: 'include', start: hash, end: dirEnd, isQuoteInclude: false };
  }

  if (keyword === 'undef') {
    while (i < dirEnd && (at(i) === ' ' || at(i) === '\t')) i++;
    let ns = i;
    while (i < dirEnd && isIdentPart(at(i))) i++;
    return { kind: 'undef', start: hash, end: dirEnd, name: source.slice(ns, i) };
  }

  return { kind: 'other', start: hash, end: dirEnd };
}

/**
 * Decide whether a `{` at `braceIdx` opens an enum body. Scans back over a
 * bounded window, collecting identifier words and skipping whitespace, the
 * base-clause `:`/`,` and `<...>` template params, until a statement boundary
 * (`;`, `}`, `{`, `)`, `(`) or the window limit. The `{` is an enum body iff
 * the keyword `enum` is among the collected words (covers `enum E {`,
 * `enum class E {`, `enum class E : int {`, anonymous `enum {`, and
 * `typedef enum {`). A function body's `{` is preceded by `)` (a boundary) so
 * it stops before reaching any `enum` keyword.
 */
function braceOpensEnumBody(source: string, braceIdx: number): boolean {
  const at = (idx: number): string => (idx >= 0 && idx < source.length) ? source[idx]! : '';
  let k = braceIdx - 1;
  const limit = braceIdx - 512;
  let templateDepth = 0;
  while (k > limit) {
    const c = at(k);
    if (/\s/.test(c)) { k--; continue; }
    if (c === '>') { templateDepth++; k--; continue; }
    if (c === '<' && templateDepth > 0) { templateDepth--; k--; continue; }
    if (templateDepth > 0) { k--; continue; }
    if (c === ':' || c === ',') { k--; continue; } // base clause / multi-decl
    if (isIdentPart(c)) {
      const end = k + 1;
      while (k > limit && isIdentPart(at(k))) k--;
      const word = source.slice(k + 1, end);
      if (word === 'enum') return true;
      continue; // the type name / `class` / `struct` — keep scanning back
    }
    // Statement boundary — stop; no `enum` found in this declaration.
    if (c === ';' || c === '}' || c === '{' || c === ')' || c === '(') return false;
    // Any other punctuation (`=`, `*`, `&`, `[`, `]`, `.` …) is a non-enum
    // context (initializer, declarator, member access) — stop.
    return false;
  }
  return false;
}

/**
 * Normalize a path for self-include comparison: backslashes → forward slashes,
 * collapse repeats, strip a leading `./`.
 */
function normalizePath(p: string): string | null {
  const parts: string[] = [];
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.join('/');
}

/**
 * Conservatively decide whether `#include "includePath"` refers to the file at
 * `filePath` (a self-include). Match if the normalized paths are equal, one is
 * a trailing segment-suffix of the other, or the basenames are equal while at
 * least one side is a bare filename. Requiring a bare side for basename-only
 * matching avoids treating `first/item.h` and `second/item.h` as the same file.
 */
function isSelfInclude(includePath: string, filePath: string): boolean {
  const inc = normalizePath(includePath);
  const fp = normalizePath(filePath);
  if (!inc || !fp) return false;
  if (fp === inc) return true;
  if (inc && fp.endsWith('/' + inc)) return true;
  if (fp && inc.endsWith('/' + fp)) return true;
  const incBase = inc.split('/').filter(Boolean).pop() ?? '';
  const fpBase = fp.split('/').filter(Boolean).pop() ?? '';
  if (
    incBase &&
    fpBase &&
    incBase === fpBase &&
    (!inc.includes('/') || !fp.includes('/'))
  ) return true;
  return false;
}

/**
 * Split a replacement body by top-level commas (paren/bracket depth 0),
 * respecting string and char literals so a comma inside one doesn't split.
 */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === '"') {
      i++;
      while (i < n) {
        const ch = s[i]!;
        i++;
        if (ch === '\\') { i++; continue; }
        if (ch === '"') break;
      }
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        const ch = s[i]!;
        i++;
        if (ch === '\\') { i++; continue; }
        if (ch === "'") break;
      }
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  out.push(s.slice(start));
  return out;
}

/**
 * Determine which formal the replacement places at the enumerator-name
 * position. Returns the formal's index, or -1 if it can't be uniquely proven.
 *
 * The name position is the start of a generated enumerator. The replacement is
 * split by top-level commas into enumerator segments; a segment names a
 * parameter iff its first token is a bare formal identifier followed by `=`
 * (the `name = expr` form) or by end-of-segment (the `name,` / trailing `name`
 * form). Exactly one such segment must name a formal:
 *   `name,`            → segment `name` → name
 *   `name = expr,`      → segment `name = expr` → name
 *   `a, b,`            → two segments name formals → multi-candidate → reject
 *   `FOO,` (not a formal)→ zero candidates → reject
 *   `#x` / `a ## b`     → any `#` (stringify / token paste) → reject
 *   `a + b,`            → first token `a` followed by `+` (not `=`/end) → reject
 */
function analyzeReplacement(formals: string[], replacement: string): number {
  if (replacement.includes('#')) return -1; // stringify (`#x`) or token paste (`##`)
  const formalIndex = new Map<string, number>();
  formals.forEach((f, idx) => {
    if (!formalIndex.has(f)) formalIndex.set(f, idx);
  });
  let candidate = -1;
  let candidateCount = 0;
  for (const seg of splitTopLevelCommas(replacement)) {
    const t = seg.trim();
    if (!t) continue;
    const m = t.match(/^([A-Za-z_]\w*)/);
    if (!m) continue; // first token isn't a bare identifier
    const tok = m[1]!;
    let after = m[0]!.length;
    while (after < t.length && /\s/.test(t[after]!)) after++;
    const nextCh = after < t.length ? t[after]! : '';
    if (nextCh === '=' || nextCh === '') {
      const idx = formalIndex.get(tok);
      if (idx !== undefined) {
        candidateCount++;
        candidate = idx;
      }
    }
  }
  return candidateCount === 1 ? candidate : -1;
}

interface EnumFrame {
  kind: 'enum' | 'other';
  bodyStart: number; // offset of `{`
  directives: ParsedDirective[];
}

/**
 * Detect self-include X-macro constructs in enum bodies and return the source
 * with the recognized three-directive lines blanked (length-preserving).
 */
export function detectXMacroConstructs(
  source: string,
  filePath: string,
): XMacroDetectionResult {
  const candidates: XMacroConstruct[] = [];
  const enumBodyRanges: XMacroDirectiveRange[] = [];
  const n = source.length;
  const at = (idx: number): string => (idx >= 0 && idx < n) ? source[idx]! : '';

  const braceStack: EnumFrame[] = [];

  const nonCode = computeNonCodeRanges(source);
  let nc = 0;
  const skipNC = (idx: number): number => {
    while (nc < nonCode.length && nonCode[nc]!.end <= idx) nc++;
    if (nc < nonCode.length && idx >= nonCode[nc]!.start && idx < nonCode[nc]!.end) return nonCode[nc]!.end;
    return idx;
  };

  let i = 0;
  while (i < n) {
    i = skipNC(i);
    if (i >= n) break;
    const c = at(i);

    // Preprocessor directive at the start of a logical line.
    if (c === '#') {
      let lineStart = i;
      while (lineStart > 0 && at(lineStart - 1) !== '\n') lineStart--;
      let onlyWs = true;
      for (let k = lineStart; k < i; k++) {
        if (!/\s/.test(at(k))) { onlyWs = false; break; }
      }
      if (onlyWs) {
        const dirEnd = findDirectiveEnd(source, i);
        const inEnum = braceStack.length > 0 && braceStack[braceStack.length - 1]!.kind === 'enum';
        if (inEnum) {
          const info = parseDirective(source, i, dirEnd);
          // Cap collected directives to bound memory on pathological input.
          const frame = braceStack[braceStack.length - 1]!;
          if (frame.directives.length < 4096) frame.directives.push(info);
        }
        i = dirEnd; // advance to the terminating newline; loop passes the \n
        continue;
      }
      // Otherwise an inline `#` (rare) — fall through and treat as a normal char.
    }

    if (c === '{') {
      const kind = braceOpensEnumBody(source, i) ? 'enum' : 'other';
      braceStack.push({ kind, bodyStart: i, directives: [] });
      i++;
      continue;
    }
    if (c === '}') {
      const frame = braceStack.pop();
      if (frame && frame.kind === 'enum' && candidates.length < MAX_CONSTRUCTS) {
        enumBodyRanges.push({ start: frame.bodyStart, end: i + 1 });
        const found = analyzeEnumDirectives(frame, i, filePath);
        for (const con of found) {
          candidates.push(con);
        }
      }
      i++;
      continue;
    }

    i++;
  }

  // Blank any construct whose replacement provably names one formal as the
  // enumerator (nameParamIndex >= 0): the three directives would otherwise make
  // tree-sitter swallow the whole enum_specifier, dropping the enum and its
  // hand-written members. Generated members are synthesized only when the
  // self-included source has at least one provably-active guarded data-list
  // call (calls.length > 0); when the guard is unprovable (e.g. an A/B selector
  // like `defined(M) && defined(LIST_A)`), the shell and hand-written members
  // are still recovered but no generated members are produced.
  const constructs: XMacroConstruct[] = [];
  const blankRanges: XMacroDirectiveRange[] = [];
  for (const candidate of candidates) {
    if (candidate.nameParamIndex < 0) continue;
    const calls = scanXMacroCalls(
      source,
      candidate.macroName,
      candidate.nameParamIndex,
      enumBodyRanges,
    );
    const accepted = { ...candidate, calls };
    constructs.push(accepted);
    for (const range of accepted.directiveRanges) {
      if (range.end > range.start) blankRanges.push(range);
    }
  }

  return {
    blankedSource: applyBlanking(source, blankRanges),
    constructs,
    enumBodyRanges,
  };
}

/**
 * Run the define→include→undef state machine over one enum body's directives
 * (in source order) and emit a construct for each complete, self-include
 * triple with a consistent macro name.
 */
function analyzeEnumDirectives(
  frame: EnumFrame,
  braceClose: number,
  filePath: string,
): XMacroConstruct[] {
  const found: XMacroConstruct[] = [];
  const dirs = frame.directives;
  type State = 'need_define' | 'need_include' | 'need_undef';
  let state: State = 'need_define';
  let curDefine: ParsedDirective | null = null;
  let curInclude: ParsedDirective | null = null;

  const reset = (): void => {
    state = 'need_define';
    curDefine = null;
    curInclude = null;
  };

  for (const d of dirs) {
    if (d.kind === 'define' && d.isFunctionLike && d.name) {
      // (Re)start a candidate at this function-like define.
      curDefine = d;
      curInclude = null;
      state = 'need_include';
      continue;
    }
    if (d.kind === 'include' && state === 'need_include' && curInclude === null) {
      curInclude = d;
      state = 'need_undef';
      continue;
    }
    if (
      d.kind === 'undef' &&
      state === 'need_undef' &&
      d.name &&
      curDefine &&
      curDefine.name === d.name &&
      curInclude
    ) {
      // Complete shape (define M + include + undef M). Validate self-include.
      if (
        curInclude.isQuoteInclude &&
        curInclude.includePath &&
        isSelfInclude(curInclude.includePath, filePath)
      ) {
        const nameParamIndex = analyzeReplacement(
          curDefine.formals ?? [],
          curDefine.replacement ?? '',
        );
        found.push({
          macroName: curDefine.name!,
          formals: curDefine.formals ?? [],
          nameParamIndex,
          replacement: curDefine.replacement ?? '',
          enumBodyStart: frame.bodyStart,
          enumBodyEnd: braceClose + 1,
          directiveRanges: [
            { start: curDefine.start, end: curDefine.end },
            { start: curInclude.start, end: curInclude.end },
            { start: d.start, end: d.end },
          ],
          calls: [],
        });
      }
      reset();
      continue;
    }
    // Any other directive (conditional, pragma, system include, object-like
    // define, mismatched undef) breaks the candidate — be conservative.
    if (state !== 'need_define') reset();
  }

  return found;
}

/**
 * Build the blanked source: every char in a blank range that isn't a newline
 * (or `\r`) becomes a space, so byte length, offsets, and line numbers stay
 * identical. Ranges are sorted and clipped to avoid double-blanking overlaps.
 */
function applyBlanking(source: string, ranges: XMacroDirectiveRange[]): string {
  if (ranges.length === 0) return source;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of sorted) {
    if (r.end <= pos) continue;
    const s = Math.max(r.start, pos);
    out += source.slice(pos, s);
    for (let k = s; k < r.end; k++) {
      const ch = source[k]!;
      out += ch === '\n' || ch === '\r' ? ch : ' ';
    }
    pos = r.end;
  }
  out += source.slice(pos);
  return out;
}

/** Precompute the start offset of each line for O(log) line-of-offset. */
function computeLineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** 1-based line number of a byte offset. */
function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo; // count of line starts <= offset == line number
}

/** Merge overlapping/adjacent ranges into a minimal non-overlapping set. */
function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

/** Match a C/C++ raw string literal beginning at index `i` — an optional
 *  prefix (u8, u, U, L) followed by `R"delim(...)delim"`. Returns the
 *  exclusive end index, or -1 when no raw string starts at `i`. Validates the
 *  delimiter/`(` structure so an identifier like `uint8_t` cannot match. */
function matchRawString(source: string, i: number): number {
  const n = source.length;
  // A raw string's R must start a token: the preceding char must not be an
  // identifier char, else we'd match the R in an identifier like `aR` or `u8var`.
  if (i > 0 && isIdentPart(source[i - 1]!)) return -1;
  let j = i;
  if (source.startsWith('u8', j)) j += 2;
  else if (j < n && (source[j] === 'u' || source[j] === 'U' || source[j] === 'L')) j += 1;
  if (j >= n || source[j] !== 'R') return -1;
  j++; // R
  if (j >= n || source[j] !== '"') return -1;
  j++; // opening quote
  const delimStart = j;
  while (j < n) {
    const ch = source[j]!;
    if (ch === '(') break;
    if (ch === '\n' || ch === ')' || ch === ' ' || ch === '\t' || ch === '\r' || j - delimStart > 16) return -1;
    j++;
  }
  if (j >= n || source[j] !== '(') return -1;
  const delim = source.slice(delimStart, j);
  j++; // (
  const closer = ')' + delim + '"';
  const e = source.indexOf(closer, j);
  return e === -1 ? -1 : e + closer.length;
}

/** Compute merged non-code ranges — line/block comments, char and string
 *  literals, and C/C++ raw strings — as byte-length-preserving spans. Shared
 *  by the brace/directive scan, the guard scan, and the macro-call scan so a
 *  raw string or comment containing a fake `#ifdef M` or `ITEM(...)` is never
 *  treated as source code. */
function computeNonCodeRanges(source: string): { start: number; end: number }[] {
  const n = source.length;
  const at = (idx: number): string => (idx >= 0 && idx < n) ? source[idx]! : '';
  const ranges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < n) {
    const c = at(i);
    const prev = i > 0 ? at(i - 1) : '';
    if ((c === 'R' || c === 'u' || c === 'U' || c === 'L') && !isIdentPart(prev)) {
      const r = matchRawString(source, i);
      if (r >= 0) { ranges.push({ start: i, end: r }); i = r; continue; }
    }
    if (c === '/' && at(i + 1) === '/') {
      const e = source.indexOf('\n', i);
      const end = e === -1 ? n : e;
      ranges.push({ start: i, end }); i = end; continue;
    }
    if (c === '/' && at(i + 1) === '*') {
      const e = source.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      ranges.push({ start: i, end }); i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) { const ch = at(j); j++; if (ch === '\\') { j++; continue; } if (ch === '"') break; }
      ranges.push({ start: i, end: j }); i = j; continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) { const ch = at(j); j++; if (ch === '\\') { j++; continue; } if (ch === "'") break; }
      ranges.push({ start: i, end: j }); i = j; continue;
    }
    i++;
  }
  return ranges;
}

/**
 * Locate the source ranges where `macroName` is provably defined and active,
 * using a two-environment three-state evaluation (M defined / M undefined;
 * each condition is true / false / unknown). A position is collectable only
 * when every active frame on the stack ANDs to (true, false) — defined-active
 * and undefined-inactive — so a nested `#if 0`/`#else` yields only its `#else`
 * branch, an unknown nested condition yields nothing, and a guard like
 * `defined(M) && defined(LIST_A)` yields nothing (LIST_A is unknown even when
 * M is defined). Non-code ranges are skipped first so a raw string or comment
 * holding a fake `#ifdef M` cannot open a guard. Requiring a provable M-guard
 * also prevents an unrelated macro with the same spelling from contributing.
 */
function collectPositiveMacroGuardRanges(
  source: string,
  macroName: string,
): { start: number; end: number }[] {
  const n = source.length;
  const nonCode = computeNonCodeRanges(source);
  let nc = 0;
  const skipNonCode = (idx: number): number => {
    while (nc < nonCode.length && nonCode[nc]!.end <= idx) nc++;
    if (nc < nonCode.length && idx >= nonCode[nc]!.start && idx < nonCode[nc]!.end) return nonCode[nc]!.end;
    return idx;
  };
  const escaped = macroName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  type Tri = boolean | undefined; // undefined = unknown
  type Pair = [Tri, Tri]; // [when M defined, when M undefined]
  const andT = (a: Tri, b: Tri): Tri =>
    (a === false || b === false) ? false : (a === true && b === true) ? true : undefined;
  const notT = (a: Tri): Tri => (a === undefined) ? undefined : !a;
  const pairAnd = (a: Pair, b: Pair): Pair => [andT(a[0], b[0]), andT(a[1], b[1])];
  const pairNot = (a: Pair): Pair => [notT(a[0]), notT(a[1])];

  // Evaluate a conditional directive's truth under the two M environments.
  const evalCond = (keyword: string, flat: string): Pair => {
    if (keyword === 'ifdef' || keyword === 'ifndef') {
      const m = flat.match(new RegExp(`^#\\s*(?:ifdef|ifndef)\\s+([A-Za-z_]\\w*)`));
      return m && m[1] === macroName
        ? (keyword === 'ifdef' ? [true, false] : [false, true])
        : [undefined, undefined];
    }
    // keyword === 'if' (also used to evaluate #elif bodies). Strip comments
    // first — the preprocessor removes them before evaluation.
    let expr = flat.replace(/^#\s*(?:if|elif)\s+/, '');
    expr = expr.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*$/, '').trim();
    if (expr === '0') return [false, false];
    if (expr === '1') return [true, true];
    // defined(M) / defined M / !defined(M) / !defined M. Bracketed and bare
    // forms are matched as distinct alternatives (not optional brackets) so
    // that `definedITEM`, `defined(ITEM`, and `defined ITEM)` all fail — a bare
    // form requires whitespace + a word boundary after the name.
    const definedExpr = `(?:defined\\s*\\(\\s*${escaped}\\s*\\)|defined\\s+${escaped}\\b)`;
    const definedRe = (neg: boolean): RegExp =>
      new RegExp(`^${neg ? '!\\s*' : ''}${definedExpr}$`);
    if (definedRe(false).test(expr)) return [true, false];
    if (definedRe(true).test(expr)) return [false, true];
    return [undefined, undefined];
  };

  interface Frame { active: Pair; remaining: Pair; }
  const stack: Frame[] = [];
  const collectable = (): boolean => {
    let acc: Pair = [true, true];
    for (const f of stack) acc = pairAnd(acc, f.active);
    return acc[0] === true && acc[1] === false;
  };

  const ranges: { start: number; end: number }[] = [];
  let rangeStart = -1;
  let i = 0;
  while (i < n) {
    i = skipNonCode(i);
    if (i >= n) break;
    const c = source[i]!;
    if (c === '#') {
      let lineStart = i;
      while (lineStart > 0 && source[lineStart - 1] !== '\n') lineStart--;
      let onlyWs = true;
      for (let k = lineStart; k < i; k++) if (!/\s/.test(source[k]!)) { onlyWs = false; break; }
      if (onlyWs) {
        if (rangeStart >= 0) { ranges.push({ start: rangeStart, end: lineStart }); rangeStart = -1; }
        const dirEnd = findDirectiveEnd(source, i);
        const flat = source.slice(i, dirEnd).replace(/\\\r?\n/g, ' ').trim();
        const keyword = flat.match(/^#\s*([A-Za-z_]\w*)/)?.[1] ?? '';
        if (keyword === 'if' || keyword === 'ifdef' || keyword === 'ifndef') {
          const cond = evalCond(keyword, flat);
          stack.push({ active: cond, remaining: pairNot(cond) });
        } else if (keyword === 'elif') {
          const top = stack[stack.length - 1];
          if (top) {
            const cond = evalCond('if', flat);
            top.active = pairAnd(top.remaining, cond);
            top.remaining = pairAnd(top.remaining, pairNot(cond));
          }
        } else if (keyword === 'else') {
          const top = stack[stack.length - 1];
          if (top) { top.active = top.remaining; top.remaining = [false, false]; }
        } else if (keyword === 'endif') {
          stack.pop();
        }
        if (collectable()) rangeStart = dirEnd;
        i = dirEnd;
        continue;
      }
    }
    if (collectable() && rangeStart < 0) rangeStart = i;
    i++;
  }
  if (rangeStart >= 0) ranges.push({ start: rangeStart, end: n });
  return mergeRanges(ranges);
}

function offsetInRanges(offset: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

function identifierArgument(raw: string): string | null {
  const withoutComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ')
    .trim();
  return /^[A-Za-z_]\w*$/.test(withoutComments) ? withoutComments : null;
}

/**
 * Scan `source` (the original, pre-blank text) for `macroName(...)` invocations
 * OUTSIDE the given exclude ranges (enum bodies) and outside preprocessor
 * directive lines. For each call, return the identifier at the name-parameter
 * position (rejecting non-identifier actuals). Whitespace, comments, strings,
 * nested parentheses, and cross-line arguments are all handled.
 */
export function scanXMacroCalls(
  source: string,
  macroName: string,
  nameParamIndex: number,
  excludeRanges: { start: number; end: number }[],
): XMacroCall[] {
  if (nameParamIndex < 0) return [];
  const calls: XMacroCall[] = [];
  const n = source.length;
  const at = (idx: number): string => (idx >= 0 && idx < n) ? source[idx]! : '';
  const lineStarts = computeLineStarts(source);
  const excludes = mergeRanges(excludeRanges);
  const guardRanges = collectPositiveMacroGuardRanges(source, macroName);
  if (guardRanges.length === 0) return [];
  const seen = new Set<string>();
  let exIdx = 0;
  let i = 0;
  let callCount = 0;

  const skipExcludes = (): void => {
    while (exIdx < excludes.length && excludes[exIdx]!.end <= i) exIdx++;
    while (exIdx < excludes.length && i >= excludes[exIdx]!.start && i < excludes[exIdx]!.end) {
      i = excludes[exIdx]!.end;
      while (exIdx < excludes.length && excludes[exIdx]!.end <= i) exIdx++;
    }
  };

  const nonCode = computeNonCodeRanges(source);
  let nc = 0;
  const skipNC = (idx: number): number => {
    while (nc < nonCode.length && nonCode[nc]!.end <= idx) nc++;
    if (nc < nonCode.length && idx >= nonCode[nc]!.start && idx < nonCode[nc]!.end) return nonCode[nc]!.end;
    return idx;
  };

  while (i < n) {
    skipExcludes();
    i = skipNC(i);
    if (i >= n) break;
    const c = at(i);

    // A preprocessor directive line never carries a macro invocation — skip it.
    if (c === '#') {
      let lineStart = i;
      while (lineStart > 0 && at(lineStart - 1) !== '\n') lineStart--;
      let onlyWs = true;
      for (let k = lineStart; k < i; k++) {
        if (!/\s/.test(at(k))) { onlyWs = false; break; }
      }
      if (onlyWs) {
        i = findDirectiveEnd(source, i);
        continue;
      }
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(at(j))) j++;
      const ident = source.slice(i, j);

      if (ident === macroName) {
        // Word boundary: the char before the name must not be an identifier
        // char (else we matched a suffix of a longer token like `MYITEM`).
        const prevChar = i > 0 ? at(i - 1) : '';
        if (!isIdentPart(prevChar) && offsetInRanges(i, guardRanges)) {
          // X-list records are standalone logical-line entries. Requiring only
          // whitespace before the macro token avoids treating normal code in a
          // broad #ifdef block as enum data.
          const physicalLineStart = source.lastIndexOf('\n', i - 1) + 1;
          if (source.slice(physicalLineStart, i).trim() !== '') {
            i = j;
            continue;
          }
          // The macro name may be followed by optional spaces/tabs then `(`.
          let k = j;
          while (k < n && (at(k) === ' ' || at(k) === '\t')) k++;
          if (k < n && at(k) === '(') {
            const argStart = k + 1;
            const { args, end, ok } = parseCallArgs(source, argStart);
            if (ok) {
              callCount++;
              if (callCount > MAX_CALLS) break;
              if (nameParamIndex < args.length) {
                const nameArg = identifierArgument(args[nameParamIndex]!);
                if (nameArg && !seen.has(nameArg)) {
                  const line = lineOf(lineStarts, i);
                  const lineOffset = lineStarts[line - 1] ?? i;
                  calls.push({
                    name: nameArg,
                    line,
                    column: i - lineOffset,
                    invocation: source.slice(i, end + 1).trim(),
                  });
                  seen.add(nameArg);
                }
              }
              i = end + 1; // advance past the closing `)`
              continue;
            }
            i = end; // malformed (unterminated) — advance to best-effort end
            continue;
          }
        }
      }
      i = j; // not a matching call — advance past the identifier
      continue;
    }

    i++;
  }

  return calls;
}

/**
 * Parse the argument list of a macro invocation starting just after the `(` at
 * `argStart`. Returns the comma-separated argument strings (trimmed by the
 * caller), the offset of the matching `)`, and whether the call was
 * well-formed (balanced). Handles nested parens/brackets, strings, chars,
 * comments, and cross-line arguments.
 */
function parseCallArgs(
  source: string,
  argStart: number,
): { args: string[]; end: number; ok: boolean } {
  const n = source.length;
  const at = (idx: number): string => (idx >= 0 && idx < n) ? source[idx]! : '';
  const args: string[] = [];
  let segStart = argStart;
  let depth = 1;
  let p = argStart;
  while (p < n && depth > 0) {
    const ch = at(p);
    // C/C++ raw string inside a macro argument — skip whole, since it may
    // contain quotes, commas, and parens that would split the argument or
    // unbalance the call.
    if (ch === 'R' || ch === 'u' || ch === 'U' || ch === 'L') {
      const r = matchRawString(source, p);
      if (r >= 0) { p = r; continue; }
    }
    if (ch === '"') {
      p++;
      while (p < n) {
        const x = at(p);
        p++;
        if (x === '\\') { p++; continue; }
        if (x === '"') break;
      }
      continue;
    }
    if (ch === "'") {
      p++;
      while (p < n) {
        const x = at(p);
        p++;
        if (x === '\\') { p++; continue; }
        if (x === "'") break;
      }
      continue;
    }
    if (ch === '/' && at(p + 1) === '/') {
      const e = source.indexOf('\n', p);
      p = e === -1 ? n : e;
      continue;
    }
    if (ch === '/' && at(p + 1) === '*') {
      const e = source.indexOf('*/', p + 2);
      p = e === -1 ? n : e + 2;
      continue;
    }
    if (ch === '(' || ch === '[') {
      depth++;
      if (depth > MAX_PAREN_DEPTH) {
        // Bail on pathological nesting — treat as malformed.
        return { args, end: p, ok: false };
      }
    } else if (ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) {
      args.push(source.slice(segStart, p));
      segStart = p + 1;
      if (args.length > MAX_ARGS) return { args, end: p, ok: false };
    }
    p++;
  }
  args.push(source.slice(segStart, p));
  if (depth !== 0) return { args, end: p, ok: false }; // unterminated
  return { args, end: p, ok: true };
}

export const XMACRO_LIMITS = { MAX_CALLS, MAX_ARGS, MAX_MEMBERS, MAX_CONSTRUCTS } as const;

/** Whether a language participates in X-macro enum recovery (C/C++ only). */
export function xmacroSupported(language: Language | undefined): boolean {
  return language === 'c' || language === 'cpp';
}
