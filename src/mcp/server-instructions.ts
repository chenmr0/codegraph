/**
 * Compact server-level guidance emitted in the MCP initialize response.
 *
 * Tool schemas carry the parameter details. Keep this focused on routing and
 * stopping so every client gets one consistent, low-token policy.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — symbol-first code intelligence

Codegraph is an indexed symbol and relationship graph. Use it to obtain the
smallest code context needed for the task; replacing Read with a whole-file
tool call does not save context.

The MCP server publishes short raw tool names such as \`node\` and \`context\`.
Claude Code namespaces them with the server name, so invoke the host-visible
\`codegraph_node\`, \`codegraph_context\`, and related \`codegraph_*\` tools.

## Route by what you know

- Known symbol/location/signature → \`codegraph_search\` (pass a symbol name or callable signature, not a natural-language question). If its implementation is also needed, set \`includeCode: "if_unique"\`; one logical result returns source immediately, while ambiguity remains safe and source-free.
- One known implementation after an ambiguous search → \`codegraph_node\` with \`symbol\` and \`includeCode: true\`; add \`file\`/\`line\` only to disambiguate.
- Several precise implementation needs → ONE \`codegraph_context\` call; mix exact symbols, selected container \`members\`, exact-file \`text\` anchors, and exact file windows in up to eight \`targets\`. A bare \`{ file }\` target automatically returns that file's compact symbol outline, and a JSON-stringified \`targets\` array is parsed automatically. Same-file ranges are merged and relation trails are omitted by default. Broad multi-file windows return a compact symbol preflight instead of partial source; use its exact names rather than Read. Do not loop \`codegraph_node\` or issue overlapping windows.
- Callers/callees/change impact → \`codegraph_callers\` / \`codegraph_callees\` / \`codegraph_impact\`. For overloaded or same-named symbols, pass \`file\` + \`line\` or \`signature\`; relationship tools do not aggregate distinct overloads and return exact candidates when still ambiguous.
- Known directory, unknown file → \`codegraph_files\`.
- Known file, unknown symbol → \`codegraph_node\` with \`file\` and \`symbolsOnly: true\`; add \`outlineQuery\` when a partial name is known, then choose or batch returned symbols.
- Literal strings/macros/registrations/table names → ONE \`codegraph_text_search\` call with several \`queries\` and a narrow required \`path\`; do not repeat its results with Grep. A zero-match identifier is recovered through exact symbol search in the same response. Generated files are skipped for directory scans; one exact generated-file path is included automatically.
- Non-symbol text or a missing edit boundary → a bounded \`codegraph_node\` file window with both \`offset\` and \`limit\` (requests above 120 are safely clamped). Batch several boundaries/anchors with \`codegraph_context\` instead.

## codegraph_node file guard

MCP file mode intentionally rejects bare/full-file reads. Its only valid forms
are \`{ file, symbolsOnly: true }\` and \`{ file, offset, limit<=120 }\` (a larger
runtime limit is automatically clamped rather than failing). If an explicit
\`symbolsOnly: true\` call also carries copied offset/limit fields, the window
fields are ignored and the outline succeeds.
Do not combine \`symbol\` with \`offset\`/\`limit\`; \`includeCode\` is symbol-mode
only. Prefer a symbol over a file window whenever the target can be named.
Do not paginate file windows. A window footer means switch to a symbol/context
query unless one specific non-symbol/edit-boundary line is still missing.

Trust successful graph results. Do not repeat them with grep or Read, do not
walk and open every caller/callee, and stop exploring once the target source,
direct relationships, and edit location are known. Raw Read/Grep is for
unindexed files, stale files named by the pending-sync warning, configs/docs,
or text/dynamic relationships the AST graph does not model.

The index normally trails writes by about one second. A staleness banner names
the exact files that may require a temporary raw read. Compiler, tests, and
linters remain the source of truth for live correctness.
`;
