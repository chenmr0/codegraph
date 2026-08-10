#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const gtPath = readArg('--gt');
const dbPath = readArg('--db');
const sourceRoot = readArg('--source-root');
const outPath = readArg('--out', path.resolve('clangd-miss-analysis.json'));
const distRoot = readArg('--dist', path.resolve('dist'));

if (!gtPath || !dbPath || !sourceRoot) {
  console.error('Usage: node scripts/analyze-clangd-misses.mjs --gt <json> --db <db> --source-root <root> [--dist <dist>] [--out <json>]');
  process.exit(2);
}

const { createDatabase } = require(path.join(distRoot, 'db', 'sqlite-adapter.js'));
const { QueryBuilder } = require(path.join(distRoot, 'db', 'queries.js'));
const { db } = createDatabase(path.resolve(dbPath), { readOnly: true });
const queries = new QueryBuilder(db);
const gt = JSON.parse(fs.readFileSync(path.resolve(gtPath), 'utf8'));

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function bareName(value) {
  let angleDepth = 0;
  for (let i = value.length - 1; i > 0; i--) {
    if (value[i] === '>') angleDepth++;
    else if (value[i] === '<' && angleDepth > 0) angleDepth--;
    else if (angleDepth === 0 && value[i] === ':' && value[i - 1] === ':') {
      return value.slice(i + 1);
    }
  }
  return value;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsName(text, name) {
  if (!name || /^\(anonymous/.test(name)) return false;
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeRegex(name)}([^A-Za-z0-9_]|$)`).test(text);
}

function macroCalls(text) {
  const calls = [];
  const regex = /\b([A-Z_][A-Z0-9_]{2,})\s*\(/g;
  let match;
  while ((match = regex.exec(text))) calls.push(match[1]);
  return [...new Set(calls)];
}

function classify(symbol, lines) {
  const name = bareName(symbol.name);
  const lineIndex = symbol.line;
  const line = lines[lineIndex] || '';
  const near = lines.slice(Math.max(0, lineIndex - 2), lineIndex + 3).join('\n');
  const wider = lines.slice(Math.max(0, lineIndex - 8), lineIndex + 9).join('\n');
  const nameOnLine = containsName(line, name);
  const nameNear = containsName(near, name);
  const calls = macroCalls(near);
  const upperInvocation = calls.length > 0;
  const preprocessorLine = /^\s*#/.test(line);

  if (/^\(anonymous|^anonymous\b/i.test(name) || /^\(anonymous|^anonymous\b/i.test(symbol.name)) {
    return { cause: 'anonymous_entity', nameOnLine, nameNear, calls };
  }
  if (!nameNear && (preprocessorLine || upperInvocation)) {
    return { cause: 'macro_expanded_symbol', nameOnLine, nameNear, calls };
  }
  if (!nameNear && /\b[A-Z_][A-Z0-9_]{2,}\b/.test(near)) {
    return { cause: 'macro_or_generated_symbol', nameOnLine, nameNear, calls };
  }
  if (/\btemplate\s*</.test(wider) || /\b(?:class|struct)\s+[A-Za-z_]\w*\s*</.test(wider)) {
    return { cause: 'template_declaration', nameOnLine, nameNear, calls };
  }
  if (symbol.category === 'variable' || symbol.category === 'constant') {
    if (/\(\s*[*&]\s*[A-Za-z_]\w*\s*\)/.test(near)) {
      return { cause: 'function_pointer_variable', nameOnLine, nameNear, calls };
    }
    if (/\b(?:extern|static|constexpr|constinit|thread_local)\b/.test(near)) {
      return { cause: 'qualified_variable_declaration', nameOnLine, nameNear, calls };
    }
    if (/\[[^\]]*\]/.test(near)) {
      return { cause: 'array_variable_declaration', nameOnLine, nameNear, calls };
    }
    return { cause: 'ordinary_variable_declaration', nameOnLine, nameNear, calls };
  }
  if (symbol.category === 'method' && symbol.clangd_kind === 9) {
    return { cause: 'constructor_or_destructor', nameOnLine, nameNear, calls };
  }
  if (/\b(?:class|struct|enum)\b/.test(near) && /#\s*(?:if|ifdef|ifndef|else|elif)/.test(wider)) {
    return { cause: 'conditional_declaration', nameOnLine, nameNear, calls };
  }
  if (nameOnLine || nameNear) {
    return { cause: 'source_spelled_parse_loss', nameOnLine, nameNear, calls };
  }
  return { cause: 'location_or_origin_unknown', nameOnLine, nameNear, calls };
}

const fileCache = new Map();
function sourceLines(relativePath) {
  const normalized = normalizePath(relativePath);
  if (fileCache.has(normalized)) return fileCache.get(normalized);
  const absolute = path.join(path.resolve(sourceRoot), ...normalized.split('/'));
  let lines = [];
  try {
    lines = fs.readFileSync(absolute, 'utf8').split(/\r?\n/);
  } catch {
    // Keep an empty context in the report so missing source files are visible.
  }
  fileCache.set(normalized, lines);
  return lines;
}

const missing = [];
const recoveredByTolerance = [];
const totals = {};
for (const symbol of gt.symbols) {
  const name = bareName(symbol.name);
  const relativeFile = normalizePath(symbol.file);
  const expectedLine = symbol.line + 1;
  const candidates = queries.getNodesBySymbolExact(name);
  const sameFile = candidates.filter(node => normalizePath(node.filePath) === relativeFile);
  const exact = sameFile.filter(node => node.startLine === expectedLine);
  const near = sameFile.filter(node => Math.abs(node.startLine - expectedLine) <= 3);
  const category = symbol.category || 'other';
  totals[category] ||= { total: 0, exact: 0, near: 0, missing: 0 };
  totals[category].total++;
  if (exact.length) totals[category].exact++;
  if (near.length) totals[category].near++;
  if (near.length) {
    if (!exact.length) recoveredByTolerance.push({ ...symbol, expectedLine, nodes: near });
    continue;
  }

  totals[category].missing++;
  const lines = sourceLines(relativeFile);
  const attribution = classify(symbol, lines);
  missing.push({
    ...symbol,
    bareName: name,
    expectedLine,
    attribution,
    sameFileCandidates: sameFile.map(node => ({
      name: node.name,
      kind: node.kind,
      startLine: node.startLine,
      endLine: node.endLine,
      qualifiedName: node.qualifiedName,
    })),
    context: lines.slice(Math.max(0, symbol.line - 3), symbol.line + 4)
      .map((text, index) => ({ line: Math.max(0, symbol.line - 3) + index + 1, text })),
  });
}

const causes = {};
for (const item of missing) {
  const cause = item.attribution.cause;
  causes[cause] ||= { total: 0, byCategory: {}, examples: [] };
  causes[cause].total++;
  causes[cause].byCategory[item.category] = (causes[cause].byCategory[item.category] || 0) + 1;
  if (causes[cause].examples.length < 12) {
    causes[cause].examples.push({
      name: item.name,
      file: item.file,
      line: item.expectedLine,
      category: item.category,
      calls: item.attribution.calls,
    });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  inputs: { gtPath: path.resolve(gtPath), dbPath: path.resolve(dbPath), sourceRoot: path.resolve(sourceRoot) },
  totals,
  summary: {
    total: gt.symbols.length,
    exact: Object.values(totals).reduce((sum, item) => sum + item.exact, 0),
    near: Object.values(totals).reduce((sum, item) => sum + item.near, 0),
    missing: missing.length,
    recoveredByTolerance: recoveredByTolerance.length,
  },
  causes,
  missing,
  recoveredByTolerance,
};

fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ summary: report.summary, totals, causes }, null, 2));
