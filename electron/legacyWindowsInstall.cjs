'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const LEGACY_UNINSTALL_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Abu';

function defaultRegistryRun(args) {
  const systemRoot = process.env.SystemRoot;
  if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) {
    return { status: 1, stdout: '', stderr: 'SystemRoot is unavailable' };
  }
  return childProcess.spawnSync(path.win32.join(systemRoot, 'System32', 'reg.exe'), args, {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function queryRegistryValue(runRegistry, name) {
  const result = runRegistry(['query', LEGACY_UNINSTALL_KEY, '/v', name]);
  if (result?.status !== 0 || typeof result.stdout !== 'string') return null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = result.stdout.match(
    new RegExp(`^\\s*${escapedName}\\s+REG_[A-Z0-9_]+\\s+(.*)$`, 'im'),
  );
  return match?.[1]?.trim() || null;
}

function normalizeWindowsPath(value) {
  if (typeof value !== 'string') return null;
  const stripped = value.trim().replace(/^"|"$/g, '');
  if (!stripped) return null;
  return path.win32.normalize(stripped).replace(/[\\/]+$/, '').toLowerCase();
}

function executableFromUninstallString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1);
    return closingQuote > 1 ? trimmed.slice(1, closingQuote) : null;
  }
  const exeEnd = trimmed.toLowerCase().indexOf('.exe');
  return exeEnd >= 0 ? trimmed.slice(0, exeEnd + 4) : null;
}

function isLegacyVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value || '');
  if (!match) return false;
  const [major, minor] = match.slice(1, 3).map(Number);
  return major === 0 && minor < 34;
}

/**
 * Recognize only Abu's old current-user Tauri installer record. The key name
 * alone is not trusted: every path must point to the historical fixed install
 * directory and the version must predate the Electron transition.
 */
function inspectLegacyTauriInstall({
  platform = process.platform,
  env = process.env,
  runRegistry = defaultRegistryRun,
} = {}) {
  if (platform !== 'win32' || typeof env.LOCALAPPDATA !== 'string') return null;
  const expectedInstallDir = path.win32.join(env.LOCALAPPDATA, 'Abu');
  const expectedUninstaller = path.win32.join(expectedInstallDir, 'uninstall.exe');
  const displayName = queryRegistryValue(runRegistry, 'DisplayName');
  const displayVersion = queryRegistryValue(runRegistry, 'DisplayVersion');
  const installLocation = queryRegistryValue(runRegistry, 'InstallLocation');
  const uninstallString = queryRegistryValue(runRegistry, 'UninstallString');
  const uninstallExecutable = executableFromUninstallString(uninstallString);

  if (
    displayName !== 'Abu' ||
    !isLegacyVersion(displayVersion) ||
    normalizeWindowsPath(installLocation) !== normalizeWindowsPath(expectedInstallDir) ||
    normalizeWindowsPath(uninstallExecutable) !== normalizeWindowsPath(expectedUninstaller)
  ) {
    return null;
  }
  return {
    displayName,
    displayVersion,
    installLocation: expectedInstallDir,
    uninstallString,
  };
}

/**
 * Hide the old Tauri uninstall entry only after the Electron migration is
 * complete. Old binaries and all old app data remain untouched for rollback.
 * The Electron NSIS uninstaller removes this flag, making the old entry visible
 * again if the user rolls back.
 */
function hideLegacyTauriUninstallEntry(options = {}) {
  const runRegistry = options.runRegistry || defaultRegistryRun;
  const legacy = inspectLegacyTauriInstall({ ...options, runRegistry });
  if (!legacy) return { hidden: false, reason: 'not-recognized' };
  const result = runRegistry([
    'add',
    LEGACY_UNINSTALL_KEY,
    '/v',
    'SystemComponent',
    '/t',
    'REG_DWORD',
    '/d',
    '1',
    '/f',
  ]);
  if (result?.status !== 0) {
    return {
      hidden: false,
      reason: 'registry-write-failed',
      error: String(result?.stderr || result?.error || '').trim(),
    };
  }
  return { hidden: true, legacy };
}

module.exports = {
  LEGACY_UNINSTALL_KEY,
  executableFromUninstallString,
  hideLegacyTauriUninstallEntry,
  inspectLegacyTauriInstall,
  isLegacyVersion,
  normalizeWindowsPath,
};
