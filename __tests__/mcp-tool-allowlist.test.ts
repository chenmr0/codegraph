/**
 * CODEGRAPH_MCP_TOOLS allowlist — lets an operator (or an A/B harness) trim the
 * exposed MCP tool surface without touching the client config. Inert when unset.
 * Filtering happens in ListTools (getTools) and is enforced again on execute().
 *
 * codegraph_explore is disabled by default; set CODEGRAPH_ENABLE_EXPLORE=1 to
 * include it in the surface.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ToolHandler } from '../src/mcp/tools';

const ENV = 'CODEGRAPH_MCP_TOOLS';
const EXPLORE_ENV = 'CODEGRAPH_ENABLE_EXPLORE';

describe('CODEGRAPH_MCP_TOOLS allowlist', () => {
  const allowlistOriginal = process.env[ENV];
  const exploreOriginal = process.env[EXPLORE_ENV];
  afterEach(() => {
    if (allowlistOriginal === undefined) delete process.env[ENV];
    else process.env[ENV] = allowlistOriginal;
    if (exploreOriginal === undefined) delete process.env[EXPLORE_ENV];
    else process.env[EXPLORE_ENV] = exploreOriginal;
  });

  const listed = () => new ToolHandler(null).getTools().map(t => t.name).sort();

  // --- explore disabled by default (CODEGRAPH_ENABLE_EXPLORE unset) ---

  it('does not expose codegraph_explore by default', () => {
    delete process.env[ENV];
    const all = listed();
    expect(all).not.toContain('codegraph_explore');
    expect(all).not.toContain('codegraph_context');
    expect(all).not.toContain('codegraph_trace');
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it('exposes codegraph_explore when CODEGRAPH_ENABLE_EXPLORE=1', () => {
    delete process.env[ENV];
    process.env[EXPLORE_ENV] = '1';
    const all = listed();
    expect(all).toContain('codegraph_explore');
    expect(all.length).toBeGreaterThanOrEqual(8);
  });

  it('filters ListTools to the allowlisted short names', () => {
    process.env[EXPLORE_ENV] = '1';
    process.env[ENV] = 'explore,search,node';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_node', 'codegraph_search']);
  });

  it('accepts fully-qualified codegraph_ names and ignores whitespace', () => {
    process.env[EXPLORE_ENV] = '1';
    process.env[ENV] = ' codegraph_explore , search ';
    expect(listed()).toEqual(['codegraph_explore', 'codegraph_search']);
  });

  it('treats an empty/whitespace value as unset (full surface, explore disabled by default)', () => {
    process.env[ENV] = '   ';
    expect(listed().length).toBeGreaterThanOrEqual(7);
  });

  it('rejects a disabled tool on execute (defense in depth)', async () => {
    process.env[ENV] = 'node';
    const res = await new ToolHandler(null).execute('codegraph_explore', {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/disabled/);
  });

  it('lets an allowlisted tool past the guard', async () => {
    process.env[ENV] = 'search';
    // No CodeGraph attached, so it fails *after* the allowlist guard — the
    // "disabled" message must NOT appear, proving the guard passed it through.
    const res = await new ToolHandler(null).execute('codegraph_search', { query: 'x' });
    expect(res.content[0].text).not.toMatch(/disabled/);
  });
});
