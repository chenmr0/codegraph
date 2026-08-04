import type { NodeKind } from '../../src/types.js';
import type { EvalResult, ExpectedSearchSymbol } from './types.js';

export const PASS_THRESHOLD = 0.5;

export function scoreSearchNodes(
  caseId: string,
  expectedSymbols: ExpectedSearchSymbol[],
  results: Array<{
    node: {
      name: string;
      kind: NodeKind;
      filePath: string;
      qualifiedName: string;
    };
    score: number;
  }>,
  latencyMs: number
): EvalResult {
  const found: string[] = [];
  const missed: string[] = [];
  let firstRank = 0;

  for (const expected of expectedSymbols) {
    const idx = results.findIndex(({ node }) => matchesExpectedSymbol(node, expected));
    const label = formatExpectedSymbol(expected);
    if (idx !== -1) {
      found.push(label);
      if (firstRank === 0) firstRank = idx + 1;
    } else {
      missed.push(label);
    }
  }

  const recall = expectedSymbols.length > 0 ? found.length / expectedSymbols.length : 0;
  const mrr = firstRank > 0 ? 1 / firstRank : 0;

  return {
    caseId,
    // Search identity is a quality gate, not a best-effort exploration score:
    // every exact expected symbol must be present.
    pass: expectedSymbols.length > 0 && missed.length === 0,
    recall,
    mrr,
    foundSymbols: found,
    missedSymbols: missed,
    latencyMs,
  };
}

function normalizeProjectPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesExpectedSymbol(
  node: { name: string; kind: NodeKind; filePath: string; qualifiedName: string },
  expected: ExpectedSearchSymbol,
): boolean {
  return node.name === expected.name &&
    node.kind === expected.kind &&
    normalizeProjectPath(node.filePath) === normalizeProjectPath(expected.filePath) &&
    (expected.qualifiedName === undefined || node.qualifiedName === expected.qualifiedName);
}

function formatExpectedSymbol(expected: ExpectedSearchSymbol): string {
  return `${expected.name} (${expected.kind}) @ ${normalizeProjectPath(expected.filePath)}`;
}

export function scoreFindRelevantContext(
  caseId: string,
  expectedSymbols: string[],
  subgraph: { nodes: Map<string, { name: string }>; edges: unknown[]; roots: string[] },
  latencyMs: number
): EvalResult {
  const expectedLower = new Set(expectedSymbols.map((s) => s.toLowerCase()));
  const nodeNames = new Set<string>();
  for (const node of subgraph.nodes.values()) {
    nodeNames.add(node.name.toLowerCase());
  }

  const found: string[] = [];
  const missed: string[] = [];

  for (const sym of expectedSymbols) {
    if (nodeNames.has(sym.toLowerCase())) {
      found.push(sym);
    } else {
      missed.push(sym);
    }
  }

  const recall = expectedSymbols.length > 0 ? found.length / expectedSymbols.length : 0;
  const nodeCount = subgraph.nodes.size;
  const edgeCount = subgraph.edges.length;
  const edgeDensity = nodeCount > 0 ? edgeCount / nodeCount : 0;

  return {
    caseId,
    pass: recall >= PASS_THRESHOLD,
    recall,
    mrr: 0,
    foundSymbols: found,
    missedSymbols: missed,
    nodeCount,
    edgeCount,
    edgeDensity,
    latencyMs,
  };
}
