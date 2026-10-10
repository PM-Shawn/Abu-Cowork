import { getBaseName } from '@/utils/pathUtils';

/**
 * Extensions whose default handling by the operating system starts the file, installs it,
 * or mounts it, on macOS, Windows or a Linux desktop. Lower case.
 */
export const RUN_BY_DEFAULT_EXTENSIONS: ReadonlySet<string> = new Set([
  // macOS: bundles and files Terminal runs
  'app', 'command', 'tool', 'terminal',
  // macOS: Automator and AppleScript
  'workflow', 'action', 'scpt', 'scptd', 'applescript',
  // macOS: location files, installers, disk images
  'fileloc', 'inetloc', 'prefpane', 'pkg', 'mpkg', 'dmg',
  // Windows: programs and command scripts
  'exe', 'com', 'scr', 'pif', 'bat', 'cmd',
  // Windows: Script Host and HTML applications
  'vbs', 'vbe', 'jse', 'wsf', 'wsh', 'hta',
  // Windows: installers and app packages
  'msi', 'msp', 'msu', 'msix', 'msixbundle', 'appx', 'appxbundle', 'appinstaller', 'application', 'appref-ms', 'gadget',
  // Windows: shortcuts, shell and system files
  'lnk', 'url', 'scf', 'reg', 'cpl', 'msc', 'chm', 'hlp', 'diagcab', 'settingcontent-ms',
  // Windows: disk images
  'iso', 'img', 'vhd', 'vhdx',
  // Java
  'jar', 'jnlp',
  // Linux desktops
  'appimage', 'desktop', 'run', 'deb', 'rpm',
]);

/**
 * Whether the operating system's default handling of this file is to run it.
 *
 * The name is read the way the system reads it: Windows drops trailing dots and spaces, and
 * the last extension decides. A name with no extension counts, since an executable file needs
 * none and its name tells nothing about it.
 */
export function isRunByDefault(filePath: string): boolean {
  const name = getBaseName(filePath).replace(/[. ]+$/, '');
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return true;
  return RUN_BY_DEFAULT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
