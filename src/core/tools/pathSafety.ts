/**
 * Path Safety Module
 * Validates file paths to prevent access to sensitive locations
 */

import { homeDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { isWindows } from '../../utils/platform';

export type PathCheckResult = {
  allowed: boolean;
  needsPermission?: boolean;
  permissionPath?: string;    // Top-level directory that needs authorization
  capability?: 'read' | 'write';
  reason?: string;
};

// Cache home directory
let cachedHomeDir: string | null = null;

async function getHomeDir(): Promise<string> {
  if (!cachedHomeDir) {
    cachedHomeDir = await homeDir();
  }
  return cachedHomeDir;
}

/**
 * Sensitive paths that should NEVER be accessed (relative to home or absolute)
 */
const BLOCKED_PATHS = [
  // SSH keys and config
  '.ssh',
  // Cloud credentials
  '.aws',
  '.config/gcloud',
  '.azure',
  '.kube',
  // API keys and tokens
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.docker/config.json',
  // Shell configs (can be used for injection)
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.zshenv',
  // Git credentials
  '.git-credentials',
  '.gitconfig',
  // Application sensitive data
  '.gnupg',
  '.password-store',
  'Library/Keychains',
  'Library/Application Support/Google/Chrome/Default/Login Data',
  'Library/Application Support/Firefox/Profiles',
  // Environment files that may contain secrets
  '.env',
  '.env.local',
  '.env.production',
];

/**
 * System paths that should NEVER be written to
 */
const SYSTEM_PATHS_WRITE_BLOCKED = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/var',
  '/private/etc',
  '/private/var',
];

/**
 * System paths that should NEVER be read (contains sensitive system info)
 */
const SYSTEM_PATHS_READ_BLOCKED = [
  '/etc/shadow',
  '/etc/master.passwd',
  '/private/etc/shadow',
  '/private/etc/master.passwd',
];

const WIN_SYSTEM_PATHS_READ_BLOCKED = [
  'C:/Windows/System32/config/SAM',
  'C:/Windows/System32/config/SECURITY',
  'C:/Windows/System32/config/SYSTEM',
  'C:/Windows/System32/config/SOFTWARE',
  'C:/Windows/NTDS',
  'C:/Windows/repair',
  'C:/Windows/System32/drivers/etc/hosts',
];

/**
 * Allowed paths for file operations (relative to home)
 */
// Home directories that are sensitive even though not in BLOCKED_PATHS
// These should be hard-blocked, not offered via permission dialog
const SENSITIVE_HOME_DIRS_MAC = ['Library', '.Trash'];
const SENSITIVE_HOME_DIRS_WIN = ['AppData', '$Recycle.Bin'];

const ALLOWED_HOME_PATHS = [
  'Desktop',
  'Documents',
  'Downloads',
  'Pictures',
  'Music',
  'Movies',
  'Projects',
  'Development',
  'dev',
  'src',
  'code',
  'workspace',
  'work',
];

// ── Windows-specific paths (only used when isWindows() is true) ──

const WIN_BLOCKED_PATHS = [
  // Windows credential stores
  'AppData/Local/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Credentials',
  'AppData/Roaming/Microsoft/Protect',
  'AppData/Local/Microsoft/Vault',
  'AppData/Roaming/Microsoft/Vault',
  // PowerShell profiles (can be used for injection)
  'Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1',
  'Documents/PowerShell/Microsoft.PowerShell_profile.ps1',
  // Browser credentials
  'AppData/Local/Google/Chrome/User Data/Default/Login Data',
  'AppData/Local/Google/Chrome/User Data/Default/Cookies',
  'AppData/Local/Microsoft/Edge/User Data/Default/Login Data',
  'AppData/Roaming/Mozilla/Firefox/Profiles',
  // Standard dotfile secrets
  '.ssh',
  '.aws',
  '.azure',
  '.kube',
  '.gnupg',
  '.password-store',
  '.npmrc',
  '.netrc',
  '_netrc',
  '.pypirc',
  '.docker/config.json',
  '.git-credentials',
  '.gitconfig',
  '.env',
  '.env.local',
  '.env.production',
];

