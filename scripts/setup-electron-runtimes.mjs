#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METADATA_DIR = path.join(ROOT, 'electron', 'runtime');
const MANIFEST_PATH = path.join(METADATA_DIR, 'runtime-manifest.json');
const REQUIREMENTS_PATH = path.join(METADATA_DIR, 'python-requirements.lock');
const RUNTIME_TARGET_ROOT = path.join(ROOT, 'electron', '.runtime');
const NODE_TARGET = path.join(RUNTIME_TARGET_ROOT, 'node-runtime');
const PYTHON_TARGET = path.join(RUNTIME_TARGET_ROOT, 'python-runtime');
const MARKER_NAME = '.abu-runtime.json';

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const args = new Set(process.argv.slice(2));
const force = args.has('--force');
const requestedKinds = args.has('--node') || args.has('--python')
  ? [args.has('--node') ? 'node' : null, args.has('--python') ? 'python' : null].filter(Boolean)
  : ['node', 'python'];

function platformKey() {
  if (process.platform === 'darwin' && (process.arch === 'arm64' || process.arch === 'x64')) {
    return `darwin-${process.arch}`;
  }
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  throw new Error(`Electron bundled runtimes do not support ${process.platform}-${process.arch}`);
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function run(file, commandArgs, options = {}) {
  const result = spawnSync(file, commandArgs, {
    cwd: options.cwd,
    encoding: options.capture ? 'utf8' : undefined,
    env: options.env || process.env,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture
      ? `\nstdout: ${result.stdout || ''}\nstderr: ${result.stderr || ''}`
      : '';
    throw new Error(`${file} ${commandArgs.join(' ')} failed with ${result.status}${detail}`);
  }
  return options.capture ? String(result.stdout || '').trim() : '';
}

async function download(url, destination) {
  console.log(`[runtime] downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
}

function verifyArchive(filePath, expectedSha256) {
  const actual = sha256File(filePath);
  if (actual !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${path.basename(filePath)}: expected ${expectedSha256}, got ${actual}`);
  }
  console.log(`[runtime] verified SHA-256 ${actual}`);
}

function markerFor(kind, archive) {
  const runtime = manifest[kind];
  return {
    schemaVersion: manifest.schemaVersion,
    kind,
    platform: platformKey(),
    version: runtime.version,
    build: runtime.build || null,
    archive: archive.file,
    archiveSha256: archive.sha256,
    manifestSha256: sha256File(MANIFEST_PATH),
    requirementsSha256: kind === 'python' ? sha256File(REQUIREMENTS_PATH) : null,
  };
}

function currentMarker(target, expected) {
  if (force) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(target, MARKER_NAME), 'utf8'));
    return Object.entries(expected).every(([key, value]) => marker[key] === value);
  } catch {
    return false;
  }
}

function makeBuildDir(kind) {
  fs.mkdirSync(RUNTIME_TARGET_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(RUNTIME_TARGET_ROOT, `.build-${kind}-`));
}

function replaceTarget(prepared, target) {
  const backup = `${target}.previous-${process.pid}`;
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, backup);
  try {
    fs.renameSync(prepared, target);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
    throw error;
  }
}

function stripNodeRuntime(runtimeRoot) {
  fs.rmSync(path.join(runtimeRoot, 'include'), { recursive: true, force: true });
  fs.rmSync(path.join(runtimeRoot, 'share'), { recursive: true, force: true });
  fs.rmSync(path.join(runtimeRoot, 'CHANGELOG.md'), { force: true });
  fs.rmSync(path.join(runtimeRoot, 'README.md'), { force: true });

  const corepackRoot = process.platform === 'win32'
    ? path.join(runtimeRoot, 'node_modules', 'corepack')
    : path.join(runtimeRoot, 'lib', 'node_modules', 'corepack');
  fs.rmSync(corepackRoot, { recursive: true, force: true });
  for (const relative of process.platform === 'win32'
    ? ['corepack', 'corepack.cmd']
    : ['bin/corepack']) {
    fs.rmSync(path.join(runtimeRoot, relative), { force: true });
  }
}

