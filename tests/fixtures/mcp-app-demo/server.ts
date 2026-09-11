/**
 * stdio entry point for the MCP App demo fixture.
 *
 *   npx tsx tests/fixtures/mcp-app-demo/server.ts
 *
 * The Electron E2E spawns it through Abu's normal stdio MCP path
 * (electron/mcpBridge.cjs), so this file must write NOTHING to stdout except
 * JSON-RPC frames.
 *
 * `ABU_MCP_DEMO_READY_FILE` (optional): a path this process touches once a
 * client has completed the MCP handshake. The E2E polls for it instead of
 * guessing how long `npx tsx` plus a connection takes.
 */
import { writeFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDemoServer } from './demoServer.ts';

const server = createDemoServer();

const readyFile = process.env.ABU_MCP_DEMO_READY_FILE;
if (readyFile) {
  server.server.oninitialized = () => {
    try {
      writeFileSync(readyFile, 'ready');
    } catch {
      // The readiness hint is best effort; never take the server down for it.
    }
  };
}

await server.connect(new StdioServerTransport());