const WIN_SYSTEM_PATHS_WRITE_BLOCKED = [
  'C:/Windows',
  'C:/Windows/System32',
  'C:/Program Files',
  'C:/Program Files (x86)',
  'C:/ProgramData/Microsoft',
  'C:/Recovery',
  'C:/Boot',
];

/**
 * Always allowed paths
 */
const ALWAYS_ALLOWED_PATHS = [
  '/tmp',
  '/var/tmp',
  '/private/tmp',
  '/Applications',  // Allow reading app bundles (needed for computer use / open -a)
];

// Workspace paths that user has explicitly authorized
const authorizedWorkspaces: Set<string> = new Set();

/**
 * Add a workspace path to the authorized list
 */
export function authorizeWorkspace(path: string): void {
  // Normalize path (backslashes → forward slashes, remove trailing slash)
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  authorizedWorkspaces.add(normalized);
}

/**
 * Remove a workspace from the authorized list
 */
export function revokeWorkspace(path: string): void {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  authorizedWorkspaces.delete(normalized);
}

/**
 * Check if a path is within an authorized workspace
 */
function isInAuthorizedWorkspace(path: string): boolean {
  let normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (isWindows()) normalized = normalized.toLowerCase();
  for (const workspace of authorizedWorkspaces) {
    const compareWs = isWindows() ? workspace.toLowerCase() : workspace;
    if (normalized === compareWs || normalized.startsWith(compareWs + '/')) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize and resolve a path for security checking.
 * Handles both Unix and Windows paths:
 * - Strips Windows extended-length path prefix (\\?\)
 * - Converts backslashes to forward slashes (no-op on macOS)
 * - Extracts Windows drive letter prefix (e.g. C:)
 * - Resolves . and .. segments
 */
function normalizePath(path: string): string {
  // Strip Windows extended-length path prefix (\\?\C:\... or //?/C:/...)
  let normalized = path.replace(/^(\\\\\?\\|\/\/\?\/)/, '');
  // Normalize backslashes to forward slashes (no-op on macOS — no backslashes in paths)
  normalized = normalized.replace(/\\/g, '/');
  // Extract Windows drive letter prefix (e.g. "C:/foo" → prefix="C:", normalized="/foo")
  let prefix = '';
  const driveMatch = normalized.match(/^([a-zA-Z]):\//);
  if (driveMatch) {
    prefix = driveMatch[1].toUpperCase() + ':';
    normalized = normalized.substring(2); // Remove "C:" part, keep "/foo"
  }
  // Remove redundant slashes
  normalized = normalized.replace(/\/+/g, '/');
  // Remove trailing slash
  normalized = normalized.replace(/\/+$/, '');
  // Resolve . and ..
  const parts = normalized.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '.' && part !== '') {
      resolved.push(part);
    }
  }
  let result = prefix + '/' + resolved.join('/');
  // Windows: normalize to lowercase for case-insensitive NTFS matching
  if (isWindows()) {
    result = result.toLowerCase();
  }
  return result;
}

/**
 * Normalize a path for comparison purposes.
 * Case normalization for Windows is already handled in normalizePath().
 */
function normalizeForCompare(path: string): string {
  return normalizePath(path);
}

/**
 * Check if a normalized path is a UNC network path (\\server\share or //server/share).
 * These are blocked to prevent network path traversal.
 */
function isUNCPath(rawPath: string): boolean {
  // Check original path for UNC patterns before normalization strips them
  const p = rawPath.replace(/\\/g, '/');
  return p.startsWith('//') && !p.startsWith('//?/');
}

/**
 * Check if a path matches any blocked pattern
 */
async function isBlockedPath(path: string): Promise<{ blocked: boolean; reason?: string }> {
  const home = await getHomeDir();
  const comparePath = normalizeForCompare(path);

  // Check absolute blocked paths for read
  const readBlocked = isWindows()
    ? [...SYSTEM_PATHS_READ_BLOCKED, ...WIN_SYSTEM_PATHS_READ_BLOCKED]
    : SYSTEM_PATHS_READ_BLOCKED;
  for (const blockedPath of readBlocked) {
    const compareBlocked = normalizeForCompare(blockedPath);
    if (comparePath === compareBlocked || comparePath.startsWith(compareBlocked + '/')) {
      return { blocked: true, reason: `访问系统敏感文件被禁止: ${blockedPath}` };
    }
  }

  // Select blocked list based on platform
  const blockedPaths = isWindows() ? WIN_BLOCKED_PATHS : BLOCKED_PATHS;

  // Check home-relative blocked paths
  for (const blockedPath of blockedPaths) {
    const fullBlockedPath = normalizeForCompare(`${home}/${blockedPath}`);
    if (comparePath === fullBlockedPath || comparePath.startsWith(fullBlockedPath + '/')) {
      return { blocked: true, reason: `访问敏感配置文件被禁止: ~/${blockedPath}` };
    }
    // Also check if path ends with blocked filename (e.g., any .env file)
    if (blockedPath.startsWith('.') && !blockedPath.includes('/')) {
      const filename = comparePath.split('/').pop();
      const compareBlockedName = isWindows() ? blockedPath.toLowerCase() : blockedPath;
      if (filename === compareBlockedName) {
        return { blocked: true, reason: `访问敏感文件被禁止: ${blockedPath}` };
      }
    }
  }

  return { blocked: false };
}

/**
 * Check if any component of a path is a symlink that could bypass security checks.
 * Returns true if a symlink is detected pointing outside expected boundaries.
 */
async function isSymlinkBypass(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (info.isSymlink) {
      return true;
    }
  } catch {
    // File doesn't exist yet (write) or can't be stat'd — not a symlink bypass
  }
  return false;
}

