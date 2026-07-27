'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { REPO_ROOT } = require('./appEnv.cjs');

const WINDOWS_EXTENSIONS = new Set(['.exe', '.cmd']);
const BUNDLED_COMMANDS = new Set(['node', 'npm', 'npx', 'python', 'python3']);
const UNSAFE_NODE_ENV_KEYS = new Set([
  'node_channel_fd',
  'node_extra_ca_certs',
  'node_options',
  'node_path',
  'node_repl_history',
]);

function platformFor(options) {
  return options && options.platform ? options.platform : process.platform;
}

function isPackagedApp(app) {
  return Boolean(app && app.isPackaged);
}

function packagedResourceRoot(options) {
  if (options && options.resourceRoot) return path.resolve(options.resourceRoot);
  if (process.resourcesPath) return path.resolve(process.resourcesPath);
  throw new Error('Packaged runtime root is unavailable: process.resourcesPath is not set');
}

function runtimeRoots(app, options = {}) {
  const platform = platformFor(options);
  const packaged = isPackagedApp(app);
  const repoRoot = path.resolve(options.repoRoot || REPO_ROOT);
  const runtimeRoot = packaged
    ? packagedResourceRoot(options)
    : path.join(repoRoot, 'electron', '.runtime');

  return {
    platform,
    isPackaged: packaged,
    repoRoot,
    runtimeRoot,
    root: runtimeRoot,
    nodeRoot: path.join(runtimeRoot, 'node-runtime'),
    pythonRoot: path.join(runtimeRoot, 'python-runtime'),
  };
}

function runtimeLayout(app, options = {}) {
  const roots = runtimeRoots(app, options);
  const windows = roots.platform === 'win32';
  const nodeBinDir = windows
    ? roots.nodeRoot
    : path.join(roots.nodeRoot, 'bin');
  const pythonBinDir = windows
    ? roots.pythonRoot
    : path.join(roots.pythonRoot, 'bin');

  return {
    ...roots,
    node: {
      root: roots.nodeRoot,
      binDir: nodeBinDir,
      executable: path.join(nodeBinDir, windows ? 'node.exe' : 'node'),
      npmCli: path.join(
        roots.nodeRoot,
        windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js',
      ),
      npxCli: path.join(
        roots.nodeRoot,
        windows ? 'node_modules/npm/bin/npx-cli.js' : 'lib/node_modules/npm/bin/npx-cli.js',
      ),
    },
    python: {
      root: roots.pythonRoot,
      binDir: pythonBinDir,
      scriptsDir: windows ? path.join(roots.pythonRoot, 'Scripts') : pythonBinDir,
      executable: path.join(pythonBinDir, windows ? 'python.exe' : 'python3'),
    },
  };
}

function hasPathSyntax(program) {
  return (
    path.isAbsolute(program) ||
    path.win32.isAbsolute(program) ||
    program.includes('/') ||
    program.includes('\\')
  );
}

function bundledCommandName(program, platform) {
  if (typeof program !== 'string' || program.length === 0 || hasPathSyntax(program)) {
    return null;
  }

  if (platform === 'win32') {
    const parsed = path.win32.parse(program);
    if (parsed.dir) return null;
    const lowerExt = parsed.ext.toLowerCase();
    if (lowerExt && !WINDOWS_EXTENSIONS.has(lowerExt)) return null;
    const base = (lowerExt ? parsed.name : program).toLowerCase();
    return BUNDLED_COMMANDS.has(base) ? base : null;
  }

  return BUNDLED_COMMANDS.has(program) ? program : null;
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

function asArgs(args) {
  return Array.isArray(args) ? [...args] : [];
}

function resolveBundledProgram(app, program, args = [], options = {}) {
  const platform = platformFor(options);
  const command = bundledCommandName(program, platform);
  const originalArgs = asArgs(args);
  if (!command) {
    return { file: program, args: originalArgs, bundled: false };
  }

  const layout = runtimeLayout(app, options);
  if (command === 'node') {
    requireFile(layout.node.executable, 'Bundled Node executable');
    return { file: layout.node.executable, args: originalArgs, bundled: true, runtime: 'node' };
  }

  if (command === 'npm' || command === 'npx') {
    const cli = command === 'npm' ? layout.node.npmCli : layout.node.npxCli;
    requireFile(layout.node.executable, 'Bundled Node executable');
    requireFile(cli, `Bundled ${command} CLI`);
    return {
      file: layout.node.executable,
      args: [cli, ...originalArgs],
      bundled: true,
      runtime: 'node',
      cli,
    };
  }

  requireFile(layout.python.executable, 'Bundled Python executable');
  return {
    file: layout.python.executable,
    args: ['-B', ...originalArgs],
    bundled: true,
    runtime: 'python',
  };
}

function dedupePathEntries(entries, platform) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const text = String(entry || '');
    if (!text) continue;
    const key = platform === 'win32' ? text.toLowerCase() : text;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function withBundledRuntimeEnv(app, baseEnv = process.env, options = {}) {
  const platform = platformFor(options);
  const layout = runtimeLayout(app, options);
  requireFile(layout.node.executable, 'Bundled Node executable');
  requireFile(layout.python.executable, 'Bundled Python executable');

  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (UNSAFE_NODE_ENV_KEYS.has(key.toLowerCase())) delete env[key];
  }
  const delimiter = platform === 'win32' ? ';' : ':';
  const pathKeys = Object.keys(env).filter((candidate) =>
    platform === 'win32' ? candidate.toLowerCase() === 'path' : candidate === 'PATH'
  );
  const key = pathKeys.at(-1) || (platform === 'win32' ? 'Path' : 'PATH');
  const suffix = typeof env[key] === 'string' ? env[key].split(delimiter) : [];
  for (const duplicateKey of pathKeys) {
    if (duplicateKey !== key) delete env[duplicateKey];
  }
  env[key] = dedupePathEntries(
    [layout.node.binDir, layout.python.binDir, layout.python.scriptsDir, ...suffix],
    platform,
  ).join(delimiter);
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONDONTWRITEBYTECODE = '1';
  env.PYTHONUTF8 = '1';
  env.PYTHONPATH = '';
  env.PYTHONHOME = '';
  return env;
}

module.exports = {
  runtimeRoots,
  runtimeLayout,
  resolveBundledProgram,
  withBundledRuntimeEnv,
};
