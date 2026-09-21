'use strict';

const DEV_SHELL_BUNDLE_ID_ENV = 'ABU_DEV_SHELL_BUNDLE_ID';
const DEV_SHELL_BUNDLE_ID_PATTERN = /^com\.abu\.cowork\.dev\.([a-f0-9]{12})$/;

function devShellSuffix({
  env = process.env,
  platform = process.platform,
  isPackaged = false,
} = {}) {
  if (isPackaged || platform !== 'darwin') return null;
  const value = env[DEV_SHELL_BUNDLE_ID_ENV];
  if (typeof value !== 'string') return null;
  return DEV_SHELL_BUNDLE_ID_PATTERN.exec(value)?.[1] ?? null;
}

function electronProductName(options = {}) {
  if (options.isPackaged) return 'Abu';
  const suffix = devShellSuffix(options);
  return suffix ? `abu-electron-dev-${suffix}` : 'abu-electron-dev';
}

function secretStoreFileName(options = {}) {
  const suffix = devShellSuffix(options);
  return suffix ? `secrets.${suffix}.enc.json` : 'secrets.enc.json';
}

module.exports = {
  DEV_SHELL_BUNDLE_ID_ENV,
  devShellSuffix,
  electronProductName,
  secretStoreFileName,
};
