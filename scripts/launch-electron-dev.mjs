import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMacProtocolShell } from './mac-protocol-shell.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const binary = process.platform === 'darwin' ? prepareMacProtocolShell(root) : require('electron');
const child = spawn(binary, [path.join(root, 'electron/main.cjs'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('error', (error) => {
  console.error('[dev-shell] Electron failed to start:', error.message);
  process.exitCode = 1;
});
child.on('close', (code) => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
}
