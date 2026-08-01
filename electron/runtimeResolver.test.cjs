'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const {
  runtimeRoots,
  runtimeLayout,
  resolveBundledProgram,
  withBundledRuntimeEnv,
} = require('./runtimeResolver.cjs');

const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu runtime resolver '));
  tmpDirs.push(dir);
  return dir;
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
}

function makeTree(platform, packaged = false) {
  const root = tmpDir();
  const repoRoot = path.join(root, 'repo with spaces');
  const resourceRoot = path.join(root, 'resources with spaces');
  const runtimeRoot = packaged ? resourceRoot : path.join(repoRoot, 'electron', '.runtime');
  const nodeRoot = path.join(runtimeRoot, 'node-runtime');
  const pythonRoot = path.join(runtimeRoot, 'python-runtime');
  const windows = platform === 'win32';
  const layout = {
    repoRoot,
    resourceRoot,
    runtimeRoot,
    nodeRoot,
    pythonRoot,
    node: {
      executable: path.join(nodeRoot, windows ? 'node.exe' : 'bin/node'),
      npmCli: path.join(
        nodeRoot,
        windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js',
      ),
      npxCli: path.join(
        nodeRoot,
        windows ? 'node_modules/npm/bin/npx-cli.js' : 'lib/node_modules/npm/bin/npx-cli.js',
      ),
    },
    python: {
      executable: path.join(pythonRoot, windows ? 'python.exe' : 'bin/python3'),
    },
  };

  touch(layout.node.executable);
  touch(layout.node.npmCli);
  touch(layout.node.npxCli);
  touch(layout.python.executable);
  return layout;
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

test('runtimeRoots keeps dev runtimes separate from the legacy Tauri runtime', () => {
  const tree = makeTree('darwin', false);
  const roots = runtimeRoots({ isPackaged: false }, { repoRoot: tree.repoRoot, platform: 'darwin' });

  assert.equal(roots.runtimeRoot, tree.runtimeRoot);
  assert.equal(roots.nodeRoot, tree.nodeRoot);
  assert.equal(roots.pythonRoot, tree.pythonRoot);
  assert.equal(roots.platform, 'darwin');
});

test('runtimeRoots resolves packaged runtimes under resourceRoot', () => {
  const tree = makeTree('win32', true);
  const roots = runtimeRoots({ isPackaged: true }, { resourceRoot: tree.resourceRoot, platform: 'win32' });

  assert.equal(roots.runtimeRoot, tree.resourceRoot);
  assert.equal(roots.nodeRoot, tree.nodeRoot);
  assert.equal(roots.pythonRoot, tree.pythonRoot);
  assert.equal(roots.platform, 'win32');
});

test('runtimeLayout exposes macOS dev executable and CLI paths', () => {
  const tree = makeTree('darwin', false);
  const layout = runtimeLayout({ isPackaged: false }, { repoRoot: tree.repoRoot, platform: 'darwin' });

  assert.equal(layout.node.executable, tree.node.executable);
  assert.equal(layout.node.npmCli, tree.node.npmCli);
  assert.equal(layout.node.npxCli, tree.node.npxCli);
  assert.equal(layout.python.executable, tree.python.executable);
  assert.equal(layout.node.binDir, path.dirname(tree.node.executable));
  assert.equal(layout.python.binDir, path.dirname(tree.python.executable));
});

test('resolveBundledProgram maps macOS bare runtime commands', () => {
  const tree = makeTree('darwin', false);
  const app = { isPackaged: false };
  const options = { repoRoot: tree.repoRoot, platform: 'darwin' };

  assert.deepEqual(resolveBundledProgram(app, 'node', ['--version'], options), {
    file: tree.node.executable,
    args: ['--version'],
    bundled: true,
    runtime: 'node',
  });
  assert.deepEqual(resolveBundledProgram(app, 'npm', ['install'], options), {
    file: tree.node.executable,
    args: [tree.node.npmCli, 'install'],
    bundled: true,
    runtime: 'node',
    cli: tree.node.npmCli,
  });
  assert.deepEqual(resolveBundledProgram(app, 'npx', ['tsx', 'x.ts'], options), {
    file: tree.node.executable,
    args: [tree.node.npxCli, 'tsx', 'x.ts'],
    bundled: true,
    runtime: 'node',
    cli: tree.node.npxCli,
  });
  assert.deepEqual(resolveBundledProgram(app, 'python', ['-V'], options), {
    file: tree.python.executable,
    args: ['-B', '-V'],
    bundled: true,
    runtime: 'python',
  });
  assert.deepEqual(resolveBundledProgram(app, 'python3', ['script.py'], options), {
    file: tree.python.executable,
    args: ['-B', 'script.py'],
    bundled: true,
    runtime: 'python',
  });
});

test('resolveBundledProgram preserves explicit paths and non-target commands', () => {
  const tree = makeTree('darwin', false);
  const app = { isPackaged: false };
  const options = { repoRoot: tree.repoRoot, platform: 'darwin' };

  for (const program of ['/usr/bin/node', './node', 'bin/node', 'tools\\node', 'node.exe', 'pnpm']) {
    assert.deepEqual(resolveBundledProgram(app, program, ['x'], options), {
      file: program,
      args: ['x'],
      bundled: false,
    });
  }
});

test('resolveBundledProgram maps Windows commands case-insensitively with exe and cmd suffixes', () => {
  const tree = makeTree('win32', true);
  const app = { isPackaged: true };
  const options = { resourceRoot: tree.resourceRoot, platform: 'win32' };

  assert.equal(resolveBundledProgram(app, 'NoDe.EXE', [], options).file, tree.node.executable);
  assert.deepEqual(resolveBundledProgram(app, 'NPM.CMD', ['ci'], options), {
    file: tree.node.executable,
    args: [tree.node.npmCli, 'ci'],
    bundled: true,
    runtime: 'node',
    cli: tree.node.npmCli,
  });
  assert.deepEqual(resolveBundledProgram(app, 'nPx.exe', ['pkg'], options), {
    file: tree.node.executable,
    args: [tree.node.npxCli, 'pkg'],
    bundled: true,
    runtime: 'node',
    cli: tree.node.npxCli,
  });
  assert.deepEqual(resolveBundledProgram(app, 'PYTHON3.CMD', [], options), {
    file: tree.python.executable,
    args: ['-B'],
    bundled: true,
    runtime: 'python',
  });
  assert.deepEqual(resolveBundledProgram(app, 'python.exe', [], options), {
    file: tree.python.executable,
    args: ['-B'],
    bundled: true,
    runtime: 'python',
  });
  assert.deepEqual(resolveBundledProgram(app, 'C:\\Tools\\node.exe', [], options), {
    file: 'C:\\Tools\\node.exe',
    args: [],
    bundled: false,
  });
  assert.deepEqual(resolveBundledProgram(app, 'C:node.exe', [], options), {
    file: 'C:node.exe',
    args: [],
    bundled: false,
  });
});

test('resolveBundledProgram throws clear errors for missing runtime files', () => {
  const tree = makeTree('darwin', false);
  const app = { isPackaged: false };
  const options = { repoRoot: tree.repoRoot, platform: 'darwin' };

  fs.rmSync(tree.node.executable);
  assert.throws(
    () => resolveBundledProgram(app, 'node', [], options),
    /Bundled Node executable is missing:/,
  );

  touch(tree.node.executable);
  fs.rmSync(tree.node.npmCli);
  assert.throws(
    () => resolveBundledProgram(app, 'npm', [], options),
    /Bundled npm CLI is missing:/,
  );

  fs.rmSync(tree.python.executable);
  assert.throws(
    () => resolveBundledProgram(app, 'python3', [], options),
    /Bundled Python executable is missing:/,
  );
});

test('withBundledRuntimeEnv prepends runtimes and sanitizes Node/Python injection on macOS', () => {
  const tree = makeTree('darwin', false);
  const nodeDir = path.dirname(tree.node.executable);
  const pythonDir = path.dirname(tree.python.executable);
  const baseEnv = {
    FOO: 'bar',
    PATH: ['/usr/bin', nodeDir, pythonDir, '/bin'].join(':'),
    NODE_OPTIONS: '--require=/tmp/host-hook.cjs',
    NODE_PATH: '/tmp/host-modules',
    NODE_EXTRA_CA_CERTS: '/tmp/host-ca.pem',
    NODE_CHANNEL_FD: '9',
    PYTHONPATH: '/tmp/user-site',
  };
  const env = withBundledRuntimeEnv(
    { isPackaged: false },
    baseEnv,
    { repoRoot: tree.repoRoot, platform: 'darwin' },
  );

  assert.equal(env.FOO, 'bar');
  assert.equal(env.PATH, [nodeDir, pythonDir, '/usr/bin', '/bin'].join(':'));
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONPATH, '');
  assert.equal(env.PYTHONHOME, '');
  assert.equal(Object.hasOwn(env, 'NODE_OPTIONS'), false);
  assert.equal(Object.hasOwn(env, 'NODE_PATH'), false);
  assert.equal(Object.hasOwn(env, 'NODE_EXTRA_CA_CERTS'), false);
  assert.equal(Object.hasOwn(env, 'NODE_CHANNEL_FD'), false);
  assert.equal(baseEnv.NODE_OPTIONS, '--require=/tmp/host-hook.cjs');
  assert.equal(baseEnv.PYTHONPATH, '/tmp/user-site');
});

