/**
 * Regression proof for a child closing stdin between mcp_write's liveness
 * check and the actual pipe write. Before the fix this produced an uncaught
 * EPIPE in Electron main and displayed the native "JavaScript error occurred
 * in the main process" dialog.
 *
 * Run: npx electron electron/spike/mcpEpipeVerify.cjs
 */
'use strict';

const { app } = require('electron');
const { mcpDispatch } = require('../mcpBridge.cjs');

const CHILD_ID = 'epipe-regression';
const CLOSED_STDIN_CHILD = [
  "require('node:fs').closeSync(0)",
  "process.stdout.write('ready\\n')",
  'setTimeout(() => {}, 5000)',
].join(';');

let uncaught = null;
process.once('uncaughtException', (err) => {
  uncaught = err instanceof Error ? err.message : String(err);
});

app.whenReady().then(async () => {
  let writeRejected = false;
  let writeError = null;
  try {
    await mcpDispatch('mcp_spawn', {
      id: CHILD_ID,
      command: 'node',
      args: ['-e', CLOSED_STDIN_CHILD],
      env: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await mcpDispatch('mcp_write', {
        id: CHILD_ID,
        message: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    } catch (err) {
      writeRejected = true;
      writeError = err instanceof Error ? err.message : String(err);
    }
    // Give the stream's asynchronous error event time to surface. The process
    // handler above turns any regression into an explicit failed assertion
    // instead of letting Electron show a modal and hang unattended.
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    mcpDispatch('mcp_kill', { id: CHILD_ID });
  }

  const passed = writeRejected && uncaught === null;
  console.log('[mcp-epipe-verify] ' + JSON.stringify({
    passed,
    writeRejected,
    writeError,
    uncaught,
  }));
  app.exit(passed ? 0 : 1);
});