/**
 * Extract the top-level directory for permission granting.
 * e.g., ~/Desktop/foo/bar → ~/Desktop
 *        ~/Projects/my-app/src → ~/Projects
 *        /tmp/foo → /tmp
 */
export function getPermissionDirectory(path: string, home: string): string {
  const normalizedPath = normalizePath(path);
  const normalizedHome = normalizePath(home);

  // If under home directory, extract the first subdirectory
  if (normalizedPath.startsWith(normalizedHome + '/')) {
    const relative = normalizedPath.substring(normalizedHome.length + 1);
    const firstDir = relative.split('/')[0];
    return `${normalizedHome}/${firstDir}`;
  }

  // If it IS the home directory, return it
  if (normalizedPath === normalizedHome) {
    return normalizedHome;
  }

  // For non-home paths, return the path itself
  return normalizedPath;
}

/**
 * Check if a path is in an ALLOWED_HOME_PATHS location (needs permission but not blocked)
 */
async function isInHomeAllowedLocation(path: string): Promise<string | null> {
  const home = await getHomeDir();
  const normalizedPath = normalizePath(path);

  // Check allowed home subdirectories
  for (const allowedDir of ALLOWED_HOME_PATHS) {
    const fullAllowedPath = normalizePath(`${home}/${allowedDir}`);
    if (normalizedPath === fullAllowedPath || normalizedPath.startsWith(fullAllowedPath + '/')) {
      return getPermissionDirectory(normalizedPath, home);
    }
  }

  // Home directory itself (for listing)
  if (normalizedPath === normalizePath(home)) {
    return normalizedPath;
  }

  return null;
}

/**
 * For paths under home that aren't in ALLOWED_HOME_PATHS,
 * determine if they can be authorized via permission dialog.
 * Returns permissionPath (top-level dir) if dialog-eligible, null if should be hard-blocked.
 */