test('withBundledRuntimeEnv uses Windows delimiters and case-insensitive PATH de-dupe', () => {
  const tree = makeTree('win32', true);
  const nodeDir = path.dirname(tree.node.executable);
  const pythonDir = path.dirname(tree.python.executable);
  const baseEnv = {
    Path: 'C:\\ignored-system-path',
    PATH: [nodeDir.toUpperCase(), 'C:\\Windows\\System32', pythonDir.toUpperCase(), 'C:\\Tools'].join(';'),
    FOO: 'bar',
    Node_Options: '--require=C:\\host-hook.cjs',
    node_path: 'C:\\host-modules',
  };
  const env = withBundledRuntimeEnv(
    { isPackaged: true },
    baseEnv,
    { resourceRoot: tree.resourceRoot, platform: 'win32' },
  );

  assert.equal(env.FOO, 'bar');
  assert.equal(
    env.PATH,
    [nodeDir, pythonDir, path.join(tree.pythonRoot, 'Scripts'), 'C:\\Windows\\System32', 'C:\\Tools'].join(';'),
  );
  assert.equal(Object.hasOwn(env, 'Path'), false);
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONPATH, '');
  assert.equal(env.PYTHONHOME, '');
  assert.equal(Object.keys(env).some((key) => key.toLowerCase() === 'node_options'), false);
  assert.equal(Object.keys(env).some((key) => key.toLowerCase() === 'node_path'), false);
});

test('withBundledRuntimeEnv reports missing executable instead of adding broken PATH entries', () => {
  const tree = makeTree('win32', true);
  fs.rmSync(tree.python.executable);

  assert.throws(
    () => withBundledRuntimeEnv(
      { isPackaged: true },
      { Path: 'C:\\Windows\\System32' },
      { resourceRoot: tree.resourceRoot, platform: 'win32' },
    ),
    /Bundled Python executable is missing:/,
  );
});
