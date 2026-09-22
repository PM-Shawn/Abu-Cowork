/**
 * Destructive-but-isolated Windows installed E2E for Computer Use.
 *
 * The test package has a distinct appId/product/protocol configuration. This
 * harness refuses to start if that test identity already exists, snapshots the
 * real Abu binary + uninstall/protocol registrations, and verifies those bytes
 * are unchanged after uninstalling the test package.
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.error('[windows-cu-installed] Windows is required');
  process.exit(2);
}

const repoRoot = path.resolve(__dirname, '..');
const outputDir = path.join(repoRoot, 'release-electron-computer-use-test');
const productName = 'AbuComputerUseTest';
const localPrograms = path.join(process.env.LOCALAPPDATA || '', 'Programs');
const productionExe = path.join(localPrograms, 'abu', 'Abu.exe');
const productionDir = path.dirname(productionExe);
const expectedInstallDir = path.join(localPrograms, productName);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function regSnapshot(key) {
  const result = spawnSync('reg.exe', ['query', key, '/s'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  if (result.status === 1) return '';
  assert.equal(result.status, 0, `reg query failed for ${key}: ${result.stderr || ''}`);
  return String(result.stdout).replace(/\r\n/g, '\n').trim();
}

function findInstaller() {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  const matches = fs.readdirSync(outputDir)
    .filter((name) => /^AbuComputerUseTest-.*-setup\.exe$/i.test(name))
    .map((name) => path.join(outputDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  assert.ok(matches[0], `isolated installer is missing under ${outputDir}`);
  return matches[0];
}

function findInstalledExe() {
  const direct = path.join(expectedInstallDir, `${productName}.exe`);
  if (fs.existsSync(direct)) return direct;
  return null;
}

function findUnexpectedTestExe() {
  if (!fs.existsSync(localPrograms)) return null;
  const pending = [localPrograms];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.toLowerCase() === `${productName}.exe`.toLowerCase()) {
        return candidate;
      }
    }
  }
  return null;
}

function productionFingerprint() {
  const files = [
    productionExe,
    path.join(productionDir, 'resources', 'app.asar'),
    path.join(productionDir, 'resources', 'native-helper', 'native-helper.exe'),
  ];
  return files.map((file) => ({
    file,
    exists: fs.existsSync(file),
    hash: fs.existsSync(file) ? sha256(file) : null,
  }));
}

function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error(`${label} timed out`));
      setTimeout(poll, 250);
    };
    poll();
  });
}

function runChecked(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeout ?? 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  assert.equal(
    result.status,
    0,
    `${path.basename(file)} failed (${result.status}): ${result.stderr || result.stdout || ''}`,
  );
  return result;
}

function stopSpawnedTree(child) {
  if (!child?.pid || child.exitCode != null) return;
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 15_000,
  });
}

function findUninstaller(installDir) {
  return fs.readdirSync(installDir)
    .filter((name) => /^Uninstall .*\.exe$/i.test(name))
    .map((name) => path.join(installDir, name))[0] || null;
}

async function main() {
  const installer = findInstaller();
  assert.ok(fs.existsSync(installer), `installer does not exist: ${installer}`);

  const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  const protocolKey = 'HKCU\\Software\\Classes\\abu';
  const production = productionFingerprint();
  const uninstallBefore = regSnapshot(uninstallKey);
  const protocolBefore = regSnapshot(protocolKey);
  assert.equal(findInstalledExe(), null, 'isolated test product is already installed');
  assert.equal(findUnexpectedTestExe(), null, 'test executable already exists outside its isolated directory');
  assert.doesNotMatch(uninstallBefore, /AbuComputerUseTest/i, 'test uninstall identity already exists');

  let app = null;
  let installedExe = null;
  let installDir = null;
  let uninstaller = null;
  let goldenOutput = '';
  let installed = false;
  try {
    runChecked(installer, ['/S'], { timeout: 180_000 });
    installed = true;
    installedExe = await waitFor(findInstalledExe, 30_000, 'installed executable');
    installDir = path.dirname(installedExe);
    assert.equal(
      path.resolve(installDir).toLowerCase(),
      path.resolve(expectedInstallDir).toLowerCase(),
      'isolated installer selected an unexpected directory',
    );
    assert.notEqual(
      path.resolve(installDir).toLowerCase(),
      path.resolve(productionDir).toLowerCase(),
      'isolated installer overlapped the production Abu directory',
    );
    uninstaller = findUninstaller(installDir);
    assert.ok(uninstaller, 'isolated uninstaller is missing');

    app = spawn(installedExe, [], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ABU_DISABLE_AUTO_UPDATE: '1' },
    });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    assert.equal(app.exitCode, null, 'installed app exited during startup');
    // Product startup is now proven. Stop this exact process tree before the
    // desktop Golden Journey so a delayed renderer/show event cannot steal
    // foreground from Calculator between capture and guarded input.
    stopSpawnedTree(app);
    app = null;
    await new Promise((resolve) => setTimeout(resolve, 500));

    const helper = path.join(installDir, 'resources', 'native-helper', 'native-helper.exe');
    assert.ok(fs.existsSync(helper), 'installed native-helper is missing');
    const golden = runChecked(
      process.execPath,
      [path.join(repoRoot, 'electron', 'spike', 'windowsComputerUseVerify.cjs')],
      {
        timeout: 240_000,
        env: { ...process.env, ABU_NATIVE_HELPER_PATH: helper },
      },
    );
    goldenOutput = String(golden.stdout).trim();
    assert.match(goldenOutput, /AUTOMATED_PASSED=true/);
  } finally {
    stopSpawnedTree(app);
    if (installed && uninstaller && fs.existsSync(uninstaller)) {
      runChecked(uninstaller, ['/S'], { timeout: 180_000 });
    }
  }

  await waitFor(() => !installedExe || !fs.existsSync(installedExe), 30_000, 'test uninstall');
  await waitFor(
    () => !/AbuComputerUseTest/i.test(regSnapshot(uninstallKey)),
    30_000,
    'test uninstall registration cleanup',
  );
  const uninstallAfter = regSnapshot(uninstallKey);
  const protocolAfter = regSnapshot(protocolKey);
  assert.doesNotMatch(uninstallAfter, /AbuComputerUseTest/i, 'test uninstall identity remains');
  assert.equal(uninstallAfter, uninstallBefore, 'existing uninstall registrations changed');
  assert.equal(protocolAfter, protocolBefore, 'existing abu:// protocol registration changed');
  for (const expected of production) {
    assert.equal(fs.existsSync(expected.file), expected.exists, `production file presence changed: ${expected.file}`);
    if (expected.exists) {
      assert.equal(sha256(expected.file), expected.hash, `production file changed: ${expected.file}`);
    }
  }

  const goldenLines = goldenOutput.split(/\r?\n/).filter(Boolean);
  console.log(`[windows-cu-installed] ${JSON.stringify({
    installedSmoke: 'PASS',
    isolatedProduct: productName,
    productionAbuPreserved: true,
    uninstallRegistryPreserved: true,
    protocolRegistryPreserved: true,
    automatedGolden: goldenLines.at(-3) || null,
  })}`);
  console.log('[windows-cu-installed] PASSED=true');
}

main().catch((error) => {
  console.error(`[windows-cu-installed] FAILED: ${String(error?.stack || error).slice(0, 4_000)}`);
  process.exitCode = 1;
});
