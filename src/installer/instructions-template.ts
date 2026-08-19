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

- Find one symbol by name/signature → \`codegraph_search\`; find 2–8 symbols with ONE \`codegraph_search(queries=[...])\` call so true misses share one raw scan. Add \`includeCode="if_unique"\` when a unique logical result should include declaration and definition source immediately; oversized source is safely truncated rather than replaced by an outline. A wrong qualified owner is corrected from structured leaf candidates before raw scanning.
- Read one known symbol → \`codegraph_node(symbol=..., includeCode=true)\`; read 2–8 known targets → ONE native \`codegraph_node(targets=[...])\` batch, which returns the same merged implementation bundle as context. Caller/callee trails are off by default; set \`includeRelations=true\` only when both directions are useful, otherwise use the dedicated relationship tool.
- Batch precise context → ONE manifest-driven \`codegraph_context(targets=[...])\` call. Group existing anchors as \`{file, symbols:[...], texts:[...]}\` or \`{symbol:<container>, members:[...]}\`; declarations/definitions and overlapping ranges are joined automatically, and member focus includes access labels plus small edit-neighbor context. A singular \`text\` combined with \`offset+limit\` is treated as an assertion on that explicit window instead of failing. Do not pass natural-language tasks. Put explicitly new identifiers in \`expectedMissing\` for absence verification only. Bare \`{file}\` targets return compact outlines. Fitting precise multi-file windows are emitted; preflight is reserved for over-budget output.
- Known file but unknown symbol → \`codegraph_node(file=..., symbolsOnly=true, outlineQuery=optional)\`, then select or batch symbols. Inside \`targets\`, use \`symbolsOnly\`, \`outlineQuery="a|b"\`/\`outlineQueries=[...]\`, and \`outlineLimit\` to filter several file outlines in one call.
- Search literal strings/macros/registrations → ONE \`codegraph_text_search(queries=[...], path=...)\` call; zero-match identifiers recover exact symbols in the same response, and an exact generated-file path is auto-included.
- Generated artifact → batch its source-of-truth generator definition and one exact generated function/tail anchor; do not page generated files, and run the repository generator after editing its source.
- Non-symbol text / exact edit boundary only → \`codegraph_node(file=..., offset=..., limit<=500)\`; larger limits are auto-clamped and output character budgets still apply. Bare/full-file MCP reads are rejected.
- Who calls this / what does this call / what would changing this break → \`codegraph_callers\` / \`codegraph_callees\` / \`codegraph_impact\`. For overloaded/same-named symbols, pass \`file\` + \`line\` or \`signature\`; these tools refuse to aggregate distinct overloads. Callers includes base-declaration call sites for an exact C++/interface override dispatch family.
- Unexpected empty graph results include compact raw-source matches or one-line absence evidence when safe: trust \`CONFIRMED_ABSENT\`; \`DECLARATION_ONLY\` means the exact overload has a declaration but no paired indexed definition and the relevant identifier occurrences are already shown; treat \`RAW_MATCHES\` as an index/parser-gap signal; narrow scope after \`INCONCLUSIVE\`.
- What's in a directory → \`codegraph_files\`.
- No MCP client? The \`codegraph query\`, \`codegraph callers\`, \`codegraph callees\`, and \`codegraph impact\` shell commands print the same kind of answer.

If there is no \`.codegraph/\` directory, skip CodeGraph entirely — indexing is the user's decision.
${CODEGRAPH_SECTION_END}`;
