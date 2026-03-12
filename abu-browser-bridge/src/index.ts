#!/usr/bin/env node

/**
 * Abu Browser Bridge — MCP Server + WebSocket Server
 *
 * This process acts as a bridge between Abu (via MCP stdio transport)
 * and the Chrome Extension (via WebSocket).
 *
 * Startup strategy:
 * 1. Check if an old bridge is running via the discovery endpoint (port 9875)
 * 2. If found, kill it by PID so we can take over the ports
 * 3. Start discovery (9875) + WS (9876) on fixed ports — no fallback
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
const DISCOVERY_PORT = 9875;

/**
 * Kill any stale abu-browser-bridge by querying the discovery endpoint.
 * If an old bridge is running, its /status returns { pid }, and we kill it.
 * Also kills any process on the WS port range as a fallback.
 */
async function killStaleBridges(wsPort: number): Promise<void> {
  const myPid = process.pid;

  // Method 1: Query discovery endpoint for PID (most reliable)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${DISCOVERY_PORT}/status`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json() as { pid?: number };
      if (data.pid && data.pid !== myPid) {
        try {
          process.kill(data.pid, 'SIGTERM');
          console.error(`[abu-bridge] Killed old bridge (pid: ${data.pid}) via discovery`);
          // Wait a bit for ports to be released
          await new Promise(r => setTimeout(r, 500));
        } catch {
          // Already dead
        }
      }
    }
  } catch {
    // Discovery not available — old bridge might not have it
  }

  // Method 2: Kill any process on our ports (fallback for old versions without discovery)
  const portsToCheck = [DISCOVERY_PORT, wsPort];
  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      const { execSync } = await import('child_process');
      const output = execSync('netstat -ano -p TCP', { encoding: 'utf-8', timeout: 5000 });
      const pids = new Set<number>();
      for (const port of portsToCheck) {
        const regex = new RegExp(`127\\.0\\.0\\.1:${port}\\s+.*LISTENING\\s+(\\d+)`, 'g');
        let match;
        while ((match = regex.exec(output)) !== null) {
          const pid = parseInt(match[1], 10);
          if (pid && pid !== myPid) pids.add(pid);
        }
      }
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
          console.error(`[abu-bridge] Killed stale process ${pid} (port scan)`);
        } catch { /* already dead */ }
      }
    } else {
      const { execSync } = await import('child_process');
      const portFlags = portsToCheck.map(p => `-i:${p}`);
      const output = execSync(`lsof -t ${portFlags.join(' ')}`, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (output) {
        const pids = new Set(
          output.split('\n').map(l => parseInt(l.trim(), 10)).filter(pid => pid && pid !== myPid)
        );
        for (const pid of pids) {
          try {
            process.kill(pid, 'SIGTERM');
            console.error(`[abu-bridge] Killed stale process ${pid} (port scan)`);
          } catch { /* already dead */ }
        }
      }
    }
  } catch {
    // No processes found or command failed — that's fine
  }

  // Wait for ports to be released
  await new Promise(r => setTimeout(r, 300));
}

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

  // 0. Kill any stale bridge so we can take over the fixed ports
  await killStaleBridges(wsPort);

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
