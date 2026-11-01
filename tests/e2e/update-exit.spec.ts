import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { closeAbuElectron, createElectronDataRoot, launchAbuElectron } from './electronHelpers';
import { waitForApp } from './openAiMock';

test('exit preparation lets a real terminal finish its SIGHUP cleanup', async () => {
  test.skip(process.platform === 'win32', 'POSIX signal acceptance.');
  const root = createElectronDataRoot();
  const { app } = await launchAbuElectron(root, { recordMainProcess: true });
  const ready = path.join(root.rootDir, 'terminal-ready');
  const cleaned = path.join(root.rootDir, 'terminal-cleaned');
  try {
    const page = await app.firstWindow();
    await waitForApp(page);
    await page.evaluate(async ({ cwd, ready, cleaned }) => {
      await window.__TAURI_INTERNALS__.invoke('pty_spawn', { id: 'update-cleanup', cols: 80, rows: 24, cwd });
      const script = `cleanup() { printf done > "${cleaned}"; exit 0; }; trap cleanup HUP; printf ready > "${ready}"; while read line; do :; done`;
      await window.__TAURI_INTERNALS__.invoke('pty_write', { id: 'update-cleanup', data: `exec /bin/sh -c '${script}'\r` });
    }, { cwd: root.rootDir, ready, cleaned });
    await expect.poll(() => fs.existsSync(ready)).toBe(true);
    await app.evaluate(async ({ app: electronApp }) => {
      const require = process.getBuiltinModule('module').createRequire(`${electronApp.getAppPath()}/package.json`);
      const host = require('./tauriHost.cjs');
      await host.prepareAppExit(true);
      host.cancelAppExitPreparation();
    });
    expect(fs.readFileSync(cleaned, 'utf8')).toBe('done');
  } finally {
    await closeAbuElectron(app);
  }
});

test('exit preparation closes a real Windows terminal', async () => {
  test.skip(process.platform !== 'win32', 'Windows terminal acceptance.');
  const root = createElectronDataRoot();
  const { app } = await launchAbuElectron(root, { recordMainProcess: true });
  try {
    const page = await app.firstWindow();
    await waitForApp(page);
    await page.evaluate(async cwd => {
      await window.__TAURI_INTERNALS__.invoke('pty_spawn', { id: 'update-windows', cols: 80, rows: 24, cwd });
    }, root.rootDir);
    await app.evaluate(async ({ app: electronApp }) => {
      const require = process.getBuiltinModule('module').createRequire(`${electronApp.getAppPath()}/package.json`);
      const host = require('./tauriHost.cjs');
      await host.prepareAppExit(true);
      host.cancelAppExitPreparation();
    });
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeEnabled();
  } finally {
    await closeAbuElectron(app);
  }
});

test('exit preparation terminates a real terminal that ignores SIGHUP', async () => {
  test.skip(process.platform === 'win32', 'POSIX signal acceptance.');
  const root = createElectronDataRoot();
  const { app } = await launchAbuElectron(root, { recordMainProcess: true });
  const marker = path.join(root.rootDir, 'terminal-pid');
  try {
    const page = await app.firstWindow();
    await waitForApp(page);
    await page.evaluate(async ({ cwd, marker }) => {
      await window.__TAURI_INTERNALS__.invoke('pty_spawn', { id: 'update-exit', cols: 80, rows: 24, cwd });
      const script = `trap "" HUP; printf "%s" "$$" > "${marker}"; while read line; do :; done`;
      await window.__TAURI_INTERNALS__.invoke('pty_write', { id: 'update-exit', data: `exec /bin/sh -c '${script}'\r` });
    }, { cwd: root.rootDir, marker });
    await expect.poll(() => fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0).toBeGreaterThan(0);
    const pid = Number(fs.readFileSync(marker, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 'SIGHUP');
    process.kill(pid, 0);
    await app.evaluate(async ({ app: electronApp }) => {
      const require = process.getBuiltinModule('module').createRequire(`${electronApp.getAppPath()}/package.json`);
      const host = require('./tauriHost.cjs');
      await host.prepareAppExit(true);
      host.cancelAppExitPreparation();
    });
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toBeEnabled();
  } finally {
    await closeAbuElectron(app);
  }
});

test('a real inherited pipe times out exit preparation, restores interaction, and permits retry', async () => {
  const root = createElectronDataRoot();
  const { app } = await launchAbuElectron(root, { recordMainProcess: true });
  let descendantPid: number | undefined;
  try {
    const page = await app.firstWindow();
    await waitForApp(page);
    descendantPid = await app.evaluate(async ({ app: electronApp }) => {
      const require = process.getBuiltinModule('module').createRequire(`${electronApp.getAppPath()}/package.json`);
      const { spawn } = require('node:child_process');
      const { once } = require('node:events');
      const path = require('node:path');
      const { ownedChildProcesses } = require('./ownedChildProcesses.cjs');
      const node = path.join(electronApp.getAppPath(), '.runtime/node-runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
      const script = 'const {spawn}=require("node:child_process"); const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); child.on("spawn",()=>process.send(child.pid)); setInterval(()=>{},1000);';
      const child = spawn(node, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      ownedChildProcesses.track(child, () => { if (!child.killed) child.kill('SIGKILL'); });
      const [pid] = await once(child, 'message');
      return pid as number;
    });
    const result = await app.evaluate(async ({ app: electronApp }) => {
      const require = process.getBuiltinModule('module').createRequire(`${electronApp.getAppPath()}/package.json`);
      const host = require('./tauriHost.cjs');
      try { await host.prepareAppExit(true); return 'unexpected success'; }
      catch (error) { return String(error); }
    });
    expect(result).toContain('ABU_EXIT_CHILD_TIMEOUT: child');
    await page.getByPlaceholder('想让阿布帮你做点什么？').fill('Continue after the interrupted restart');
    await expect(page.getByPlaceholder('想让阿布帮你做点什么？')).toHaveValue('Continue after the interrupted restart');
    process.kill(descendantPid, 'SIGKILL');
    descendantPid = undefined;
    await app.evaluate(async ({ app: electronApp }) => {
      const require = process.getBuiltinModule('module').createRequire(`${electronApp.getAppPath()}/package.json`);
      const host = require('./tauriHost.cjs');
      await host.prepareAppExit(true);
      host.cancelAppExitPreparation();
    });
  } finally {
    if (descendantPid !== undefined) process.kill(descendantPid, 'SIGKILL');
    await closeAbuElectron(app);
  }
});
