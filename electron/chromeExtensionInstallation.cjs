'use strict';

// Installation is independent of the extension's live WebSocket connection.
// Read only Chrome's extension registration/manifest metadata. Never return
// profile names, paths, other extension details, or preference contents.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function chromeUserDataDirectory(platform = process.platform, home = os.homedir(), env = process.env) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  if (platform === 'linux') return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'google-chrome');
  return null;
}

async function assertLocalDirectories(directory) {
  const absolute = path.resolve(directory);
  if (/^[\\/]{2}/.test(absolute)) throw new Error('Network directory');
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked directory');
  }
}

async function readJson(file, maxBytes) {
  let handle;
  try {
    // Reject existing parent links too. This is conservative metadata discovery,
    // not a sandbox against a local user racing directory replacements.
    await assertLocalDirectories(path.dirname(file));
    // Preference and manifest files must be regular local files, not links,
    // devices, or pipes. Bound reads even if a file grows during the read.
    if (!(await fs.promises.lstat(file)).isFile()) throw new Error('Not a regular file');
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid file size');
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error('File too large');
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

function isAbuManifest(manifest) {
  return manifest?.name === 'Abu Browser Bridge'
    && manifest?.manifest_version === 3
    && manifest?.background?.service_worker === 'background.js'
    && manifest?.action?.default_popup === 'popup.html';
}

function manifestPath(profile, registeredPath) {
  if (typeof registeredPath !== 'string' || !registeredPath || registeredPath.includes('\0')) return null;
  // Never follow a network location from a profile preference.
  if (/^(?:[\\/]{2}|[a-z]+:\/\/)/i.test(registeredPath)) return null;
  if (path.isAbsolute(registeredPath)) return path.join(registeredPath, 'manifest.json');
  const extensions = path.join(profile, 'Extensions');
  const resolved = path.resolve(extensions, registeredPath);
  const relative = path.relative(extensions, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return path.join(resolved, 'manifest.json');
}

async function readChromeExtensionInstallation(options = {}) {
  const root = chromeUserDataDirectory(options.platform, options.home, options.env);
  if (!root) return 'unknown';
  try {
    await assertLocalDirectories(root);
    const directories = await fs.promises.readdir(root, { withFileTypes: true });
    const candidates = directories.filter((entry) => /^(Default|Profile \d+)$/.test(entry.name));
    const profiles = candidates.filter((entry) => entry.isDirectory());
    if (profiles.length > 128) return 'unknown';
    let uncertain = candidates.length !== profiles.length;
    for (const entry of profiles) {
      const profile = path.join(root, entry.name);
      let registrations = {};
      let readable = false;
      let profileUncertain = false;
      let sourceSettings;
      for (const name of ['Preferences', 'Secure Preferences']) {
        try {
          const prefs = await readJson(path.join(profile, name), 16 * 1024 * 1024);
          if (prefs === undefined) continue;
          if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('Invalid preferences');
          if (prefs.extensions !== undefined && (!prefs.extensions || typeof prefs.extensions !== 'object' || Array.isArray(prefs.extensions))) throw new Error('Invalid extensions');
          readable = true;
          const settings = prefs.extensions?.settings;
          if (settings === undefined) continue;
          if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid registrations');
          // Chrome selects one backing store for this whole preference. A
          // union would resurrect a removed extension from a stale copy.
          if (sourceSettings && JSON.stringify(sourceSettings) !== JSON.stringify(settings)) {
            profileUncertain = true;
          }
          sourceSettings = settings;
          registrations = settings;
        } catch {
          profileUncertain = true;
        }
      }
      if (!readable || profileUncertain) { uncertain = true; continue; }
      const entries = Object.values(registrations);
      if (entries.length > 1024) return 'unknown';
      for (const registration of entries) {
        if (!registration || typeof registration !== 'object') { uncertain = true; continue; }
        if (isAbuManifest(registration.manifest)) return 'installed';
        // Recent Chrome omits the manifest for unpacked extensions; their
        // registration points to the folder selected by the user at install.
        if (registration.manifest) continue;
        const file = manifestPath(profile, registration.path);
        if (!file) { uncertain = true; continue; }
        try {
          const manifest = await readJson(file, 128 * 1024);
          if (isAbuManifest(manifest)) return 'installed';
          if (!manifest) uncertain = true;
        } catch {
          uncertain = true;
        }
      }
    }
    return uncertain ? 'unknown' : 'not-installed';
  } catch (error) {
    return error.code === 'ENOENT' ? 'not-installed' : 'unknown';
  }
}

module.exports = { chromeUserDataDirectory, readChromeExtensionInstallation };
