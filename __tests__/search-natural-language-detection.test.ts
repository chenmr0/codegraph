/**
 * Unit tests for isNaturalLanguageQuery — detection of natural language
 * and non-symbol content that should be rejected before the FTS→LIKE→fuzzy
 * chain.
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

  it('rejects query with Chinese punctuation', () => {
    expect(isNaturalLanguageQuery('这个函数做什么？').isNatural).toBe(true);
  });

  // --- Hex values ---
  it('rejects hex value 0x4237F001', () => {
    const r = isNaturalLanguageQuery('0x4237F001');
    expect(r.isNatural).toBe(true);
    expect(r.reason).toContain('十六进制');
  });

  it('rejects hex value with lowercase prefix', () => {
    expect(isNaturalLanguageQuery('0xdeadbeef').isNatural).toBe(true);
  });

  // --- Pure numeric ---
  it('rejects pure numeric query', () => {
    expect(isNaturalLanguageQuery('404').isNatural).toBe(true);
  });

  // --- Question marks ---
  it('rejects query with English question mark', () => {
    const r = isNaturalLanguageQuery('how does auth work?');
    expect(r.isNatural).toBe(true);
    expect(r.reason).toContain('问号');
  });

  it('rejects query with Chinese question mark', () => {
    expect(isNaturalLanguageQuery('怎么认证？').isNatural).toBe(true);
  });

  // --- Whitespace (symbol names never contain spaces) ---
  it('rejects "ADD TRMDBG" (space-separated debug macro)', () => {
    const r = isNaturalLanguageQuery('ADD TRMDBG');
    expect(r.isNatural).toBe(true);
    expect(r.reason).toContain('空格');
  });

  it('rejects "how does auth work" (natural language phrase)', () => {
    const r = isNaturalLanguageQuery('how does auth work');
    expect(r.isNatural).toBe(true);
    expect(r.reason).toContain('空格');
  });

  it('rejects "find me the login function"', () => {
    expect(isNaturalLanguageQuery('find me the login function').isNatural).toBe(true);
  });

  it('rejects multi-symbol bag "AuthService loginUser"', () => {
    expect(isNaturalLanguageQuery('AuthService loginUser').isNatural).toBe(true);
  });

  it('rejects qualified names with space "std::string MyModule::foo"', () => {
    expect(isNaturalLanguageQuery('std::string MyModule::foo').isNatural).toBe(true);
  });

  // --- Symbol names (no space — should NOT be flagged) ---
  it('accepts a single symbol name', () => {
    expect(isNaturalLanguageQuery('MML_DBG_TRM').isNatural).toBe(false);
  });

  it('accepts camelCase symbol name', () => {
    expect(isNaturalLanguageQuery('loginUser').isNatural).toBe(false);
  });

  it('accepts PascalCase class name', () => {
    expect(isNaturalLanguageQuery('GraphTraverser').isNatural).toBe(false);
  });

  it('accepts short acronym', () => {
    expect(isNaturalLanguageQuery('MML').isNatural).toBe(false);
  });

  it('accepts dot-separated reference (no space)', () => {
    // "RepAlloc.Rsp" — no whitespace, so passes the space check.  The
    // tool description warns against this pattern; hard-rejecting dots
    // would block legitimate qualified names in some languages.
    expect(isNaturalLanguageQuery('RepAlloc.Rsp').isNatural).toBe(false);
  });

  it('accepts qualified name with ::', () => {
    expect(isNaturalLanguageQuery('std::string').isNatural).toBe(false);
  });

  // --- Edge cases ---
  it('accepts empty query', () => {
    expect(isNaturalLanguageQuery('').isNatural).toBe(false);
  });

  it('accepts query with only whitespace', () => {
    expect(isNaturalLanguageQuery('   ').isNatural).toBe(false);
  });
});
