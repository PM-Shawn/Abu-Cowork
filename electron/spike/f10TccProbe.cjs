/**
 * F10 spike — spawn the native-helper-probe FROM Electron main (exactly how the
 * real native helper would be launched) and print its TCC report. Compare with
 * the same probe run standalone from Terminal: if the numbers differ, macOS is
 * attributing TCC to the responsible PARENT app (Terminal vs Electron), which
 * decides whether the helper-binary architecture needs its own permission grant
 * or inherits the app's.
 *
 * Run: npx electron electron/spike/f10TccProbe.cjs
 */
'use strict';
const { app } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PROBE = path.join(__dirname, 'native-helper-probe', 'target', 'release', 'native-helper-probe');

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const child = spawn(PROBE, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => {
    console.log('[f10-tcc] electron-spawned probe →', out.trim() || `<no stdout, code ${code}, err=${err.trim()}>`);
    console.log('[f10-tcc] electron exe →', process.execPath);
    app.exit(0);
  });
  child.on('error', (e) => {
    console.log('[f10-tcc] spawn error →', String(e));
    app.exit(1);
  });
});
