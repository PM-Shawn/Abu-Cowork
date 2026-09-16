# mcp-app-demo — MCP Apps fixture server

Run it by hand: `npx tsx tests/fixtures/mcp-app-demo/server.ts` (stdio; add it in
扩展 › 连接器 with command `npx`, args `tsx <abs>/tests/fixtures/mcp-app-demo/server.ts`).

| Surface | What it proves |
|---|---|
| `show_table` (model+app) | a tool with `_meta.ui` renders its interface at the tool-result position |
| `refresh_rows` (app-only) | app-only tools never reach the model, and the app's `tools/call` crosses the same approval gate |
| 「刷新」 | `tools/call refresh_rows` → approval dialog → rows change → an audit row appears |
| 「发到对话」 | `ui/message` lands in the composer as a draft and is **not** sent |
| 「打开文档」 | `ui/open-link` needs the consent dialog; cancelling leaves a `declined` audit row |
| 「全屏」 | `ui/request-display-mode: fullscreen` promotes the same iframe, state kept |
| replay | the table falls back to parsing its text summary — a replayed step arrives WITHOUT `structuredContent` (the host persists the display result only) |
| after render | `ui/update-model-context` — visible under the 模型上下文 expander |
| `show_evil` | `csp.connectDomains: ['*', 'http://evil.example', …]` — the invalid ones are refused and disclosed; the page writes `fetch:blocked` / `iframe:blocked` / `form:blocked` / `open:blocked` for every attempt the sandbox stopped |
