import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  formatPreflightFailure,
  inspectElectronDevArtifacts,
  inspectElectronDevDependencies,
} from './electron-dev-preflight.mjs';

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `abu-electron-preflight-${process.pid}-${Math.random().toString(16).slice(2)}`
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      packages: {
        'node_modules/electron': { version: '43.1.1' },
        'node_modules/node-pty': { version: '1.1.0' },
      },
    })
  );
  return root;
}

function installFakePackage(nodeModulesPath, name, version) {
  const packagePath = path.join(nodeModulesPath, ...name.split('/'));
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(path.join(packagePath, 'package.json'), JSON.stringify({ name, version }));
}

test('reports a missing worktree dependency directory without resolving from a parent', () => {
  const root = fixture();
  try {
    const result = inspectElectronDevDependencies(root);
    assert.deepEqual(result.issues.map((issue) => issue.code), ['missing-node-modules']);
    const message = formatPreflightFailure(result);
    assert.match(message, /npm run setup:electron-dev/);
    assert.match(message, /npm run setup:electron-dev:enterprise/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepts the exact Electron and node-pty versions pinned by the lockfile', () => {
  const root = fixture();
  try {
    const nodeModulesPath = path.join(root, 'node_modules');
    installFakePackage(nodeModulesPath, 'electron', '43.1.1');
    installFakePackage(nodeModulesPath, 'node-pty', '1.1.0');

    const result = inspectElectronDevDependencies(root);
    assert.deepEqual(result.issues, []);
    assert.equal(result.nodeModulesIsSymlink, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports missing and stale critical packages before Electron launches', () => {
  const root = fixture();
  try {
    const nodeModulesPath = path.join(root, 'node_modules');
    installFakePackage(nodeModulesPath, 'electron', '42.0.0');
    mkdirSync(nodeModulesPath, { recursive: true });

    const result = inspectElectronDevDependencies(root);
    assert.deepEqual(
      result.issues.map((issue) => [issue.code, issue.packageName]),
      [
        ['version-mismatch', 'electron'],
        ['missing-package', 'node-pty'],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identifies a shared node_modules symlink in the diagnostic', () => {
  const root = fixture();
  const sharedRoot = fixture();
  try {
    const sharedNodeModules = path.join(sharedRoot, 'node_modules');
    installFakePackage(sharedNodeModules, 'electron', '43.1.1');
    installFakePackage(sharedNodeModules, 'node-pty', '1.1.0');
    symlinkSync(sharedNodeModules, path.join(root, 'node_modules'), 'dir');

    const result = inspectElectronDevDependencies(root);
    assert.deepEqual(result.issues, []);
    assert.equal(result.nodeModulesIsSymlink, true);
    assert.equal(result.nodeModulesTarget, realpathSync(sharedNodeModules));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sharedRoot, { recursive: true, force: true });
  }
});

test('reports every generated runtime needed by a complete Electron dev launch', () => {
  const root = fixture();
  try {
    const issues = inspectElectronDevArtifacts(root);
    assert.deepEqual(
      issues.map((issue) => issue.artifactName),
      [
        'Electron 前端',
        'Agent sidecar',
        '内置 Node',
        '内置 Python',
        'Abu-Browser 运行时',
        'Abu-Browser query_js Worker',
        'Abu-Chrome-Bridge 运行时',
        'Abu-Chrome-Bridge query_js Worker',
        'Abu-Chrome-Bridge 扩展',
        '电脑操控原生辅助程序',
        '沙箱启动器',
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
