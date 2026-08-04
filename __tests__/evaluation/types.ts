import type { NodeKind } from '../../src/types.js';

/**
 * Exact symbol identity used by search-quality gates. Name-only expectations
 * can be satisfied by a same-named method/class or a duplicate basename in a
 * different directory, which is precisely the false-positive shape an
 * extraction evaluation must reject.
 */
export interface ExpectedSearchSymbol {
  name: string;
  kind: NodeKind;
  /** Full project-relative path, normalized to `/` by the scorer. */
  filePath: string;
  /** Optional additional discriminator for nested/namespaced symbols. */
  qualifiedName?: string;
}

interface EvalTestCaseBase {
  id: string;
  query: string;
  options?: Record<string, unknown>;
}

export interface SearchEvalTestCase extends EvalTestCaseBase {
  api: 'searchNodes';
  expectedSymbols: ExpectedSearchSymbol[];
  kinds?: NodeKind[];
}

export interface ContextEvalTestCase extends EvalTestCaseBase {
  api: 'findRelevantContext';
  expectedSymbols: string[];
}

export type EvalTestCase = SearchEvalTestCase | ContextEvalTestCase;

export interface EvalResult {
  caseId: string;
  pass: boolean;
  recall: number;
  mrr: number;
  foundSymbols: string[];
  missedSymbols: string[];
  nodeCount?: number;
  edgeCount?: number;
  edgeDensity?: number;
  latencyMs: number;
}

export interface EvalReport {
  timestamp: string;
  codebasePath: string;
  codegraphSha: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    meanRecall: number;
    meanMRR: number;
  };
  results: EvalResult[];
}
