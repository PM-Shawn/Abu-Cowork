/**
 * Resolve Abu's first-party Chrome bridge runtime without exposing a mutable
 * absolute resource path to the renderer or downloading an npm package at
 * runtime. The renderer stores the stable command id below; Electron main
 * expands it to the current dev/packaged bundle path.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { resourceRoot, REPO_ROOT } = require('./appEnv.cjs');

const CHROME_BRIDGE_RUNTIME_COMMAND = 'abu-chrome-bridge-runtime';

function chromeBridgeRuntimePath(app) {
  return app && app.isPackaged
    ? path.join(resourceRoot(app), 'chrome-bridge-runtime', 'server.mjs')
    : path.join(REPO_ROOT, 'electron', 'chrome-bridge-runtime', 'dist', 'server.mjs');
}

function bundledChromeBridgeArgs(args = []) {
  if (!Array.isArray(args)) return [];
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (
      arg === '-y'
      || arg === '--yes'
      || /^--package=abu-browser-bridge(?:@[^/\\]+)?$/i.test(arg)
      || /^abu-browser-bridge(?:@[^/\\]+)?$/i.test(arg)
    ) {
      continue;
    }
    if (arg === '--port') {
      const value = String(args[index + 1] ?? '');
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error(`Invalid Chrome bridge port: ${value || '(missing)'}`);
      }
      normalized.push('--port', value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error(`Invalid Chrome bridge port: ${value || '(missing)'}`);
      }
      normalized.push('--port', value);
      continue;
    }
    throw new Error(`Unsupported Chrome bridge argument: ${arg}`);
  }
  return normalized;
}

async function resolveChromeBridgeRuntimeLaunch(app, originalArgs = []) {
  const script = chromeBridgeRuntimePath(app);
  if (!fs.existsSync(script)) {
    throw new Error(
      `Bundled Chrome bridge runtime is missing: ${script}. ` +
      'Run npm run build:electron-chrome-bridge-runtime.'
    );
  }
  return {
    command: 'node',
    args: [script, ...bundledChromeBridgeArgs(originalArgs)],
    env: {},
  };
}

module.exports = {
  CHROME_BRIDGE_RUNTIME_COMMAND,
  bundledChromeBridgeArgs,
  chromeBridgeRuntimePath,
  resolveChromeBridgeRuntimeLaunch,
};
