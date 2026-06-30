/**
 * Unit tests for isNaturalLanguageQuery — detection of Chinese characters
 * in queries that should be rejected before the FTS→LIKE→fuzzy chain.
 */

import { describe, it, expect } from 'vitest';
import { isNaturalLanguageQuery } from '../src/search/query-utils';

describe('isNaturalLanguageQuery', () => {
  // --- Chinese detection ---
  it('detects Chinese characters embedded with symbol names', () => {
    const r = isNaturalLanguageQuery('MML命令注册 TRM MML_DBG');
    expect(r.isNatural).toBe(true);
    expect(r.reason).toContain('中文');
  });

  it('detects pure Chinese query', () => {
    const r = isNaturalLanguageQuery('命令注册');
    expect(r.isNatural).toBe(true);
  });

  it('detects single Chinese character', () => {
    expect(isNaturalLanguageQuery('处理').isNatural).toBe(true);
  });

  // --- Symbol names (should NOT be flagged) ---
  it('accepts a single symbol name', () => {
    expect(isNaturalLanguageQuery('MML_DBG_TRM').isNatural).toBe(false);
  });

  it('accepts camelCase symbol names', () => {
    expect(isNaturalLanguageQuery('AuthService loginUser').isNatural).toBe(false);
  });

  it('accepts snake_case symbol names', () => {
    expect(isNaturalLanguageQuery('user_service get_user_by_id').isNatural).toBe(false);
  });

  it('accepts PascalCase class/module names', () => {
    expect(isNaturalLanguageQuery('GraphTraverser BFS impact').isNatural).toBe(false);
  });

  it('accepts short code-like terms', () => {
    expect(isNaturalLanguageQuery('auth login user').isNatural).toBe(false);
  });

  it('accepts English question-like queries without Chinese', () => {
    expect(isNaturalLanguageQuery('how does auth work').isNatural).toBe(false);
  });

  it('accepts English queries with stop words', () => {
    expect(isNaturalLanguageQuery('the authentication module is broken').isNatural).toBe(false);
  });

  // --- Edge cases ---
  it('accepts empty query', () => {
    expect(isNaturalLanguageQuery('').isNatural).toBe(false);
  });

  it('accepts query with only whitespace', () => {
    expect(isNaturalLanguageQuery('   ').isNatural).toBe(false);
  });

  it('accepts file names with extensions', () => {
    expect(isNaturalLanguageQuery('auth.ts user-service.go').isNatural).toBe(false);
  });

  it('accepts qualified symbol names with ::', () => {
    expect(isNaturalLanguageQuery('std::string MyModule::foo').isNatural).toBe(false);
  });

  it('rejects query with Chinese punctuation', () => {
    expect(isNaturalLanguageQuery('这个函数做什么？').isNatural).toBe(true);
  });
});
