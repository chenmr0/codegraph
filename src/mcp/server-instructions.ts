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

- Known symbol/location/signature → \`codegraph_search\` (pass a symbol name or callable signature, not a natural-language question). Search several names with ONE \`queries=[{query,...}, ...]\` batch; all true misses share one multi-pattern raw-source scan. If implementation is needed, set \`includeCode: "if_unique"\`; one logical C/C++ overload returns both declaration and definition source, safely truncated when oversized rather than replaced by an outline. If only a qualified owner is wrong but the exact leaf exists, search returns structured owner-correction candidates and skips a repository scan.
- One known implementation after an ambiguous search → \`codegraph_node\` with \`symbol\` and \`includeCode: true\`; add \`file\`/\`line\` only to disambiguate. Caller/callee trails are off by default; set \`includeRelations: true\` only when both directions are useful, otherwise use the dedicated relationship tool.
- Several precise implementation needs → ONE \`codegraph_node(targets=[...])\` or \`codegraph_context(targets=[...])\` call. Node's native batch form routes the same manifest-driven implementation bundle, adapting repeated node intent without extra round trips. The bundle accepts selected container \`members\`, exact-file \`text\` anchors, and exact file windows; member focus includes access labels plus small comment/neighbor edit context. Prefer grouped \`{file, symbols:[...], texts:[...]}\` anchors when names are already known. A target containing \`file + text + offset + limit\` is auto-recovered: the explicit window is returned and \`text\` is checked as an assertion. CodeGraph deterministically joins matching declarations/definitions and merges same-file ranges. Never pass a natural-language task for retrieval. Put explicitly new identifiers in context's \`expectedMissing\` only; they verify absence but do not discover code. A bare \`{file}\` returns a compact symbol outline; batch file outlines support \`symbolsOnly\`, \`outlineQuery: "a|b"\`/\`outlineQueries:[...]\` OR filters, and \`outlineLimit\`. A JSON-stringified \`targets\` array is parsed automatically. Preflight is decided by the 20K character budget: a precise multi-file request that fits is emitted even if it spans many lines; over-budget non-manifest source is stopped before partial output. Do not loop single-target \`codegraph_node\` calls or issue overlapping windows.
- Callers/callees/change impact → \`codegraph_callers\` / \`codegraph_callees\` / \`codegraph_impact\`. For overloaded or same-named symbols, pass \`file\` + \`line\` or \`signature\`; relationship tools do not aggregate distinct overloads and return exact candidates when still ambiguous. Callers expands an exact C++/interface virtual-dispatch family, so callers attached to a base declaration are included for the selected override.
- Known directory, unknown file → \`codegraph_files\`.
- Known file, unknown symbol → \`codegraph_node\` with \`file\` and \`symbolsOnly: true\`; add \`outlineQuery\` when a partial name is known, then choose or batch returned symbols. A file plus \`outlineQuery\`/\`outlineLimit\` automatically infers \`symbolsOnly: true\`.
- Literal strings/macros/registrations/table names → ONE \`codegraph_text_search\` call with several \`queries\` and a narrow required \`path\`; do not repeat its results with Grep. A zero-match identifier is recovered through exact symbol search in the same response. Generated files are skipped for directory scans; one exact generated-file path is included automatically.
- Generated schema/artifact work → retrieve the source-of-truth generator definition and the exact generated function/tail anchor together in ONE node/context manifest. Do not page through the generated artifact. After editing the generator source, locate and run its repository generator; manually edit the artifact only when generation is unavailable and state that exception.
- Non-symbol text or a missing edit boundary → a bounded \`codegraph_node\` file window with both \`offset\` and \`limit\` (requests above 500 are safely clamped, and character budgets still apply). Batch several boundaries/anchors with native \`codegraph_node(targets=[...])\` instead. A stray surrounding quote on search \`includeCode\` is corrected automatically.

## codegraph_node file guard

MCP single-target file mode intentionally rejects bare/full-file reads. Its valid forms
are \`{ file, symbolsOnly: true }\` and \`{ file, offset, limit<=500 }\`; native
\`targets=[...]\` is the preferred multi-target form. A larger single-window
runtime limit is automatically clamped rather than failing. If an explicit
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

When an exact graph lookup is unexpectedly empty, CodeGraph may append one
grep-equivalent scan of current indexed source. \`CONFIRMED_ABSENT\` is emitted
only for a complete readable scope and needs no Grep recheck; \`DECLARATION_ONLY\`
means an exact callable declaration has no paired indexed definition and its
raw identifier occurrences are already included; \`RAW_MATCHES\`
already contains representative Grep evidence and signals a possible parser/
index gap; \`INCONCLUSIVE\` means the reported scan scope was incomplete and
must be narrowed before drawing an absence conclusion. Identical evidence may
reuse a cache only while the file watcher reports the same source epoch and no
pending edits; an edit or completed sync invalidates it.

The index normally trails writes by about one second. A staleness banner names
the exact files that may require a temporary raw read. Compiler, tests, and
linters remain the source of truth for live correctness.
`;
