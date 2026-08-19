## Token Optimization Tools

### codebase-memory-mcp
When this MCP server is available, **prefer graph tools over grep/Explore for all structural code questions**.
Graph queries return precise results in a single tool call (~500 tokens) vs file-by-file exploration (~80K tokens).

- Before any exploration or planning task: run `index_repository` if the graph is not current
- For "what calls X?": use `trace_path(function_name="X", direction="inbound")`
- For "where is X defined?": use `search_graph(name_pattern="X")`
- For architecture overview: use `get_architecture()`
- For dead code: use `detect_changes()` or `query_graph` with a zero-callers Cypher query
- For cross-service routes: use `search_graph` with route patterns
- Only fall back to grep/Read when the graph cannot answer (e.g. raw string search in file contents)

### Headroom + RTK
Headroom is running as a local proxy. You don't need to do anything — compression is automatic.
RTK is active on all Bash tool calls. Common commands (git, ls, cat) are automatically rewritten to compact output before they reach your context.

### Serena
When editing code, prefer Serena's symbol-level tools for cross-file renames, reference lookups, and targeted edits. Avoid reading entire files when a symbol-level operation exists.
