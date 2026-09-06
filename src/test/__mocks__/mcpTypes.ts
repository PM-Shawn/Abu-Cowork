// Alias target for `@modelcontextprotocol/sdk/types.js` (see vitest.config.ts).
//
// Every other `@modelcontextprotocol/sdk` subpath is aliased to a stub because
// the Node-only client graph (cross-spawn, node:stream) cannot load under
// vitest. `types.js` is different: it is pure zod schema declarations with no
// Node dependency, and `@modelcontextprotocol/ext-apps/app-bridge` (the MCP
// Apps host bridge) needs the REAL schemas — a stub makes `AppBridge` fail at
// module evaluation.
//
// The re-export uses a relative path on purpose: a bare specifier would hit
// the alias again and loop. Going through this file (rather than pointing the
// alias straight at node_modules) keeps the "own stub file" property that
// `vi.mock('@modelcontextprotocol/sdk/client/index.js')` in client.test.ts
// relies on — mocking the client entry replaces `mcp.ts`, not this module.
export * from '../../../node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';
