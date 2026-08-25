/**
 * Path Safety Module
 * Validates file paths to prevent access to sensitive locations
 */

import { homeDir, tempDir } from '@tauri-apps/api/path';
import { lstat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { isMacOS, isWindows } from '../../utils/platform';
import { createLogger } from '../logging/logger';

const logger = createLogger('pathSafety');

export type PathCheckResult = {
  allowed: boolean;
  /** Exact canonical path approved for the ensuing filesystem operation. */
  resolvedPath?: string;
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

// Workspace paths that user has explicitly authorized, with capability tracking
// Each entry maps a normalized path to its authorized capabilities
type WorkspaceCapability = 'read' | 'write';
interface AuthorizedWorkspaceGrant {
  capabilities: Set<WorkspaceCapability>;
  /** Frozen when the grant is created; authority must not follow a retargeted link. */
  canonicalRoot: Promise<string | null>;
}

const authorizedWorkspaces: Map<string, AuthorizedWorkspaceGrant> = new Map();
const scopedAuthorizedWorkspaces: Map<string, Map<string, AuthorizedWorkspaceGrant>> = new Map();
const authorizationScopePolicies: Map<string, AuthorizationScopePolicy> = new Map();
let authorizationScopeCounter = 0;

export type AuthorizationScopeId = string;
export type AuthorizationScopeShellPolicy = 'strict' | 'full';
export interface AuthorizationScopePolicy {
  /**
   * Shell-only policy metadata attached by the trusted shell owner of a scoped
   * unattended run. ToolExecutionContext deliberately does not carry this.
   */
  shell?: AuthorizationScopeShellPolicy;
}

export function createAuthorizationScope(policy: AuthorizationScopePolicy = {}): AuthorizationScopeId {
  authorizationScopeCounter += 1;
  const scopeId = `auth-scope-${Date.now().toString(36)}-${authorizationScopeCounter.toString(36)}`;
  scopedAuthorizedWorkspaces.set(scopeId, new Map());
  authorizationScopePolicies.set(scopeId, { shell: policy.shell ?? 'strict' });
  return scopeId;
}

export function disposeAuthorizationScope(scopeId: AuthorizationScopeId | undefined): void {
  if (!scopeId) return;
  scopedAuthorizedWorkspaces.delete(scopeId);
  authorizationScopePolicies.delete(scopeId);
}

export function hasFullShellAuthorizationScope(scopeId: AuthorizationScopeId | undefined): boolean {
  if (!scopeId) return false;
  return authorizationScopePolicies.get(scopeId)?.shell === 'full';
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isBlankWorkspaceGrant(path: string): boolean {
  return path.trim().length === 0;
}

function getAuthorizationMap(
  scopeId: AuthorizationScopeId | undefined,
): Map<string, AuthorizedWorkspaceGrant> | undefined {
  if (scopeId === undefined) return authorizedWorkspaces;
  return scopedAuthorizedWorkspaces.get(scopeId);
}

function addAuthorizedWorkspace(
  target: Map<string, AuthorizedWorkspaceGrant>,
  path: string,
  capabilities?: WorkspaceCapability[],
): void {
  if (isBlankWorkspaceGrant(path)) return;
  const normalized = normalizeWorkspacePath(path);
  const caps = capabilities ?? ['read', 'write'];
  const existing = target.get(normalized);
  if (existing) {
    for (const c of caps) existing.capabilities.add(c);
  } else {
    // Start resolution immediately. The promise captures the root at grant
    // time and is reused for the whole scope instead of following later
    // symlink retargets.
    const canonicalRoot = resolvePathForPolicy(normalized)
      .then((resolved) => (resolved.ok ? resolved.canonicalPath : null))
      .catch((error: unknown) => {
        // An unexpected resolver rejection must not poison every future path
        // check that awaits this pinned grant. The lexical fallback retains
        // legacy-host behavior; each requested path is still independently
        // canonicalized (or rejected) before this root can authorize it.
        logger.warn('canonical workspace grant resolution rejected; using lexical root', {
          path: normalized,
          error: error instanceof Error ? error.message : String(error),
        });
        return normalized;
      });
    target.set(normalized, {
      capabilities: new Set(caps),
      canonicalRoot,
    });
  }
}

/**
 * Add a workspace path to the authorized list.
 * @param capabilities - defaults to ['read', 'write'] for backward compatibility (user-selected workspace).
 *   Pass ['read'] for read-only authorization (e.g., read_tools triggers).
 */
export function authorizeWorkspace(
  path: string,
  capabilities?: WorkspaceCapability[],
): void {
  addAuthorizedWorkspace(authorizedWorkspaces, path, capabilities);
}

export function scopedAuthorizeWorkspace(
  scopeId: AuthorizationScopeId,
  path: string,
  capabilities?: WorkspaceCapability[],
): void {
  const target = scopedAuthorizedWorkspaces.get(scopeId);
  if (!target) return;
  addAuthorizedWorkspace(target, path, capabilities);
}

/**
 * Get all paths authorized for write access.
 * Used by commandTools to forward authorized paths to the OS-level sandbox (Seatbelt),
 * so child processes (cp, python, etc.) can write to user-authorized directories.
 */
export function getAuthorizedWritablePaths(scopeId?: AuthorizationScopeId): string[] {
  const target = getAuthorizationMap(scopeId);
  if (!target) return [];
  const paths: string[] = [];
  for (const [workspace, grant] of target) {
    if (isBlankWorkspaceGrant(workspace)) continue;
    if (grant.capabilities.has('write')) paths.push(workspace);
  }
  return paths;
}

/**
 * Get all authorized directory paths (read or write).
 * Used by the working-directory boundary (workingDirs.ts) to decide whether a
 * command operates inside the user's working set.
 */
export function getAuthorizedDirs(scopeId?: AuthorizationScopeId): string[] {
  const target = getAuthorizationMap(scopeId);
  return target ? Array.from(target.keys()).filter((path) => !isBlankWorkspaceGrant(path)) : [];
}

/**
 * Remove a workspace from the authorized list
 */
export function revokeWorkspace(path: string): void {
  const normalized = normalizeWorkspacePath(path);
  authorizedWorkspaces.delete(normalized);
}

/**
 * Check if a path is within an authorized workspace with the required capability
 */
function isInAuthorizedWorkspace(
  path: string,
  capability: 'read' | 'write' = 'read',
  scopeId?: AuthorizationScopeId,
): boolean {
  const target = getAuthorizationMap(scopeId);
  if (!target) return false;
  let normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (isWindows()) normalized = normalized.toLowerCase();
  for (const [workspace, grant] of target) {
    if (isBlankWorkspaceGrant(workspace)) continue;
    const compareWs = isWindows() ? workspace.toLowerCase() : workspace;
    if (normalized === compareWs || normalized.startsWith(compareWs + '/')) {
      if (grant.capabilities.has(capability)) return true;
    }
  }
  return false;
}

export function isInScopedAuthorizedWorkspace(
  path: string,
  capability: 'read' | 'write' = 'read',
  scopeId?: AuthorizationScopeId,
): boolean {
  if (scopeId === undefined) return false;
  // Deliberately lexical-only: this is a conservative early ceiling check,
  // never the final filesystem authorization. A false result can only deny
  // more work; every actual file operation later goes through check*Path(),
  // which pins and revalidates canonical roots before returning resolvedPath.
  return isInAuthorizedWorkspace(normalizePath(path), capability, scopeId);
}

/**
 * Fold a path for the `~/.abu` comparisons below.
 *
 * Two things go wrong without this. (1) `normalizePath` lowercases the whole
 * path on Windows but `getHomeDir()` does not come back lowercased, so a raw
 * `${home}/.abu` prefix never matched there. (2) macOS (APFS/HFS+ default) and
 * Windows are case-INsensitive filesystems: `~/.Abu/mcp/config.json` and
 * `~/.abu/mcp/config.json` are literally the same file, so a case-sensitive
 * prefix test lets the self-protection red line be stepped over by changing
 * one letter. Folded on every platform on purpose — over-matching a
 * differently-cased `~/.ABU` fails closed, under-matching fails open.
 */
function foldPath(path: string): string {
  return normalizeForCompare(path).toLowerCase();
}

/**
 * Check if an absolute path is inside an Abu memory directory.
 * Whitelists ~/.abu/memory/ and ~/.abu/projects/{key}/memory/.
 * This allows file tools (read_file, write_file, edit_file) to operate
 * on memory files without triggering permission dialogs.
 */
async function isAbuMemoryPath(rawPath: string, homeOverride?: string): Promise<boolean> {
  const home = homeOverride ?? await getHomeDir();
  const abuBase = foldPath(`${home}/.abu`);
  const normalizedPath = foldPath(rawPath);

  // ~/.abu/memory/
  if (normalizedPath.startsWith(`${abuBase}/memory/`) || normalizedPath === `${abuBase}/memory`) {
    return true;
  }

  // ~/.abu/projects/*/memory/
  const projectsPrefix = `${abuBase}/projects/`;
  if (normalizedPath.startsWith(projectsPrefix)) {
    const rest = normalizedPath.slice(projectsPrefix.length);
    // rest looks like "<key>/memory/..." or "<key>/memory"
    const slashIdx = rest.indexOf('/');
    if (slashIdx > 0) {
      const afterKey = rest.slice(slashIdx + 1);
      if (afterKey === 'memory' || afterKey.startsWith('memory/')) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Whether a path belongs to Abu's own configuration and state, which the agent
 * must never rewrite (permission plan §4.6 ②: "Abu cannot touch its own
 * config — persona, skill definitions, MCP config, secret store, task
 * definitions, and the permission configuration itself").
 *
 * Why this is a separate guard rather than a `BLOCKED_PATHS` entry: those are
 * enforced for reads as well, and reading is not the threat here (nor is it
 * something to break — the memory tools, the skill loader and the agent's own
 * `~/.abu` writes via save_agent/save_skill all depend on that directory).
 * The threat is a *generic* file write reaching config that a dedicated tool
 * would have had to ask about first: `save_agent` and `manage_mcp_server` go
 * through `classifySelfExtension`'s confirmation, but `write_file` on
 * `~/.abu/agents/x/AGENT.md` bypassed it entirely — and under
 * `permissionMode: 'autonomous'` `checkWritePath`'s final "offer a permission
 * dialog" branch resolves to an automatic allow, so no one is asked at all.
 *
 * Two roots:
 *  - `~/.abu` — skills, agents, MCP configs, task log. `~/.abu/memory` and
 *    `~/.abu/projects/{key}/memory` are carved out: memory is the one part of
 *    this tree the agent is meant to maintain, and the memory tools rely on it.
 *  - The app-data root — Electron `userData` ('Abu' packaged, 'abu-electron-dev'
 *    in dev) plus the legacy `com.abu.*` Tauri identifiers that still carry
 *    migrated state. This is where the persisted settings (including
 *    `browserSitePermissions` and `permissionMode` — the permission
 *    configuration itself), the scheduled task definitions, and the secret
 *    store live.
 */
function isAbuAppDataSegment(segment: string): boolean {
  const name = segment.toLowerCase();
  return name === 'abu' || name.startsWith('abu-') || name.startsWith('com.abu.');
}

async function isAbuSelfManagedPath(normalizedPath: string, homeOverride?: string): Promise<boolean> {
  const home = homeOverride ?? await getHomeDir();
  // Folded, not just normalized: on a case-insensitive filesystem `~/.Abu` IS
  // `~/.abu`, and a case-sensitive prefix test would hand the whole red line
  // away for the price of one capital letter. See `foldPath`.
  const comparePath = foldPath(normalizedPath);

  const abuBase = foldPath(`${home}/.abu`);
  if (comparePath === abuBase || comparePath.startsWith(`${abuBase}/`)) {
    return !(await isAbuMemoryPath(normalizedPath, home));
  }

  const appDataRoot = foldPath(
    isWindows() ? `${home}/AppData/Roaming` : `${home}/Library/Application Support`,
  );
  if (comparePath.startsWith(`${appDataRoot}/`)) {
    const segment = comparePath.slice(appDataRoot.length + 1).split('/')[0];
    return isAbuAppDataSegment(segment);
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
 * Check if a path uses a UNC network or Windows device namespace.
 *
 * Extended drive paths (`\\?\C:\...`) are ordinary local paths with a long-path
 * spelling and remain supported. Every other Win32 namespace spelling is
 * rejected before normalization: stripping `\\?\` from an extended UNC path
 * would otherwise turn it into the misleading local-looking `/UNC/...`.
 */
function isUNCPath(rawPath: string): boolean {
  const p = rawPath.replace(/\\/g, '/');
  if (/^\/\/\?\/[a-zA-Z]:(?:\/|$)/.test(p)) return false;
  if (p.startsWith('//?/') || p.startsWith('//./')) return true;
  if (/^\/\?\?\//.test(p)) return true;
  return p.startsWith('//');
}

/**
 * Check if a path matches any blocked pattern
 */
async function isBlockedPath(path: string, homeOverride?: string): Promise<{ blocked: boolean; reason?: string }> {
  const home = homeOverride ?? await getHomeDir();
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

function isMissingPathError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code === 'ENOENT' || code === 'ENOTDIR') return true;
  return /enoent|enotdir|not found|no such file|cannot find/i.test(String(error));
}

function pathComponentPrefixes(path: string, trustedRoot?: string): string[] {
  const normalized = normalizePath(path);
  const driveMatch = normalized.match(/^([a-zA-Z]:)\/(.*)$/);
  const root = driveMatch ? `${driveMatch[1]}/` : '/';
  const tail = driveMatch ? driveMatch[2] : normalized.replace(/^\//, '');
  const prefixes: string[] = [];
  let cursor = root;
  for (const component of tail.split('/').filter(Boolean)) {
    cursor = cursor === '/' || /^[a-zA-Z]:\/$/.test(cursor)
      ? `${cursor}${component}`
      : `${cursor}/${component}`;
    prefixes.push(cursor);
  }
  if (!trustedRoot) return prefixes;

  const normalizedRoot = normalizePath(trustedRoot);
  const compareRoot = normalizeForCompare(normalizedRoot);
  return prefixes.filter((prefix) => {
    const comparePrefix = normalizeForCompare(prefix);
    return comparePrefix !== compareRoot && comparePrefix.startsWith(`${compareRoot}/`);
  });
}

async function getTrustedSymlinkInspectionRoot(path: string): Promise<string | undefined> {
  if (isWindows()) return undefined;

  const normalizedPath = normalizePath(path);
  const candidates = [
    await getHomeDir(),
    await getRuntimeTempDir(),
    ...ALWAYS_ALLOWED_PATHS,
    '/Volumes',
    '/Applications',
  ]
    .map((candidate) => normalizePath(candidate))
    .sort((a, b) => b.length - a.length);

  return candidates.find((candidate) => {
    const comparePath = normalizeForCompare(normalizedPath);
    const compareCandidate = normalizeForCompare(candidate);
    return comparePath === compareCandidate || comparePath.startsWith(`${compareCandidate}/`);
  });
}

/**
 * Check every existing component, not just the final entry. A lexical path
 * such as `<workspace>/link/secret` escapes the run scope when `link` points
 * elsewhere even though `lstat(secret)` itself reports a regular file.
 */
async function isSymlinkBypass(path: string, followFinalSymlink = true): Promise<boolean> {
  // Electron's plugin-fs host deliberately cannot inspect ancestors above its
  // capability roots (for example `/Users` above `$HOME`). Treat the matched
  // host root as a trusted anchor and inspect every descendant component. The
  // host independently canonicalizes that root, while this layer still catches
  // a symlink that escapes a narrower run/workspace scope inside it.
  const trustedRoot = await getTrustedSymlinkInspectionRoot(path);
  const components = pathComponentPrefixes(path, trustedRoot);
  const inspectedComponents = followFinalSymlink ? components : components.slice(0, -1);
  for (const componentPath of inspectedComponents) {
    try {
      const info = await lstat(componentPath);
      if (info.isSymlink) return true;
    } catch (error) {
      // Once an ancestor is missing, no deeper component can currently be a
      // symlink. Other inspection errors fail closed.
      return !isMissingPathError(error);
    }
  }
  return false;
}

function isPathWithin(candidate: string, root: string): boolean {
  const compareCandidate = normalizeForCompare(candidate);
  const compareRoot = normalizeForCompare(root);
  if (compareRoot === '/') return compareCandidate.startsWith('/');
  return compareCandidate === compareRoot || compareCandidate.startsWith(`${compareRoot}/`);
}

async function getRuntimeTempDir(): Promise<string> {
  try {
    const runtimeTemp = await tempDir();
    if (typeof runtimeTemp === 'string' && runtimeTemp.trim().length > 0) {
      return normalizePath(runtimeTemp);
    }
  } catch {
    // The platform API should normally be available. Keep the legacy fallback
    // deterministic and narrow if an old host cannot expose it.
  }
  if (isWindows()) return normalizePath(`${await getHomeDir()}/AppData/Local/Temp`);
  return '/tmp';
}

async function canonicalizePolicyAnchor(path: string): Promise<string | null> {
  try {
    const canonical = await canonicalizeElectronPathForPolicy(path);
    return normalizePath(canonical ?? path);
  } catch {
    return null;
  }
}

type ResolvedPolicyPath =
  | { ok: true; lexicalPath: string; canonicalPath: string }
  | { ok: false; reason: string };

async function resolvePathForPolicy(
  path: string,
  options: { followFinalSymlink?: boolean } = {},
): Promise<ResolvedPolicyPath> {
  const lexicalPath = normalizePath(path);
  const followFinalSymlink = options.followFinalSymlink !== false;
  try {
    const hostCanonical = await canonicalizeElectronPathForPolicy(path, followFinalSymlink);
    if (hostCanonical !== null) {
      if (isUNCPath(hostCanonical)) {
        return { ok: false, reason: 'UNC network paths are not supported' };
      }
      return {
        ok: true,
        lexicalPath,
        canonicalPath: normalizePath(hostCanonical),
      };
    }
  } catch (error) {
    return {
      ok: false,
      reason: `无法安全解析路径: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Legacy Tauri/Web has no canonicalization bridge. Retain the old
  // fail-closed behavior there; the dynamic temp root keeps macOS /var's own
  // symlink from being mistaken for a user-controlled descendant link.
  if (await isSymlinkBypass(path, followFinalSymlink)) {
    return { ok: false, reason: '检测到无法安全解析的符号链接路径，请使用实际路径。' };
  }
  return { ok: true, lexicalPath, canonicalPath: lexicalPath };
}

interface CanonicalMatch {
  lexical: boolean;
  canonical: boolean;
}

async function matchResolvedRoots(
  lexicalPath: string,
  canonicalPath: string,
  roots: string[],
): Promise<CanonicalMatch> {
  const lexical = roots.some((root) => isPathWithin(lexicalPath, root));
  if (!lexical) return { lexical: false, canonical: false };

  for (const root of roots) {
    const canonicalRoot = await canonicalizePolicyAnchor(root);
    if (canonicalRoot && isPathWithin(canonicalPath, canonicalRoot)) {
      return { lexical: true, canonical: true };
    }
  }
  return { lexical: true, canonical: false };
}

async function matchAuthorizedWorkspaces(
  lexicalPath: string,
  canonicalPath: string,
  capability: 'read' | 'write',
  scopeId?: AuthorizationScopeId,
): Promise<CanonicalMatch> {
  const target = getAuthorizationMap(scopeId);
  if (!target) return { lexical: false, canonical: false };
  let lexical = false;
  let canonical = false;
  for (const [workspace, grant] of target) {
    if (isBlankWorkspaceGrant(workspace) || !grant.capabilities.has(capability)) continue;
    if (isPathWithin(lexicalPath, workspace)) lexical = true;
    const canonicalRoot = await grant.canonicalRoot;
    if (canonicalRoot && isPathWithin(canonicalPath, canonicalRoot)) {
      canonical = true;
    }
    if (lexical && canonical) break;
  }
  return { lexical, canonical };
}

function isAuthorizedWorkspaceMatch(match: CanonicalMatch, scopeId?: AuthorizationScopeId): boolean {
  // A foreground user may explicitly approve the real destination revealed by
  // a canonical-escape prompt. Scoped/unattended runs have no prompt and must
  // still remain lexically inside their per-run allowlist.
  return match.canonical && (scopeId === undefined || match.lexical);
}

async function getImplicitRoots(): Promise<string[]> {
  const roots = [...ALWAYS_ALLOWED_PATHS, await getRuntimeTempDir()];
  if (isWindows()) roots.push(`${await getHomeDir()}/AppData/Local/Temp`);
  return [...new Set(roots.map((root) => normalizePath(root)))];
}

function getWriteBlockedRoot(path: string): string | null {
  const writeBlocked = isWindows()
    ? [...SYSTEM_PATHS_WRITE_BLOCKED, ...WIN_SYSTEM_PATHS_WRITE_BLOCKED]
    : SYSTEM_PATHS_WRITE_BLOCKED;
  return writeBlocked.find((root) => isPathWithin(path, root)) ?? null;
}

function canonicalScopeEscapeResult(): PathCheckResult {
  return { allowed: false, reason: '符号链接目标超出本次运行已授权的路径范围' };
}

async function isTrustedMacRuntimeTempWrite(
  runtimeTemp: string,
  lexicalPath: string,
  canonicalPath: string,
): Promise<boolean> {
  if (!isMacOS()) return false;

  const lexicalRoot = normalizePath(runtimeTemp);
  if (!/^\/var\/folders\/[^/]+\/[^/]+\/T$/.test(lexicalRoot)) return false;

  try {
    const canonicalRootRaw = await canonicalizeElectronPathForPolicy(lexicalRoot);
    if (canonicalRootRaw === null) return false;
    const canonicalRoot = normalizePath(canonicalRootRaw);
    if (!/^\/private\/var\/folders\/[^/]+\/[^/]+\/T$/.test(canonicalRoot)) return false;
    return isPathWithin(lexicalPath, lexicalRoot) && isPathWithin(canonicalPath, canonicalRoot);
  } catch {
    return false;
  }
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
 * Check whether a path is a catastrophic delete target: the POSIX filesystem root
 * ('/'), a Windows drive root (e.g. 'C:\' / 'C:/'), or the user's home directory
 * itself (with or without a trailing slash).
 *
 * `checkWritePath` alone does NOT hard-block these — it returns
 * `needsPermission: true`, which resolves to an automatic ALLOW under
 * `permissionMode === 'autonomous'`. The old `rm`-based delete path was hard-blocked
 * for exactly these targets by `commandSafety`'s `blockRmRoot`/`blockRmHome` patterns,
 * enforced in ALL permission modes. This helper restores that parity for the
 * `delete_file` tool, which routes through `move_to_trash` instead of `rm` and so
 * never passes through `commandSafety` at all.
 */
export async function isCatastrophicDeleteTarget(path: string): Promise<boolean> {
  // UNC paths are rejected separately by checkWritePath's isUNCPath check; they are
  // never a root/home target.
  if (isUNCPath(path)) return false;

  const normalizedPath = normalizePath(path);

  // POSIX filesystem root — normalizePath collapses '/' (and '//', '/.', etc.) to '/'.
  if (normalizedPath === '/') return true;

  // Windows drive root — normalizePath extracts the drive letter into a prefix and
  // resolves the remainder to '/' when no subpath follows (e.g. 'C:\' / 'C:/' → 'C:/',
  // lowercased to 'c:/' on Windows for case-insensitive comparison).
  if (/^[a-zA-Z]:\/$/.test(normalizedPath)) return true;

  // The home directory itself.
  const home = await getHomeDir();
  if (normalizedPath === normalizeForCompare(home)) return true;

  return false;
}

/**
 * Check if a path is safe for reading
 */
export async function checkReadPath(path: string, scopeId?: AuthorizationScopeId): Promise<PathCheckResult> {
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

  const resolved = await resolvePathForPolicy(path);
  if (!resolved.ok) return { allowed: false, reason: resolved.reason };

  const home = await getHomeDir();
  const canonicalHome = await canonicalizePolicyAnchor(home);
  if (!canonicalHome) return { allowed: false, reason: '无法安全解析用户目录' };

  const canonicalBlock = await isBlockedPath(resolved.canonicalPath, canonicalHome);
  if (canonicalBlock.blocked) {
    return { allowed: false, reason: canonicalBlock.reason };
  }

  // A lexical grant is only valid when the resolved target is also contained
  // by a canonicalized grant in the same authorization map. This permits a
  // top-level iCloud/external-volume alias while rejecting a nested escape.
  const workspaceMatch = await matchAuthorizedWorkspaces(
    resolved.lexicalPath,
    resolved.canonicalPath,
    'read',
    scopeId,
  );
  if (isAuthorizedWorkspaceMatch(workspaceMatch, scopeId)) {
    return { allowed: true, resolvedPath: resolved.canonicalPath };
  }
  if (scopeId !== undefined && workspaceMatch.lexical) return canonicalScopeEscapeResult();

  // Check Abu memory directories (~/.abu/memory/, ~/.abu/projects/*/memory/)
  const lexicalMemory = await isAbuMemoryPath(resolved.lexicalPath, home);
  const canonicalMemory = await isAbuMemoryPath(resolved.canonicalPath, canonicalHome);
  if (lexicalMemory && canonicalMemory) {
    return { allowed: true, resolvedPath: resolved.canonicalPath };
  }
  if (scopeId !== undefined && lexicalMemory) return canonicalScopeEscapeResult();

  const implicitMatch = await matchResolvedRoots(
    resolved.lexicalPath,
    resolved.canonicalPath,
    await getImplicitRoots(),
  );
  if (implicitMatch.lexical && implicitMatch.canonical) {
    return { allowed: true, resolvedPath: resolved.canonicalPath };
  }
  if (scopeId !== undefined && implicitMatch.lexical) return canonicalScopeEscapeResult();

  // A foreground grant whose nested link resolves outside its canonical roots
  // may request the real destination. Scoped runs never reach this branch.
  if (scopeId === undefined && (workspaceMatch.lexical || lexicalMemory || implicitMatch.lexical)) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: resolved.canonicalPath,
      capability: 'read',
    };
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
export async function checkWritePath(
  path: string,
  scopeId?: AuthorizationScopeId,
  options: { followFinalSymlink?: boolean } = {},
): Promise<PathCheckResult> {
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

  // Abu's own config and state — checked before the authorized-workspace
  // shortcut on purpose: authorizing a parent directory (or the home dir)
  // must not hand the agent write access to its own permission config,
  // secret store, or task definitions.
  if (await isAbuSelfManagedPath(normalizedPath)) {
    return { allowed: false, reason: '禁止写入阿布自身的配置与状态目录' };
  }

  const resolved = await resolvePathForPolicy(path, options);
  if (!resolved.ok) return { allowed: false, reason: resolved.reason };

  const home = await getHomeDir();
  const canonicalHome = await canonicalizePolicyAnchor(home);
  if (!canonicalHome) return { allowed: false, reason: '无法安全解析用户目录' };

  const canonicalBlock = await isBlockedPath(resolved.canonicalPath, canonicalHome);
  if (canonicalBlock.blocked) {
    return { allowed: false, reason: canonicalBlock.reason };
  }
  if (await isAbuSelfManagedPath(resolved.canonicalPath, canonicalHome)) {
    return { allowed: false, reason: '禁止写入阿布自身的配置与状态目录' };
  }

  const runtimeTemp = await getRuntimeTempDir();
  const safeRuntimeTemp = await isTrustedMacRuntimeTempWrite(
    runtimeTemp,
    resolved.lexicalPath,
    resolved.canonicalPath,
  );

  // `/var/folders/.../T` is the OS-provided macOS temp root and canonicalizes
  // to `/private/var/...`; only that exact double-contained root is exempt from
  // the broad `/var` write red line. `/var/tmp` remains blocked.
  if (!safeRuntimeTemp) {
    const writeBlockedRoot = getWriteBlockedRoot(resolved.lexicalPath)
      ?? getWriteBlockedRoot(resolved.canonicalPath);
    if (writeBlockedRoot) {
      return { allowed: false, reason: `禁止写入系统目录: ${writeBlockedRoot}` };
    }
  }

  const workspaceMatch = await matchAuthorizedWorkspaces(
    resolved.lexicalPath,
    resolved.canonicalPath,
    'write',
    scopeId,
  );
  if (isAuthorizedWorkspaceMatch(workspaceMatch, scopeId)) {
    return { allowed: true, resolvedPath: resolved.canonicalPath };
  }
  if (scopeId !== undefined && workspaceMatch.lexical) return canonicalScopeEscapeResult();

  // Check Abu memory directories (~/.abu/memory/, ~/.abu/projects/*/memory/)
  const lexicalMemory = await isAbuMemoryPath(resolved.lexicalPath, home);
  const canonicalMemory = await isAbuMemoryPath(resolved.canonicalPath, canonicalHome);
  if (lexicalMemory && canonicalMemory) {
    return { allowed: true, resolvedPath: resolved.canonicalPath };
  }
  if (scopeId !== undefined && lexicalMemory) return canonicalScopeEscapeResult();

  const implicitMatch = await matchResolvedRoots(
    resolved.lexicalPath,
    resolved.canonicalPath,
    await getImplicitRoots(),
  );
  if (implicitMatch.lexical && implicitMatch.canonical) {
    return { allowed: true, resolvedPath: resolved.canonicalPath };
  }
  if (scopeId !== undefined && implicitMatch.lexical) return canonicalScopeEscapeResult();

  if (scopeId === undefined && (workspaceMatch.lexical || lexicalMemory || implicitMatch.lexical)) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: resolved.canonicalPath,
      capability: 'write',
    };
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
export async function checkListPath(path: string, scopeId?: AuthorizationScopeId): Promise<PathCheckResult> {
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

  const resolved = await resolvePathForPolicy(path);
  if (!resolved.ok) return { allowed: false, reason: resolved.reason };

  const home = await getHomeDir();
  const canonicalHome = await canonicalizePolicyAnchor(home);
  if (!canonicalHome) return { allowed: false, reason: '无法安全解析用户目录' };

  const canonicalBlock = await isBlockedPath(resolved.canonicalPath, canonicalHome);
  if (canonicalBlock.blocked) {
    return { allowed: false, reason: canonicalBlock.reason };
  }

  const workspaceMatch = await matchAuthorizedWorkspaces(
    resolved.lexicalPath,
    resolved.canonicalPath,
    'read',
    scopeId,
  );
  if (isAuthorizedWorkspaceMatch(workspaceMatch, scopeId)) {
    return { allowed: true, resolvedPath: resolved.canonicalPath };
  }
  if (scopeId !== undefined && workspaceMatch.lexical) return canonicalScopeEscapeResult();

  const implicitMatch = await matchResolvedRoots(
    resolved.lexicalPath,
    resolved.canonicalPath,
    await getImplicitRoots(),
  );
  if (implicitMatch.lexical && implicitMatch.canonical) {
    return { allowed: true, resolvedPath: resolved.canonicalPath };
  }
  if (scopeId !== undefined && implicitMatch.lexical) return canonicalScopeEscapeResult();

  if (scopeId === undefined && (workspaceMatch.lexical || implicitMatch.lexical)) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: resolved.canonicalPath,
      capability: 'read',
    };
  }

  // For listing under home, require permission (but still block system-ish paths)
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
