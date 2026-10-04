#!/usr/bin/env node
/**
 * Install the voice-input native runtime (sherpa-onnx-node + its platform
 * package, which carries ONNX Runtime) into electron/speech-runtime/node_modules.
 *
 * Versions and integrity come from electron/speech-runtime/package-lock.json
 * (`npm ci`), so every build installs the same bytes. npm picks the optional
 * platform package for the machine running this script — the same rule as
 * setup-electron-runtimes.mjs: build each platform/arch on its own runner.
 * Install scripts are disabled; the packages ship prebuilt N-API binaries.
 *
 * electron-builder copies the result as the `speech-runtime` extraResource;
 * speechWorker.cjs loads it from there (never from app.asar).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = path.join(ROOT, 'electron', 'speech-runtime');

const npmExecPath = process.env.npm_execpath;
const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = [
  ...(npmExecPath ? [npmExecPath] : []),
  'ci',
  '--omit=dev',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
];

console.log(`[speech-runtime] installing locked sherpa-onnx runtime for ${process.platform}-${process.arch}`);
const install = spawnSync(command, args, {
  cwd: RUNTIME_DIR,
  stdio: 'inherit',
  shell: process.platform === 'win32' && !npmExecPath,
});
if (install.error || install.status !== 0) {
  console.error(`[speech-runtime] npm ci failed${install.error ? `: ${install.error.message}` : ''}`);
  process.exit(install.status || 1);
}

// Fail the build here rather than on a user's first recording.
const probe = spawnSync(process.execPath, [
  '-e',
  `const s = require(${JSON.stringify(path.join(RUNTIME_DIR, 'node_modules', 'sherpa-onnx-node'))});`
    + 'if (typeof s.OfflineRecognizer !== "function" || typeof s.Vad !== "function") process.exit(2);'
    + 'console.log(s.version);',
], { encoding: 'utf8' });
if (probe.status !== 0) {
  console.error('[speech-runtime] sherpa-onnx-node failed to load on this platform');
  console.error(probe.stderr);
  process.exit(1);
}
const installed = fs.readdirSync(path.join(RUNTIME_DIR, 'node_modules')).filter((name) => name.startsWith('sherpa-onnx'));
console.log(`[speech-runtime] ready: sherpa-onnx ${probe.stdout.trim()} (${installed.join(', ')})`);
