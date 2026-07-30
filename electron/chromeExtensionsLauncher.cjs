'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CHROME_EXTENSIONS_URL = 'chrome://extensions/';

function chromeExecutableCandidates(
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
) {
  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA &&
        path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.PROGRAMFILES &&
        path.win32.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['PROGRAMFILES(X86)'] &&
        path.win32.join(
          env['PROGRAMFILES(X86)'],
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
      env.ProgramW6432 &&
        path.win32.join(env.ProgramW6432, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(homeDir, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

function spawnDetached(executable, args, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * chrome:// URLs are browser-internal pages, not OS URL schemes. In
 * particular, Windows may hang shell.openExternal() and later report that no
 * browser can open the app. Launch Chrome itself and pass the internal URL as
 * an argument instead.
 */
async function openChromeExtensionsPage(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const existsSync = options.existsSync || fs.existsSync;
  const spawnImpl = options.spawnImpl || spawn;
  const candidates = chromeExecutableCandidates(platform, env, homeDir);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error('Google Chrome executable was not found');
  }
  await spawnDetached(
    executable,
    ['--new-window', CHROME_EXTENSIONS_URL],
    spawnImpl,
  );
  return null;
}

module.exports = {
  CHROME_EXTENSIONS_URL,
  chromeExecutableCandidates,
  openChromeExtensionsPage,
  spawnDetached,
};
