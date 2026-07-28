#!/usr/bin/env node

/**
 * Abu Browser Bridge — MCP Server + WebSocket Server
 *
 * This process acts as a bridge between Abu (via MCP stdio transport)
 * and the Chrome Extension (via WebSocket).
 *
 * Startup strategy:
 * 1. Start discovery (9875) + WS (9876) on fixed loopback ports
 * 2. Fail clearly if another process owns either port
 *
 * Electron owns this process tree and retires it on shutdown. The bridge must
 * never kill an unrelated process merely because it happens to use a port.
 *
 * Usage:
 *   npx abu-browser-bridge [--port 9876]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startWSServer, stopWSServer } from './wsServer.js';
import { registerTools } from './tools.js';
import { PKG_VERSION } from './version.js';

const DEFAULT_WS_PORT = 9876;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let wsPort = DEFAULT_WS_PORT;

  const portIndex = args.indexOf('--port');
  if (portIndex !== -1 && args[portIndex + 1]) {
    wsPort = parseInt(args[portIndex + 1], 10);
    if (isNaN(wsPort) || wsPort < 1 || wsPort > 65535) {
      console.error(`Invalid port: ${args[portIndex + 1]}`);
      process.exit(1);
    }
  }

  // 1. Start WebSocket + Discovery server on fixed ports (no fallback)
  try {
    await startWSServer(wsPort);
  } catch (err) {
    console.error(`Failed to start WS server:`, err);
    process.exit(1);
  }

  // 2. Create MCP server
  const mcpServer = new McpServer({
    name: 'abu-browser-bridge',
    version: PKG_VERSION,
  });

  // 3. Register browser tools
  registerTools(mcpServer);

  // 4. Connect MCP server to stdio transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  console.error('[abu-bridge] MCP server connected via stdio');
  console.error('[abu-bridge] Ready — waiting for Chrome Extension connection...');

  // Graceful shutdown
  const cleanup = (): void => {
    console.error('[abu-bridge] Shutting down...');
    stopWSServer();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