async function canRequestPermission(normalizedPath: string): Promise<string | null> {
  const home = await getHomeDir();
  const normalizedHome = normalizePath(home);

  // Only allow permission dialogs for paths under home directory
  if (!normalizedPath.startsWith(normalizedHome + '/')) {
    return null;
  }

  const relative = normalizedPath.substring(normalizedHome.length + 1);
  const firstDir = relative.split('/')[0];

  // Block hidden directories (dot-dirs like .config, .local, .cache)
  if (firstDir.startsWith('.')) {
    return null;
  }

  // Block platform-sensitive directories
  const sensitiveDirs = isWindows() ? SENSITIVE_HOME_DIRS_WIN : SENSITIVE_HOME_DIRS_MAC;
  if (sensitiveDirs.includes(firstDir)) {
    return null;
  }

  return `${normalizedHome}/${firstDir}`;
}

/**
 * Check if a path is safe for reading
 */
export async function checkReadPath(path: string): Promise<PathCheckResult> {
  // Block UNC network paths
  if (isUNCPath(path)) {
    return { allowed: false, reason: 'UNC network paths are not supported' };
  }

  const normalizedPath = normalizePath(path);

  // Check blocked paths first
  const blockCheck = await isBlockedPath(normalizedPath);
  if (blockCheck.blocked) {
    return { allowed: false, reason: blockCheck.reason };
  }

  // Check for symlink bypass — symlinks could point to blocked paths
  if (await isSymlinkBypass(path)) {
    return { allowed: false, reason: '检测到符号链接，出于安全原因拒绝访问。请使用实际路径。' };
  }

  // Check if in authorized workspace (already granted permission)
  if (isInAuthorizedWorkspace(normalizedPath)) {
    return { allowed: true };
  }

  // Check always allowed paths (/tmp etc.)
  for (const allowedPath of ALWAYS_ALLOWED_PATHS) {
    if (normalizedPath.startsWith(allowedPath)) {
      return { allowed: true };
    }
  }

  // Windows temp directory whitelist
  if (isWindows()) {
    const home = await getHomeDir();
    const tempPath = normalizePath(`${home}/AppData/Local/Temp`);
    if (normalizedPath.startsWith(tempPath)) {
      return { allowed: true };
    }
  }

  // Check if in home allowed locations — these need permission
  const permDir = await isInHomeAllowedLocation(normalizedPath);
  if (permDir) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: permDir,
      capability: 'read',
    };
  }

  // For other home subdirectories (not in ALLOWED_HOME_PATHS), check if permission dialog is appropriate
  const fallbackPermDir = await canRequestPermission(normalizedPath);
  if (fallbackPermDir) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: fallbackPermDir,
      capability: 'read',
    };
  }

  // Path passed all security checks but isn't pre-authorized — offer permission dialog
  return {
    allowed: false,
    needsPermission: true,
    permissionPath: normalizedPath,
    capability: 'read',
  };
}

/**
 * Check if a path is safe for writing
 */
