'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = __dirname;
const manifestPath = path.join(root, 'Cargo.toml');
const exe = process.platform === 'win32' ? 'sandbox-launcher.exe' : 'sandbox-launcher';
const built = path.join(root, 'target', 'release', exe);
const outDir = path.join(root, 'dist', process.platform);
const out = path.join(outDir, exe);

const cargo = spawnSync('cargo', ['build', '--manifest-path', manifestPath, '--release'], {
  stdio: 'inherit',
});
if (cargo.status !== 0) {
  process.exit(cargo.status ?? 1);
}

// A worktree may build more than one target over time. Package only the
// current host launcher so stale binaries cannot leak into extraResources.
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(built, out);
if (process.platform !== 'win32') {
  fs.chmodSync(out, 0o755);
}
console.log(`[sandbox-launcher] built ${out}`);
