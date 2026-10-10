/**
 * Main-process gate for "open with the default application".
 *
 * `shell.openPath` hands a path to the operating system, and the system's file
 * association decides what happens: a document opens in a viewer, a program or
 * a script starts. Every renderer request to open a local path, as a path or
 * as a `file:` URL, is judged here before it reaches the shell: a target the
 * system would start, install or mount is refused, and the renderer shows it
 * in the file manager.
 */
'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { fileURLToPath } = require('node:url');

/** Error message of a refused open. `src/utils/openWithDefaultApp.ts` matches it. */
const OPEN_REFUSED_RUNS_BY_DEFAULT = 'open-refused:runs-by-default';

/**
 * Extensions whose default handling starts the file, installs it or mounts it,
 * on macOS, on Windows or on a Linux desktop. Lower case. One list for every
 * platform: a handler for another system's programs can be installed anywhere.
 * `src/utils/runByDefault.ts` holds the same list for the interface.
 */
const RUN_BY_DEFAULT_EXTENSIONS = new Set([
  // macOS: bundles and files Terminal runs
  'app', 'command', 'tool', 'terminal',
  // macOS: Automator and AppleScript
  'workflow', 'action', 'scpt', 'scptd', 'applescript',
  // macOS: location files, installers, disk images
  'fileloc', 'inetloc', 'prefpane', 'pkg', 'mpkg', 'dmg',
  // Windows: programs and command scripts
  'exe', 'com', 'scr', 'pif', 'bat', 'cmd',
  // Windows: Script Host and HTML applications
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'hta',
  // Windows: installers and app packages
  'msi', 'msp', 'msu', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'application', 'appref-ms', 'gadget',
  // Windows: shortcuts, shell and system files
  'lnk', 'url', 'scf', 'reg', 'cpl', 'msc', 'chm', 'hlp', 'diagcab', 'settingcontent-ms',
  // Windows: disk images
  'iso', 'img', 'vhd', 'vhdx',
  // Scripts that the Windows installer of their runtime sets to run on open
  // (Python, Git for Windows, RubyInstaller, Perl)
  'py', 'pyw', 'pyc', 'pyo', 'pyz', 'pyzw', 'sh', 'rb', 'rbw', 'pl',
  // Java
  'jar', 'jnlp',
  // Linux desktops
  'appimage', 'desktop', 'run', 'deb', 'rpm',
]);

/**
 * The extension the system reads from a file name, lower case, or `''` for a
 * name without one. Windows drops trailing dots and spaces, and the last
 * extension decides.
 */
function extensionOf(name) {
  const trimmed = name.replace(/[. ]+$/, '');
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) return '';
  return trimmed.slice(dot + 1).toLowerCase();
}

function baseNameOf(filePath, platform) {
  return (platform === 'win32' ? nodePath.win32 : nodePath.posix).basename(filePath);
}

/** Whether the name of this path carries an extension the system would run. */
function hasRunByDefaultExtension(filePath, platform) {
  const name = baseNameOf(filePath, platform);
  // `report.txt:setup.exe:$DATA` names a stream of `report.txt` on NTFS: every part counts.
  const parts = platform === 'win32' ? name.split(':') : [name];
  return parts.some((part) => {
    if (RUN_BY_DEFAULT_EXTENSIONS.has(extensionOf(part))) return true;
    // Windows reads a name that is only a leading dot and a word, `.bat`, as that extension.
    const bare = part.replace(/[. ]+$/, '');
    return bare.startsWith('.') && RUN_BY_DEFAULT_EXTENSIONS.has(bare.slice(1).toLowerCase());
  });
}

/**
 * Judges one local path. Resolves to `{ path }`, the real path to hand to the
 * shell, or to `{ refused }` with the refusal's error message.
 *
 * The system opens what a symbolic link points to, so the name as given and
 * the resolved name are both read. A file with no extension tells nothing by
 * its name: macOS and Linux run it in a terminal when it is executable.
 *
 * @param {string} rawPath
 * @param {{ fs?: Pick<typeof import('node:fs').promises, 'realpath' | 'stat'>, platform?: NodeJS.Platform }} [deps]
 * @returns {Promise<{ path: string } | { refused: string }>}
 */
async function resolveOpenTarget(rawPath, { fs = nodeFs.promises, platform = process.platform } = {}) {
  if (typeof rawPath !== 'string' || rawPath === '') {
    throw new TypeError('open: path must be a non-empty string');
  }
  const realPath = await fs.realpath(rawPath);
  if (hasRunByDefaultExtension(rawPath, platform) || hasRunByDefaultExtension(realPath, platform)) {
    return { refused: OPEN_REFUSED_RUNS_BY_DEFAULT };
  }
  if (platform !== 'win32' && extensionOf(baseNameOf(realPath, platform)) === '') {
    const stat = await fs.stat(realPath);
    if (stat.isFile() && (stat.mode & 0o111) !== 0) return { refused: OPEN_REFUSED_RUNS_BY_DEFAULT };
  }
  return { path: realPath };
}

/**
 * A URI scheme of at least two characters: `https:`, `mailto:`, `file:`. A
 * single letter before the colon is a Windows drive, `C:\Users\...`.
 */
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:/;

/**
 * The local path a string handed over as a URL names, or `null` for a URL of
 * any other scheme. A `file:` URL names a local path, and so does a string
 * with no scheme at all.
 */
function localPathOfUrl(value) {
  if (!URL_SCHEME_RE.test(value)) return value;
  if (!URL.canParse(value) || new URL(value).protocol !== 'file:') return null;
  return fileURLToPath(value);
}

/**
 * The opener the desktop host uses for every renderer request.
 *
 * @param {{ shell: Pick<import('electron').Shell, 'openPath' | 'openExternal'>, fs?: Parameters<typeof resolveOpenTarget>[1]['fs'], platform?: NodeJS.Platform }} deps
 */
function createOpener({ shell, fs, platform }) {
  /** Opens a local path with its default application, or throws the refusal. */
  async function openPath(rawPath) {
    const target = await resolveOpenTarget(rawPath, { fs, platform });
    if ('refused' in target) throw new Error(target.refused);
    // `shell.openPath` resolves with `''` on success or an error string on failure.
    const failure = await shell.openPath(target.path);
    if (failure) throw new Error(failure);
    return null;
  }

  /** Opens a URL with its default application; one that names a local path is opened as that path. */
  async function openUrl(url) {
    const localPath = localPathOfUrl(url);
    if (localPath !== null) return openPath(localPath);
    await shell.openExternal(url);
    return null;
  }

  return { openPath, openUrl };
}

module.exports = {
  OPEN_REFUSED_RUNS_BY_DEFAULT,
  RUN_BY_DEFAULT_EXTENSIONS,
  createOpener,
  resolveOpenTarget,
};
