#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METADATA_DIR = path.join(ROOT, 'electron', 'runtime');
const MANIFEST_PATH = path.join(METADATA_DIR, 'runtime-manifest.json');
const REQUIREMENTS_PATH = path.join(METADATA_DIR, 'python-requirements.lock');
const MARKER_NAME = '.abu-runtime.json';
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const resourceRoot = argumentValue('--resource-root');
const runtimeRoot = resourceRoot
  ? path.resolve(resourceRoot)
  : path.join(ROOT, 'electron', '.runtime');
const nodeRoot = path.join(runtimeRoot, 'node-runtime');
const pythonRoot = path.join(runtimeRoot, 'python-runtime');

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function platformKey() {
  if (process.platform === 'darwin' && (process.arch === 'arm64' || process.arch === 'x64')) {
    return `darwin-${process.arch}`;
  }
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  throw new Error(`Electron bundled runtimes do not support ${process.platform}-${process.arch}`);
}

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', env: {
    ...process.env,
    PYTHONNOUSERSITE: '1',
    PYTHONPATH: '',
    PYTHONHOME: '',
  } });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${file} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || '').trim();
}

function readMarker(kind, root) {
  const markerPath = path.join(root, MARKER_NAME);
  if (!fs.existsSync(markerPath)) throw new Error(`${kind} marker missing: ${markerPath}`);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const expectedArchive = manifest[kind].archives[platformKey()];
  const expected = {
    schemaVersion: manifest.schemaVersion,
    kind,
    platform: platformKey(),
    version: manifest[kind].version,
    build: manifest[kind].build || null,
    archive: expectedArchive.file,
    archiveSha256: expectedArchive.sha256,
    manifestSha256: sha256File(MANIFEST_PATH),
    requirementsSha256: kind === 'python' ? sha256File(REQUIREMENTS_PATH) : null,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (marker[key] !== value) {
      throw new Error(`${kind} marker ${key} mismatch: expected ${String(value)}, got ${String(marker[key])}`);
    }
  }
  return marker;
}

function nodeLayout() {
  const windows = process.platform === 'win32';
  return {
    node: path.join(nodeRoot, windows ? 'node.exe' : 'bin/node'),
    npmCli: path.join(nodeRoot, windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js'),
    npxCli: path.join(nodeRoot, windows ? 'node_modules/npm/bin/npx-cli.js' : 'lib/node_modules/npm/bin/npx-cli.js'),
  };
}

function verifyNode() {
  const marker = readMarker('node', nodeRoot);
  const layout = nodeLayout();
  for (const file of Object.values(layout)) {
    if (!fs.existsSync(file)) throw new Error(`Node runtime file missing: ${file}`);
  }
  if (!fs.existsSync(path.join(nodeRoot, 'LICENSE'))) throw new Error('Node LICENSE is missing');
  if (sha256File(layout.node) !== marker.executableSha256) throw new Error('Node executable hash does not match its marker');
  const version = run(layout.node, ['--version']);
  if (version !== `v${manifest.node.version}`) throw new Error(`unexpected Node version ${version}`);
  const npmVersion = run(layout.node, [layout.npmCli, '--version']);
  const npxVersion = run(layout.node, [layout.npxCli, '--version']);
  if (!/^\d+\.\d+\.\d+/.test(npmVersion) || !/^\d+\.\d+\.\d+/.test(npxVersion)) {
    throw new Error(`invalid npm/npx versions: npm=${npmVersion}, npx=${npxVersion}`);
  }
  return { node: version, npm: npmVersion, npx: npxVersion };
}

function directPythonRequirements() {
  const input = fs.readFileSync(path.join(METADATA_DIR, 'python-requirements.in'), 'utf8');
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [name, version] = line.split('==');
      return { name, version };
    });
}

function verifyPython() {
  const marker = readMarker('python', pythonRoot);
  const python = path.join(pythonRoot, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
  if (!fs.existsSync(python)) throw new Error(`Python executable missing: ${python}`);
  if (sha256File(python) !== marker.executableSha256) throw new Error('Python executable hash does not match its marker');
  const version = run(python, ['--version']);
  if (!version.startsWith(`Python ${manifest.python.version}`)) throw new Error(`unexpected Python version ${version}`);

  const expected = Object.fromEntries(directPythonRequirements().map(({ name, version: packageVersion }) => [name, packageVersion]));
  const script = [
    'import importlib.metadata, json',
    `names = ${JSON.stringify(Object.keys(expected))}`,
    'print(json.dumps({name: importlib.metadata.version(name) for name in names}, sort_keys=True))',
  ].join('\n');
  const installed = JSON.parse(run(python, ['-I', '-c', script]));
  for (const [name, packageVersion] of Object.entries(expected)) {
    if (installed[name] !== packageVersion) {
      throw new Error(`Python package ${name} mismatch: expected ${packageVersion}, got ${installed[name]}`);
    }
  }

  const noticesPath = path.join(pythonRoot, 'THIRD_PARTY_NOTICES.json');
  if (!fs.existsSync(noticesPath)) throw new Error('Python third-party notices are missing');
  const notices = JSON.parse(fs.readFileSync(noticesPath, 'utf8'));
  const noticed = new Set((notices.packages || []).map((entry) => String(entry.name).toLowerCase()));
  for (const name of Object.keys(expected)) {
    if (!noticed.has(name.toLowerCase())) throw new Error(`Python notice missing for ${name}`);
  }
  const bundledLicense = path.join(pythonRoot, 'PYTHON_LICENSE.txt');
  if (!fs.existsSync(bundledLicense) || fs.statSync(bundledLicense).size === 0) {
    throw new Error('Python runtime license material is missing');
  }
  return { python: version, packages: installed };
}

try {
  const result = {
    platform: platformKey(),
    root: runtimeRoot,
    node: verifyNode(),
    python: verifyPython(),
  };
  console.log(`[runtime] verification passed\n${JSON.stringify(result, null, 2)}`);
} catch (error) {
  console.error(`[runtime] verification failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
}