function nodeLayout(runtimeRoot) {
  const windows = process.platform === 'win32';
  const node = path.join(runtimeRoot, windows ? 'node.exe' : 'bin/node');
  const npmCli = path.join(
    runtimeRoot,
    windows ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js',
  );
  const npxCli = path.join(
    runtimeRoot,
    windows ? 'node_modules/npm/bin/npx-cli.js' : 'lib/node_modules/npm/bin/npx-cli.js',
  );
  return { node, npmCli, npxCli };
}

async function setupNode() {
  const key = platformKey();
  const archive = manifest.node.archives[key];
  if (!archive) throw new Error(`Node runtime archive missing for ${key}`);
  const expectedMarker = markerFor('node', archive);
  if (currentMarker(NODE_TARGET, expectedMarker)) {
    console.log(`[runtime] Node ${manifest.node.version} is current; skipping download`);
    return;
  }

  const buildDir = makeBuildDir('node');
  try {
    const archivePath = path.join(buildDir, archive.file);
    await download(`${manifest.node.source}${archive.file}`, archivePath);
    verifyArchive(archivePath, archive.sha256);
    const extracted = path.join(buildDir, 'extract');
    fs.mkdirSync(extracted);
    run('tar', ['-xf', archivePath, '-C', extracted]);
    const entries = fs.readdirSync(extracted, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    if (entries.length !== 1) throw new Error(`unexpected Node archive layout: ${entries.map((entry) => entry.name).join(', ')}`);
    const prepared = path.join(extracted, entries[0].name);
    stripNodeRuntime(prepared);

    const layout = nodeLayout(prepared);
    for (const required of [layout.node, layout.npmCli, layout.npxCli, path.join(prepared, 'LICENSE')]) {
      if (!fs.existsSync(required)) throw new Error(`Node runtime is missing ${required}`);
    }
    if (process.platform !== 'win32') fs.chmodSync(layout.node, 0o755);
    const version = run(layout.node, ['--version'], { capture: true });
    if (version !== `v${manifest.node.version}`) {
      throw new Error(`unexpected Node version ${version}`);
    }
    expectedMarker.executableSha256 = sha256File(layout.node);
    fs.writeFileSync(path.join(prepared, MARKER_NAME), `${JSON.stringify(expectedMarker, null, 2)}\n`);
    replaceTarget(prepared, NODE_TARGET);
    console.log(`[runtime] Node ${manifest.node.version} ready at ${path.relative(ROOT, NODE_TARGET)}`);
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

function pythonBinary(runtimeRoot) {
  return path.join(runtimeRoot, process.platform === 'win32' ? 'python.exe' : 'bin/python3');
}

function stripPythonRuntime(runtimeRoot, python) {
  const stdlib = run(
    python,
    ['-I', '-c', 'import sysconfig; print(sysconfig.get_path("stdlib"))'],
    { capture: true },
  );
  for (const relative of [
    'test',
    'tests',
    'tkinter',
    '_tkinter',
    'idlelib',
    'turtledemo',
    'turtle.py',
    'ensurepip',
    'lib2to3',
    'pydoc_data',
    'unittest/test',
    'distutils',
  ]) {
    fs.rmSync(path.join(stdlib, relative), { recursive: true, force: true });
  }
  fs.rmSync(path.join(runtimeRoot, 'include'), { recursive: true, force: true });
  fs.rmSync(path.join(runtimeRoot, 'share'), { recursive: true, force: true });
}

function writePythonNotices(python, runtimeRoot) {
  const output = path.join(runtimeRoot, 'THIRD_PARTY_NOTICES.json');
  const script = String.raw`
import importlib.metadata
import json
import pathlib
import sys

rows = []
for dist in importlib.metadata.distributions():
    metadata = dist.metadata
    name = metadata.get("Name")
    if not name:
        continue
    license_files = []
    for entry in dist.files or []:
        lower = str(entry).lower()
        if "license" in pathlib.PurePosixPath(lower).name or "copying" in pathlib.PurePosixPath(lower).name:
            license_files.append(str(entry))
    rows.append({
        "name": name,
        "version": dist.version,
        "license": metadata.get("License-Expression") or metadata.get("License") or "See bundled distribution metadata",
        "licenseFiles": sorted(license_files),
    })
rows.sort(key=lambda row: row["name"].lower())
pathlib.Path(sys.argv[1]).write_text(json.dumps({
    "schemaVersion": 1,
    "packages": rows,
}, ensure_ascii=True, indent=2) + "\n", encoding="utf-8")
`;
  run(python, ['-I', '-c', script, output]);
}

async function setupPython() {
  const key = platformKey();
  const archive = manifest.python.archives[key];
  if (!archive) throw new Error(`Python runtime archive missing for ${key}`);
  const expectedMarker = markerFor('python', archive);
  if (currentMarker(PYTHON_TARGET, expectedMarker)) {
    console.log(`[runtime] Python ${manifest.python.version} is current; skipping download`);
    return;
  }

  const buildDir = makeBuildDir('python');
  try {
    const archivePath = path.join(buildDir, archive.file);
    const encodedFile = encodeURIComponent(archive.file);
    const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${manifest.python.build}/${encodedFile}`;
    await download(url, archivePath);
    verifyArchive(archivePath, archive.sha256);
    const extracted = path.join(buildDir, 'extract');
    fs.mkdirSync(extracted);
    run('tar', ['-xf', archivePath, '-C', extracted]);
    const prepared = path.join(extracted, 'python');
    const python = pythonBinary(prepared);
    if (!fs.existsSync(python)) throw new Error(`Python runtime is missing ${python}`);
    if (process.platform !== 'win32') fs.chmodSync(python, 0o755);
    const pythonLicense = path.join(prepared, 'lib', `python${manifest.python.version.split('.').slice(0, 2).join('.')}`, 'LICENSE.txt');
    if (!fs.existsSync(pythonLicense) || fs.statSync(pythonLicense).size === 0) {
      throw new Error(`Python runtime archive is missing its license: ${pythonLicense}`);
    }
    fs.copyFileSync(pythonLicense, path.join(prepared, 'PYTHON_LICENSE.txt'));

    run(python, ['-m', 'ensurepip', '--default-pip']);
    run(python, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--no-cache-dir',
      '--only-binary=:all:',
      '--require-hashes',
      '-r',
      REQUIREMENTS_PATH,
    ]);
    run(python, ['-m', 'pip', 'uninstall', '-y', 'pip', 'setuptools', 'wheel']);
    stripPythonRuntime(prepared, python);
    writePythonNotices(python, prepared);

    const bundledLicense = path.join(prepared, 'PYTHON_LICENSE.txt');
    if (!fs.existsSync(bundledLicense) || fs.statSync(bundledLicense).size === 0) {
      throw new Error('Python runtime did not retain its license material');
    }
    expectedMarker.executableSha256 = sha256File(python);
    expectedMarker.requirements = path.basename(REQUIREMENTS_PATH);
    fs.writeFileSync(path.join(prepared, MARKER_NAME), `${JSON.stringify(expectedMarker, null, 2)}\n`);
    replaceTarget(prepared, PYTHON_TARGET);
    console.log(`[runtime] Python ${manifest.python.version} ready at ${path.relative(ROOT, PYTHON_TARGET)}`);
  } finally {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
}

async function main() {
  if (manifest.schemaVersion !== 1) throw new Error(`unsupported runtime manifest schema ${manifest.schemaVersion}`);
  if (!fs.existsSync(REQUIREMENTS_PATH)) throw new Error(`missing ${REQUIREMENTS_PATH}`);
  console.log(`[runtime] target ${platformKey()}, manifest ${sha256Text(fs.readFileSync(MANIFEST_PATH, 'utf8')).slice(0, 12)}`);
  for (const kind of requestedKinds) {
    if (kind === 'node') await setupNode();
    if (kind === 'python') await setupPython();
  }
}

main().catch((error) => {
  console.error(`[runtime] setup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