export async function checkWritePath(path: string): Promise<PathCheckResult> {
  // Block UNC network paths
  if (isUNCPath(path)) {
    return { allowed: false, reason: 'UNC network paths are not supported' };
  }

  const normalizedPath = normalizePath(path);

  // Check blocked paths first
  const blockCheck = await isBlockedPath(normalizedPath);
  if (blockCheck.blocked) {
    return { allowed: false, reason: blockCheck.reason };
  }

  // Check for symlink bypass — symlinks could point to blocked paths
  if (await isSymlinkBypass(path)) {
    return { allowed: false, reason: '检测到符号链接，出于安全原因拒绝写入。请使用实际路径。' };
  }

  // Check system paths (extra strict for write)
  const writeBlocked = isWindows()
    ? [...SYSTEM_PATHS_WRITE_BLOCKED, ...WIN_SYSTEM_PATHS_WRITE_BLOCKED]
    : SYSTEM_PATHS_WRITE_BLOCKED;
  const comparePath = normalizeForCompare(path);
  for (const sysPath of writeBlocked) {
    const compareSys = normalizeForCompare(sysPath);
    if (comparePath.startsWith(compareSys)) {
      return { allowed: false, reason: `禁止写入系统目录: ${sysPath}` };
    }
  }

  // Check if in authorized workspace (already granted permission)
  if (isInAuthorizedWorkspace(normalizedPath)) {
    return { allowed: true };
  }

  // Check always allowed paths (/tmp etc.)
  for (const allowedPath of ALWAYS_ALLOWED_PATHS) {
    if (normalizedPath.startsWith(allowedPath)) {
      return { allowed: true };
    }
  }

  // Windows temp directory whitelist
  if (isWindows()) {
    const home = await getHomeDir();
    const tempPath = normalizePath(`${home}/AppData/Local/Temp`);
    if (normalizedPath.startsWith(tempPath)) {
      return { allowed: true };
    }
  }

  // Check if in home allowed locations — these need permission
  const permDir = await isInHomeAllowedLocation(normalizedPath);
  if (permDir) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: permDir,
      capability: 'write',
    };
  }

  // For other home subdirectories (not in ALLOWED_HOME_PATHS), check if permission dialog is appropriate
  const fallbackPermDir = await canRequestPermission(normalizedPath);
  if (fallbackPermDir) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: fallbackPermDir,
      capability: 'write',
    };
  }

  // Path passed all security checks but isn't pre-authorized — offer permission dialog
  return {
    allowed: false,
    needsPermission: true,
    permissionPath: normalizedPath,
    capability: 'write',
  };
}

/**
 * Check if a path is safe for listing (more permissive than read/write)
 */
export async function checkListPath(path: string): Promise<PathCheckResult> {
  // Block UNC network paths
  if (isUNCPath(path)) {
    return { allowed: false, reason: 'UNC network paths are not supported' };
  }

  const normalizedPath = normalizePath(path);

  // Block sensitive directories from listing too
  const blockCheck = await isBlockedPath(normalizedPath);
  if (blockCheck.blocked) {
    return { allowed: false, reason: blockCheck.reason };
  }

  // Check if in authorized workspace
  if (isInAuthorizedWorkspace(normalizedPath)) {
    return { allowed: true };
  }

  // Check always allowed paths
  for (const allowedPath of ALWAYS_ALLOWED_PATHS) {
    if (normalizedPath.startsWith(allowedPath)) {
      return { allowed: true };
    }
  }

  // Windows temp directory whitelist
  if (isWindows()) {
    const homeTmp = await getHomeDir();
    const tempPath = normalizePath(`${homeTmp}/AppData/Local/Temp`);
    if (normalizedPath.startsWith(tempPath)) {
      return { allowed: true };
    }
  }

  // For listing under home, require permission (but still block system-ish paths)
  const home = await getHomeDir();
  const normalizedHome = normalizePath(home);
  if (normalizedPath.startsWith(normalizedHome)) {
    // Block system-ish paths under home
    const blockedHomePaths = isWindows()
      ? ['$Recycle.Bin', 'AppData']
      : ['.Trash', 'Library'];
    for (const blocked of blockedHomePaths) {
      const fullBlocked = normalizePath(`${home}/${blocked}`);
      if (normalizedPath.startsWith(fullBlocked)) {
        return { allowed: false, reason: `禁止列出目录: ~/${blocked}` };
      }
    }

    // Home directory itself — need permission
    const permDir = getPermissionDirectory(normalizedPath, normalizedHome);
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: permDir,
      capability: 'read',
    };
  }

  // For non-home paths, check if permission dialog is appropriate (will return null → hard block)
  const fallbackPermDir2 = await canRequestPermission(normalizedPath);
  if (fallbackPermDir2) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: fallbackPermDir2,
      capability: 'read',
    };
  }

  // Path passed all security checks but isn't pre-authorized — offer permission dialog
  return {
    allowed: false,
    needsPermission: true,
    permissionPath: normalizedPath,
    capability: 'read',
  };
}
