import type { EvalTestCase } from './types.js';

export const testCases: EvalTestCase[] = [
  // === searchNodes: Symbol Lookup Precision ===

  {
    id: 'search-class-exact',
    query: 'TransportService',
    api: 'searchNodes',
    expectedSymbols: [{
      name: 'TransportService',
      kind: 'class',
      filePath: 'server/src/main/java/org/elasticsearch/transport/TransportService.java',
    }],
    kinds: ['class'],
  },
  {
    id: 'search-method-qualified',
    query: 'TransportService sendRequest',
    api: 'searchNodes',
    expectedSymbols: [{
      name: 'sendRequest',
      kind: 'method',
      filePath: 'server/src/main/java/org/elasticsearch/transport/TransportService.java',
    }],
    kinds: ['method'],
  },
  {
    id: 'search-interface',
    query: 'ActionListener',
    api: 'searchNodes',
    expectedSymbols: [{
      name: 'ActionListener',
      kind: 'interface',
      filePath: 'server/src/main/java/org/elasticsearch/action/ActionListener.java',
    }],
    kinds: ['interface'],
  },
  {
    id: 'search-enum',
    query: 'RestStatus',
    api: 'searchNodes',
    expectedSymbols: [{
      name: 'RestStatus',
      kind: 'enum',
      filePath: 'server/src/main/java/org/elasticsearch/rest/RestStatus.java',
    }],
    kinds: ['enum'],
  },
  {
    id: 'search-exception',
    query: 'SearchPhaseExecutionException',
    api: 'searchNodes',
    expectedSymbols: [{
      name: 'SearchPhaseExecutionException',
      kind: 'class',
      filePath: 'server/src/main/java/org/elasticsearch/action/search/SearchPhaseExecutionException.java',
    }],
    kinds: ['class'],
  },
  {
    id: 'search-nested-class',
    query: 'Engine Index',
    api: 'searchNodes',
    expectedSymbols: [{
      name: 'Index',
      kind: 'class',
      filePath: 'server/src/main/java/org/elasticsearch/index/engine/Engine.java',
    }],
    kinds: ['class'],
  },

  // === findRelevantContext: Exploration Quality ===

  {
    id: 'explore-rest-layer',
    query: 'How does the REST layer handle HTTP requests?',
    api: 'findRelevantContext',
    expectedSymbols: ['RestController', 'RestHandler', 'BaseRestHandler', 'RestRequest'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-search-execution',
    query: 'How does search execution work from request to shard?',
    api: 'findRelevantContext',
    expectedSymbols: ['ShardSearchRequest', 'SearchShardsRequest', 'SearchShardsGroup'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-bulk-indexing',
    query: 'How does bulk indexing work?',
    api: 'findRelevantContext',
    expectedSymbols: ['TransportBulkAction', 'BulkRequest', 'BulkResponse'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-shard-allocation',
    query: 'How does shard rebalancing and allocation work?',
    api: 'findRelevantContext',
    expectedSymbols: ['AllocationService', 'BalancedShardsAllocator'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-transport-search',
    query: 'How does TransportService connect to SearchTransportService?',
    api: 'findRelevantContext',
    expectedSymbols: ['TransportService', 'SearchTransportService'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'explore-engine-implementations',
    query: 'What are the Engine implementations for indexing?',
    api: 'findRelevantContext',
    expectedSymbols: ['InternalEngine', 'ReadOnlyEngine', 'Engine'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
];
