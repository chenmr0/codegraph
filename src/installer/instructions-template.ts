/**
 * The marker-fenced agent-instructions block the installer writes into each
 * agent's instructions file (CLAUDE.md / AGENTS.md / GEMINI.md).
 *
 * History: pre-#529 the installer wrote a full usage playbook here, which
 * duplicated the MCP `initialize` instructions for the main agent — so it
 * was removed and `mcp/server-instructions.ts` became the single source of
 * truth. A much smaller block returned for #704, because the MCP
 * instructions cannot reach two audiences that the instructions FILE does
 * reach:
 *
 *  - **Task-tool subagents** — they receive the project instructions file
 *    in their context but NOT the MCP initialize instructions. They hold
 *    the codegraph MCP tools only as deferred names and rarely think to
 *    load them: measured on a forced-delegation flow question (excalidraw,
 *    sonnet, high effort), subagents loaded + used codegraph in ~1 of 9
 *    runs without this block, and consistently with it — including runs
 *    with zero Read/grep fallback.
 *  - **Non-MCP harnesses** — agents with no MCP client at all can still
 *    run the `codegraph explore` CLI, which prints the same output as the
 *    MCP tool.
 *
 * Keep this block SHORT. The main agent reads it every turn on top of the
 * server instructions — the #529 duplication-cost argument still bounds
 * its size. Command names and the two surfaces, nothing more.
 */

/** Markers used by the marker-based section write/removal. */
export const CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_START -->';
export const CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_END -->';

/**
 * The full block, markers included, exactly as written to disk.
 *
 * The wording is deliberately CONDITIONAL ("in repositories indexed by…"):
 * a global install writes this into a user-scope file (~/.claude/CLAUDE.md,
 * ~/.cac/AGENTS.md, ~/.config/opencode/AGENTS.md) that applies to every
 * project the user opens — including unindexed ones, where an unconditional
 * "this repository is indexed" claim would send subagents into failing
 * codegraph calls (the noise the unindexed-session policy exists to
 * prevent).
 *
 * This fork has `codegraph_explore` DISABLED by default (the tool returned
 * too much data with too much noise, per user feedback) — see
 * `CODEGRAPH_ENABLE_EXPLORE` in `src/mcp/tools.ts`. So unlike upstream #704,
 * this block does NOT point at `codegraph_explore`; it points at the granular
 * tools that ARE on (`codegraph_search` / `codegraph_node` / `codegraph_callers`
 * / `codegraph_callees` / `codegraph_impact` / `codegraph_files`) and at the
 * `codegraph query|callers|callees|impact` shell commands for MCP-less
 * harnesses. Keep it SHORT — the main agent reads it every turn on top of
 * the server instructions.
 */
export const CODEGRAPH_INSTRUCTIONS_BLOCK = `${CODEGRAPH_SECTION_START}
## CodeGraph

In repositories indexed by CodeGraph (a \`.codegraph/\` directory exists at the repo root), use it to retrieve the smallest relevant code context before grep/find or file reads:

The CodeGraph server publishes short raw names so Claude Code exposes the tools exactly as \`codegraph_search\`, \`codegraph_node\`, \`codegraph_context\`, and the other \`codegraph_*\` names below.

- Find a symbol by name → \`codegraph_search\` (returns kind + location + signature).
- Read a known symbol → \`codegraph_node(symbol=..., includeCode=true)\`.
- Read 2–8 known symbols → ONE \`codegraph_context(targets=[...])\` call.
- Known file but unknown symbol → \`codegraph_node(file=..., symbolsOnly=true, outlineQuery=optional)\`, then select or batch symbols.
- Search literal strings/macros/registrations → ONE \`codegraph_text_search(queries=[...], path=...)\` call.
- Non-symbol text / exact edit boundary only → \`codegraph_node(file=..., offset=..., limit<=120)\`. Bare/full-file MCP reads are rejected.
- Who calls this / what does this call / what would changing this break → \`codegraph_callers\` / \`codegraph_callees\` / \`codegraph_impact\`.
- What's in a directory → \`codegraph_files\`.
- No MCP client? The \`codegraph query\`, \`codegraph callers\`, \`codegraph callees\`, and \`codegraph impact\` shell commands print the same kind of answer.

If there is no \`.codegraph/\` directory, skip CodeGraph entirely — indexing is the user's decision.
${CODEGRAPH_SECTION_END}`;
