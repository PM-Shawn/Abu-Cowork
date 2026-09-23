'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromeUserDataDirectory, readChromeExtensionInstallation } = require('./chromeExtensionInstallation.cjs');
const manifest = { name: 'Abu Browser Bridge', manifest_version: 3, background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' } };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'abu-installation-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = chromeUserDataDirectory('darwin', home, {});
  const put = (profile, file, value) => {
    const target = path.join(root, profile, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
    return target;
  };
  return { home, root, put, read: () => readChromeExtensionInstallation({ platform: 'darwin', home, env: {} }) };
}
const registered = (entry = { manifest }) => ({ extensions: { settings: { abu: entry } } });

test('detects unpacked installation while Chrome is closed, and removal without a live handshake', async (t) => {
  const f = fixture(t);
  assert.equal(await f.read(), 'not-installed');
  const extension = path.join(f.home, 'browser-extension');
  fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  f.put('Default', 'Secure Preferences', registered({ path: extension, location: 4, disable_reasons: [1] }));
  assert.equal(await f.read(), 'installed'); // Disabled still means installed.
  f.put('Default', 'Secure Preferences', registered({ path: extension }));
  assert.equal(await f.read(), 'installed');
  f.put('Default', 'Secure Preferences', { extensions: { settings: {} } });
  assert.equal(await f.read(), 'not-installed'); // Files alone do not imply registration.
});

test('detects another standard profile without returning profile or preference data', async (t) => {
  const f = fixture(t);
  f.put('Default', 'Preferences', {});
  f.put('Profile 3', 'Preferences', registered());
  assert.equal(await f.read(), 'installed');
});

test('does not identify an unrelated extension by name alone', async (t) => {
  const f = fixture(t);
  f.put('Default', 'Preferences', registered({ manifest: { name: manifest.name } }));
  assert.equal(await f.read(), 'not-installed');
});

test('conflicting preference stores cannot resurrect a removed registration', async (t) => {
  const f = fixture(t);
  f.put('Default', 'Preferences', registered());
  f.put('Default', 'Secure Preferences', { extensions: { settings: {} } });
  assert.equal(await f.read(), 'unknown');
});

test('malformed or unreadable preference data is unknown, never uninstalled', async (t) => {
  const f = fixture(t);
  for (const value of [null, [], true, 'broken', { extensions: [] }, { extensions: null }, { extensions: { settings: [] } }]) {
    f.put('Default', 'Preferences', value);
    assert.equal(await f.read(), 'unknown');
  }
  const target = f.put('Default', 'Preferences', registered());
  fs.writeFileSync(target, '{');
  assert.equal(await f.read(), 'unknown');
  fs.writeFileSync(target, ' '.repeat(16 * 1024 * 1024 + 1));
  assert.equal(await f.read(), 'unknown');
});

test('does not follow linked profiles or preference files', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.root, { recursive: true });
  const linked = path.join(f.home, 'linked');
  fs.mkdirSync(linked);
  fs.writeFileSync(path.join(linked, 'Preferences'), JSON.stringify(registered()));
  fs.symlinkSync(linked, path.join(f.root, 'Default'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await f.read(), 'unknown');
  fs.unlinkSync(path.join(f.root, 'Default'));
  fs.mkdirSync(path.join(f.root, 'Default'));
  const preferenceFile = path.join(f.root, 'Default', 'Preferences');
  const lstat = fs.promises.lstat.bind(fs.promises);
  const open = fs.promises.open.bind(fs.promises);
  t.mock.method(fs.promises, 'lstat', async (file, ...args) => file === preferenceFile
    ? { isFile: () => false, isSymbolicLink: () => true }
    : lstat(file, ...args));
  let linkedFileOpens = 0;
  t.mock.method(fs.promises, 'open', (...args) => {
    if (args[0] === preferenceFile) linkedFileOpens++;
    return open(...args);
  });
  assert.equal(await f.read(), 'unknown');
  assert.equal(linkedFileOpens, 0, 'must not open a linked preference file');
});

test('does not follow a linked parent of an unpacked extension manifest', async (t) => {
  const f = fixture(t);
  const actual = path.join(f.home, 'actual');
  fs.mkdirSync(actual);
  fs.writeFileSync(path.join(actual, 'manifest.json'), JSON.stringify(manifest));
  const linked = path.join(f.home, 'linked');
  fs.symlinkSync(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
  f.put('Default', 'Preferences', registered({ path: linked }));
  assert.equal(await f.read(), 'unknown');
});

test('rejects network and traversing registration paths; missing manifests stay unknown', async (t) => {
  const f = fixture(t);
  for (const extensionPath of ['//server/share/abu', '\\\\server\\share', '../secret', 'https://example.com', '/missing-extension']) {
    f.put('Default', 'Preferences', registered({ path: extensionPath }));
    assert.equal(await f.read(), 'unknown');
  }
});

test('uses standard platform locations and reports unsupported platforms honestly', async () => {
  assert.equal(chromeUserDataDirectory('win32', 'C:\\Users\\Abu', {}), 'C:\\Users\\Abu\\AppData\\Local\\Google\\Chrome\\User Data');
  assert.equal(chromeUserDataDirectory('linux', '/home/abu', { XDG_CONFIG_HOME: '/config' }), '/config/google-chrome');
  assert.equal(await readChromeExtensionInstallation({ platform: 'unsupported' }), 'unknown');
});
