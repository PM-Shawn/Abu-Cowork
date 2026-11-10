/**
 * Path Safety Module
 * Validates file paths to prevent access to sensitive locations
 */

import { appDataDir, homeDir, tempDir } from '@tauri-apps/api/path';
import { createConversationPaths } from '../session/conversationPaths';
import { lstat, readFile, stat } from '@tauri-apps/plugin-fs';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { isMissingPathError } from '../../utils/fsErrors';
import { normalizeLexicalPath, normalizeSeparators } from '../../utils/pathUtils';
import { isMacOS, isWindows } from '../../utils/platform';
import { createLogger } from '../logging/logger';

const logger = createLogger('pathSafety');

export type PathCheckResult = {
  allowed: boolean;
  /** Exact canonical path approved for the ensuing filesystem operation. */
  resolvedPath?: string;
  needsPermission?: boolean;
  permissionPath?: string;    // Top-level directory that needs authorization
  /** permissionPath 是整块授权的顶层文件夹（如 ~/Documents），不是请求的路径本身 */
  permissionIsFolder?: boolean;
  capability?: 'read' | 'write';
  reason?: string;
  /** A definite local restriction, distinct from an unverifiable path. */
  denialKind?: 'blocked';
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
 * The data folders of the browsers people use on macOS, relative to home.
 * Each holds every profile's cookies, saved passwords and site storage.
 */
const BROWSER_DATA_PATHS_MAC = [
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Google/Chrome Beta',
  'Library/Application Support/Google/Chrome Canary',
  'Library/Application Support/Google/Chrome Dev',
  'Library/Application Support/Chromium',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Microsoft Edge Beta',
  'Library/Application Support/Microsoft Edge Dev',
  'Library/Application Support/Microsoft Edge Canary',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Firefox',
  'Library/Application Support/Arc',
  'Library/Application Support/Vivaldi',
  'Library/Application Support/com.operasoftware.Opera',
  'Library/Safari',
  'Library/Cookies',
  'Library/Containers/com.apple.Safari',
];

/** The same folders on Windows, relative to the user profile. */
const BROWSER_DATA_PATHS_WIN = [
  'AppData/Local/Google/Chrome/User Data',
  'AppData/Local/Google/Chrome Beta/User Data',
  'AppData/Local/Google/Chrome SxS/User Data',
  'AppData/Local/Google/Chrome Dev/User Data',
  'AppData/Local/Chromium/User Data',
  'AppData/Local/Microsoft/Edge/User Data',
  'AppData/Local/Microsoft/Edge Beta/User Data',
  'AppData/Local/Microsoft/Edge Dev/User Data',
  'AppData/Local/Microsoft/Edge SxS/User Data',
  'AppData/Local/BraveSoftware/Brave-Browser/User Data',
  'AppData/Roaming/Mozilla/Firefox',
  'AppData/Roaming/Opera Software',
  'AppData/Local/Vivaldi/User Data',
  // Browsers common in China, each a Chromium build with its own data folder.
  'AppData/Local/360Chrome/Chrome/User Data',
  'AppData/Roaming/360se6/User Data',
  'AppData/Local/Tencent/QQBrowser/User Data',
  'AppData/Roaming/SogouExplorer',
  'AppData/Local/2345Explorer/User Data',
  'AppData/Local/liebao/User Data',
  'AppData/Local/CentBrowser/User Data',
];

const PASSWORD_MANAGER_PATHS_MAC = [
  'Library/Application Support/1Password',
  'Library/Group Containers/2BUA8C4S2C.com.1password',
  'Library/Application Support/Bitwarden',
  'Library/Application Support/KeePassXC',
];

const PASSWORD_MANAGER_PATHS_WIN = [
  'AppData/Local/1Password',
  'AppData/Roaming/Bitwarden',
  'AppData/Roaming/KeePass',
  'AppData/Roaming/KeePassXC',
];

/**
 * Where command-line tools keep their access keys and tokens, on both systems:
 * cloud CLIs, sync and database clients, the AI coding CLIs, proxy clients
 * whose configs hold subscription secrets, and SSH/FTP clients' saved sessions.
 * The single-name entries (`.s3cfg`, `.pgpass`) are closed wherever they sit.
 */
const CLOUD_CLI_CREDENTIAL_PATHS = [
  '.config/gh',
  '.aliyun',
  '.tccli',
  '.ossutilconfig',
  '.cos.conf',
  '.hcloud',
  '.volcengine',
  '.terraform.d/credentials.tfrc.json',
  '.config/git/credentials',
  '.config/rclone',
  '.s3cfg',
  '.pgpass',
  '.cache/huggingface/token',
  '.cache/huggingface/stored_tokens',
  '.huggingface/token',
  '.codex/auth.json',
  '.claude/.credentials.json',
  '.gemini/oauth_creds.json',
  '.config/clash',
  '.config/clash.meta',
  '.config/mihomo',
  '.config/filezilla',
  // 1Password and DigitalOcean CLIs, Vault, Stripe, Fly.io: session tokens.
  '.config/op',
  '.op',
  '.config/doctl',
  '.vault-token',
  '.config/stripe',
  '.config/flyctl',
  // Shell and REPL histories hold typed passwords, tokens and connection strings.
  '.bash_history',
  '.zsh_history',
  '.zhistory',
  '.sh_history',
  '.history',
  '.zsh_sessions',
  '.python_history',
  '.psql_history',
  '.mysql_history',
  '.sqlite_history',
  '.node_repl_history',
  '.rediscli_history',
  '.local/share/fish/fish_history',
];

/**
 * Electron desktop apps keep the signed-in session (Cookies, Local Storage,
 * IndexedDB, saved tokens) in their data folder, the same as a browser does.
 * The whole folder is closed: none of them holds a file a person asks an
 * assistant to read.
 */
const ELECTRON_APP_NAMES = [
  'Slack', 'discord', 'Discord', 'Code', 'Code - Insiders', 'VSCodium', 'Cursor', 'Windsurf',
  'Microsoft Teams', 'Notion', 'Signal', 'Telegram Desktop', 'Element', 'Obsidian',
  'Lark', 'Feishu', 'DingTalk', 'WeChat', 'Tencent', 'QQ', 'WhatsApp', 'Figma', 'Postman',
  'GitHub Desktop', 'Spotify', 'Zoom', 'zoom.us',
];
const ELECTRON_APP_DATA_PATHS_MAC = [
  ...ELECTRON_APP_NAMES.map((name) => `Library/Application Support/${name}`),
  'Library/Containers/com.tencent.xinWeChat',
  'Library/Group Containers/5A4RE8SF68.com.tencent.xinWeChat',
];
const ELECTRON_APP_DATA_PATHS_WIN = [
  ...ELECTRON_APP_NAMES.flatMap((name) => [`AppData/Roaming/${name}`, `AppData/Local/${name}`]),
  'AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine',
  'AppData/Roaming/1Password',
];

/** The same kind of store in the macOS application folders. */
const CLIENT_CREDENTIAL_PATHS_MAC = [
  'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev',
  'Library/Application Support/mihomo-party',
  'Library/Application Support/VanDyke',
  'Library/Application Support/Tunnelblick',
];

/** And on Windows. */
const CLIENT_CREDENTIAL_PATHS_WIN = [
  'AppData/Roaming/rclone',
  'AppData/Roaming/postgresql/pgpass.conf',
  'AppData/Roaming/io.github.clash-verge-rev.clash-verge-rev',
  'AppData/Roaming/mihomo-party',
  'AppData/Roaming/FileZilla',
  'AppData/Roaming/VanDyke',
  'AppData/Roaming/NetSarang',
  'Documents/NetSarang Computer',
  'AppData/Local/WireGuard',
  'OpenVPN/config',
];

/**
 * File names that are a private key or a password database wherever they sit.
 * Compared without case, by the last path component. `.pfx` / `.p12` always
 * carry a private key; `.ovpn` and `.mobileconfig` profiles carry VPN keys,
 * passwords and certificates.
 */
const BLOCKED_FILE_NAMES = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const BLOCKED_FILE_EXTENSIONS = [
  '.kdbx', '.ppk', '.keychain', '.keychain-db', '.pfx', '.p12', '.ovpn', '.mobileconfig',
  '.jks', '.keystore', '.p8',
];

/**
 * An SSH private key saved under a name of its own: `id_rsa_work`,
 * `id_ed25519_sk`, `deploy_ed25519`. Never a `.pub` file, and never a name with
 * an extension other than the key type itself (`id_card.png`, `rsa notes.txt`).
 */
const SSH_KEY_TYPE = '(?:rsa|dsa|ecdsa|ed25519)(?:[_-]sk)?';
const SSH_PRIVATE_KEY_NAME = new RegExp(`^id_${SSH_KEY_TYPE}(?:[_-][^.]*)?$|^[^.]*[_-]${SSH_KEY_TYPE}$`);

/**
 * `.env` and its variants (`.env.local`, `.env.production`, `.env.dev`) hold a
 * project's keys; the copies made to be shared hold none and stay readable.
 */
const ENV_FILE_SHARED_SUFFIXES = new Set(['example', 'sample', 'template']);

function isEnvSecretFile(filename: string): boolean {
  if (filename === '.env') return true;
  if (!filename.startsWith('.env.')) return false;
  return !ENV_FILE_SHARED_SUFFIXES.has(filename.slice('.env.'.length));
}

/**
 * Files whose extension alone does not say whether they hold a secret: a
 * `.pem` / `.key` may be a public certificate or a Keynote deck, a `.conf` is
 * any configuration. They are closed when their text says so: a PEM private
 * key, or a WireGuard `[Interface]` with its `PrivateKey`. Read only when
 * small; a key file is a few kilobytes.
 */
const CONTENT_CHECKED_EXTENSIONS = ['.pem', '.key', '.conf'];
/**
 * A key bundle is a few kilobytes, but a chain file can be larger and carry its
 * key after the certificates, so the whole file is scanned up to this size. The
 * host reads whole files only, so the bound keeps the check cheap. A `.pem`
 * above it is closed unread (no certificate is that large); a `.key` or `.conf`
 * above it is a deck or a log, not a key.
 */
const CONTENT_CHECK_MAX_BYTES = 16 * 1024 * 1024;
/** Extension-less files are sniffed only when small: a key saved as `deploy_key`. */
const CONTENT_CHECK_BARE_NAME_MAX_BYTES = 64 * 1024;
const PRIVATE_KEY_MARKERS = [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, /^\s*PrivateKey\s*=/im];

/**
 * Places a program is started from when the user signs in. Writing there makes
 * something run on every start without anyone asking, so no mode writes there.
 * Relative to home; the system-wide ones sit under write-blocked system roots.
 */
const AUTOSTART_PATHS_MAC = [
  'Library/LaunchAgents',
  'Library/LaunchDaemons',
  'Library/Application Support/com.apple.backgroundtaskmanagementagent',
];
const AUTOSTART_PATHS_WIN = [
  'AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup',
];
/**
 * The shell login and profile scripts, run at every sign-in or new shell, on
 * both systems (Git Bash and PowerShell 7 read them on Windows too). Some are
 * also closed to reads on macOS (`BLOCKED_PATHS`).
 */
const LOGIN_SCRIPT_PATHS = [
  '.zlogin',
  '.zprofile',
  '.zshrc',
  '.zshenv',
  '.bash_login',
  '.bash_profile',
  '.bashrc',
  '.profile',
  '.config/fish',
  '.config/powershell',
];

/**
 * A PowerShell profile (`profile.ps1`, `Microsoft.PowerShell_profile.ps1`,
 * `…ISE_profile.ps1`) in a `WindowsPowerShell` or `PowerShell` folder: found by
 * name, because Documents may be redirected (OneDrive) away from home.
 */
function isPowerShellProfile(foldedPath: string): boolean {
  const parts = foldedPath.split('/');
  const name = parts[parts.length - 1] ?? '';
  const parent = parts[parts.length - 2] ?? '';
  return (parent === 'windowspowershell' || parent === 'powershell')
    && (name === 'profile.ps1' || name.endsWith('_profile.ps1'));
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
  // Environment files: `isEnvSecretFile`.
  // Reading a file never asks, so every place a signed-in session or a stored
  // password lives has to be named here. A browser keeps its cookies, saved
  // passwords, card data and the tokens sites put in local storage in every
  // profile folder, so the whole data folder of each browser is closed, not
  // one file of its default profile.
  ...BROWSER_DATA_PATHS_MAC,
  ...PASSWORD_MANAGER_PATHS_MAC,
  ...CLOUD_CLI_CREDENTIAL_PATHS,
  ...CLIENT_CREDENTIAL_PATHS_MAC,
  ...ELECTRON_APP_DATA_PATHS_MAC,
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
  '/Library/Keychains',
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
  // Windows' own key store for the files DPAPI protects.
  'AppData/Roaming/Microsoft/Crypto',
  // See BLOCKED_PATHS: every store of sessions and passwords is closed by name.
  ...BROWSER_DATA_PATHS_WIN,
  ...PASSWORD_MANAGER_PATHS_WIN,
  ...CLOUD_CLI_CREDENTIAL_PATHS,
  ...CLIENT_CREDENTIAL_PATHS_WIN,
  ...ELECTRON_APP_DATA_PATHS_WIN,
  'AppData/Roaming/gcloud',
  'AppData/Roaming/GitHub CLI',
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

/**
 * The one spelling a workspace grant is keyed by: `.` segments, duplicate and
 * trailing separators are folded away, so every spelling of one folder maps
 * to one table entry for authorize, lookup and revoke alike.
 */
function normalizeWorkspacePath(path: string): string {
  return normalizeLexicalPath(path);
}

/**
 * A grant that would cover a whole filesystem root (`/`, `C:/`, a bare UNC
 * prefix) or that climbs with a `..` segment never enters the table. Every
 * legitimate producer hands over a plain absolute folder, so a climbing
 * spelling is refused outright.
 */
function isBlankWorkspaceGrant(path: string): boolean {
  const normalized = normalizeWorkspacePath(path);
  if (normalized.trim().length === 0 || normalized === '/' || normalized === '//') return true;
  if (/^[A-Za-z]:\/?$/.test(normalized)) return true;
  return normalizeSeparators(path).split('/').includes('..');
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
 *
 * On Windows the fold also drops what Win32 drops when it opens a name: dots
 * and spaces at the end of a component (`id_rsa.`, `id_rsa `) and a stream
 * suffix (`x.pem::$DATA`). The host's canonicalizer does this too, but when it
 * is absent or fails the name checks would see the raw spelling.
 */
function foldPath(path: string): string {
  const folded = normalizeForCompare(path).toLowerCase();
  if (!isWindows()) return folded;
  return folded.split('/').map((component, index) => {
    if (component === '' || component === '.' || component === '..' || component === '?' || (index === 0 && /^[a-z]:$/.test(component))) return component;
    const name = component.replace(/:.*$/, '').replace(/[. ]+$/, '');
    return name === '' ? component : name;
  }).join('/');
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
 * 判断路径是否为绝对路径。Windows 规则与 Node win32 的 path.isAbsolute 一致；
 * 相对路径在主进程会被接到 process.cwd() 上，策略检查无法得到一致结果。
 */
function isAbsolutePolicyPath(rawPath: string): boolean {
  if (isWindows()) return /^([a-zA-Z]:)?[\\/]/.test(rawPath);
  return rawPath.startsWith('/');
}

function relativePathResult(): PathCheckResult {
  return { allowed: false, reason: '路径必须是绝对路径' };
}

/**
 * Check if a path matches any blocked pattern
 */
async function isBlockedPath(path: string, homeOverride?: string): Promise<{ blocked: boolean; reason?: string }> {
  const home = homeOverride ?? await getHomeDir();
  // Folded on every platform: macOS and Windows open `~/.SSH/id_rsa` and
  // `~/.ssh/id_rsa` as the same file, so a case-sensitive test would hand a
  // red line away for one capital letter (see `foldPath`).
  const comparePath = foldPath(path);

  // Check absolute blocked paths for read
  const readBlocked = isWindows()
    ? [...SYSTEM_PATHS_READ_BLOCKED, ...WIN_SYSTEM_PATHS_READ_BLOCKED]
    : SYSTEM_PATHS_READ_BLOCKED;
  for (const blockedPath of readBlocked) {
    const compareBlocked = foldPath(blockedPath);
    if (comparePath === compareBlocked || comparePath.startsWith(compareBlocked + '/')) {
      return { blocked: true, reason: `访问系统敏感文件被禁止: ${blockedPath}` };
    }
  }

  // Select blocked list based on platform
  const blockedPaths = isWindows() ? WIN_BLOCKED_PATHS : BLOCKED_PATHS;
  const filename = comparePath.split('/').pop() ?? '';

  // Check home-relative blocked paths
  for (const blockedPath of blockedPaths) {
    const fullBlockedPath = foldPath(`${home}/${blockedPath}`);
    if (comparePath === fullBlockedPath || comparePath.startsWith(fullBlockedPath + '/')) {
      return { blocked: true, reason: `访问敏感配置文件被禁止: ~/${blockedPath}` };
    }
    // Also check if path ends with blocked filename (e.g., any .env file)
    if (blockedPath.startsWith('.') && !blockedPath.includes('/')) {
      if (filename === blockedPath.toLowerCase()) {
        return { blocked: true, reason: `访问敏感文件被禁止: ${blockedPath}` };
      }
    }
  }

  // A private key or a password database is one wherever it was saved.
  if (isBlockedFileName(filename)) {
    return { blocked: true, reason: `访问敏感文件被禁止: ${filename}` };
  }

  return { blocked: false };
}

/** A file closed by its name alone, wherever it sits (`filename` folded to lower case). */
function isBlockedFileName(filename: string): boolean {
  return BLOCKED_FILE_NAMES.has(filename)
    || SSH_PRIVATE_KEY_NAME.test(filename)
    || BLOCKED_FILE_EXTENSIONS.some((ext) => filename.endsWith(ext))
    || isEnvSecretFile(filename);
}

/**
 * Whether a file of a `CONTENT_CHECKED_EXTENSIONS` kind, or a small file with
 * no extension, holds a private key. A folder (a Keynote package) and a missing
 * file are not one; a key-like file that cannot be read to tell is treated as one.
 */
async function holdsPrivateKey(path: string): Promise<boolean> {
  const filename = foldPath(path).split('/').pop() ?? '';
  const checkedExtension = CONTENT_CHECKED_EXTENSIONS.find((ext) => filename.endsWith(ext));
  const bareName = !filename.includes('.');
  if (!checkedExtension && !bareName) return false;
  try {
    const info = await stat(path);
    if (info.isDirectory) return false;
    const size = typeof info.size === 'number' ? info.size : 0;
    if (checkedExtension) {
      if (size > CONTENT_CHECK_MAX_BYTES) return checkedExtension === '.pem';
    } else if (size > CONTENT_CHECK_BARE_NAME_MAX_BYTES) {
      return false;
    }
    const bytes = await readFile(path);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, CONTENT_CHECK_MAX_BYTES));
    return PRIVATE_KEY_MARKERS.some((marker) => marker.test(text));
  } catch (error) {
    return !isMissingPathError(error) && checkedExtension !== undefined;
  }
}

/**
 * Whether a path lies in one of the places a program is started from at sign-in
 * (`AUTOSTART_PATHS_*`). Writes there are refused in every mode.
 */
async function isAutostartPath(path: string, homeOverride?: string): Promise<string | null> {
  const home = homeOverride ?? await getHomeDir();
  const comparePath = foldPath(path);
  const roots = [...(isWindows() ? AUTOSTART_PATHS_WIN : AUTOSTART_PATHS_MAC), ...LOGIN_SCRIPT_PATHS];
  for (const root of roots) {
    const full = foldPath(`${home}/${root}`);
    if (comparePath === full || comparePath.startsWith(`${full}/`)) return `~/${root}`;
  }
  if (isPowerShellProfile(comparePath)) return comparePath.split('/').slice(-2).join('/');
  return null;
}


/**
 * Whether a path lies in the app's own data folders (the Electron user data and
 * the `com.abu.*` app data). They hold the secret store, the persisted
 * settings, the signed-in sessions of the built-in browser and the message
 * ledgers. Reading them is refused like a credential store; the files of a
 * conversation that tools hand back (`checkConversationResultRead`) are checked
 * before this and are the carve-out.
 */
async function isAbuAppDataPath(path: string, homeOverride?: string): Promise<boolean> {
  const home = homeOverride ?? await getHomeDir();
  const comparePath = foldPath(path);
  const roots = isWindows()
    ? [`${home}/AppData/Roaming`, `${home}/AppData/Local`]
    : [`${home}/Library/Application Support`];
  for (const root of roots) {
    const foldedRoot = foldPath(root);
    if (!comparePath.startsWith(`${foldedRoot}/`)) continue;
    const segment = comparePath.slice(foldedRoot.length + 1).split('/')[0];
    if (isAbuAppDataSegment(segment)) return true;
  }
  return false;
}

/** The refusal for a write into a start-at-sign-in location (`isAutostartPath`). */
function autostartWriteRefusal(location: string): PathCheckResult {
  return { allowed: false, reason: `禁止写入开机自启动位置: ${location}`, denialKind: 'blocked' };
}

/** The refusal for a read of a file whose text is a private key (`holdsPrivateKey`). */
function privateKeyReadRefusal(): PathCheckResult {
  return { allowed: false, reason: '禁止读取私钥文件', denialKind: 'blocked' };
}

/** The refusal for a read of the app's own data folders (`isAbuAppDataPath`). */
function appDataReadRefusal(): PathCheckResult {
  return { allowed: false, reason: '禁止读取本应用自身的数据目录（密钥、设置和登录状态）', denialKind: 'blocked' };
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
  /** `blocked`: refused as a closed location would be (a short name nobody can expand). */
  | { ok: false; reason: string; blocked?: true };

function unresolvedPathResult(resolved: { reason: string; blocked?: true }): PathCheckResult {
  return { allowed: false, reason: resolved.reason, ...(resolved.blocked ? { denialKind: 'blocked' as const } : {}) };
}

/** A Windows 8.3 short name among the components: `PROGRA~1`, `USERDA~1`. */
function hasShortNameComponent(path: string): boolean {
  return path.split('/').some((component) => /^[^~]{1,6}~\d+(?:\.[^.]{0,3})?$/.test(component));
}

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
  //
  // Without the host's resolver nothing expands a Windows 8.3 short name
  // (`USERDA~1`, `TESTUS~1`), so the lexical checks cannot tell whether it
  // names a closed store or home itself: such a path is refused, as a link
  // nobody can resolve is.
  if (isWindows() && hasShortNameComponent(lexicalPath)) {
    return { ok: false, reason: '无法核实短文件名指向的位置，请使用完整路径。', blocked: true };
  }
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
  /** Count only the grants of folders inside this one (a grant of the folder itself included). */
  grantsWithin?: string,
): Promise<CanonicalMatch> {
  const target = getAuthorizationMap(scopeId);
  if (!target) return { lexical: false, canonical: false };
  let lexical = false;
  let canonical = false;
  for (const [workspace, grant] of target) {
    if (isBlankWorkspaceGrant(workspace) || !grant.capabilities.has(capability)) continue;
    if (grantsWithin !== undefined && !isPathWithin(workspace, grantsWithin)) continue;
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

  // Block platform-sensitive directories. Compared without case: on Windows
  // `normalizePath` has already lowercased `firstDir`, so a literal `'AppData'`
  // never matched and the whole AppData folder was offered (and, where
  // permission is granted automatically, granted) as one unit; macOS opens
  // `~/library` as `~/Library` too.
  const sensitiveDirs = isWindows() ? SENSITIVE_HOME_DIRS_WIN : SENSITIVE_HOME_DIRS_MAC;
  if (sensitiveDirs.some((dir) => dir.toLowerCase() === firstDir.toLowerCase())) {
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
export async function checkConversationResultRead(path: string, conversationId: string | undefined): Promise<PathCheckResult | null> {
  if (!conversationId || !isAbsolutePolicyPath(path) || isUNCPath(path)) return null;
  const appData = await appDataDir();
  const root = createConversationPaths(appData).resultsDir(conversationId);
  if (!isPathWithin(normalizePath(path), normalizePath(root))) return null;
  const resolved = await resolvePathForPolicy(path);
  if (!resolved.ok) return unresolvedPathResult(resolved);
  const canonicalAppData = await canonicalizePolicyAnchor(appData);
  if (!canonicalAppData) return { allowed: false, reason: '无法安全解析会话目录' };
  const expectedRoot = createConversationPaths(canonicalAppData).resultsDir(conversationId);
  if (!isPathWithin(resolved.canonicalPath, normalizePath(expectedRoot))) return canonicalScopeEscapeResult();
  const blocked = await isBlockedPath(resolved.canonicalPath);
  if (blocked.blocked) return { allowed: false, reason: blocked.reason, denialKind: 'blocked' };
  return { allowed: true, resolvedPath: resolved.canonicalPath };
}

export async function checkReadPath(path: string, scopeId?: AuthorizationScopeId): Promise<PathCheckResult> {
  // Block UNC network paths
  if (isUNCPath(path)) {
    return { allowed: false, reason: 'UNC network paths are not supported' };
  }
  if (!isAbsolutePolicyPath(path)) return relativePathResult();

  const normalizedPath = normalizePath(path);

  // Check blocked paths first
  const blockCheck = await isBlockedPath(normalizedPath);
  if (blockCheck.blocked) {
    return { allowed: false, reason: blockCheck.reason, denialKind: 'blocked' };
  }

  const resolved = await resolvePathForPolicy(path);
  if (!resolved.ok) return unresolvedPathResult(resolved);

  const home = await getHomeDir();
  const canonicalHome = await canonicalizePolicyAnchor(home);
  if (!canonicalHome) return { allowed: false, reason: '无法安全解析用户目录' };

  const canonicalBlock = await isBlockedPath(resolved.canonicalPath, canonicalHome);
  if (canonicalBlock.blocked) {
    return { allowed: false, reason: canonicalBlock.reason, denialKind: 'blocked' };
  }
  if (await holdsPrivateKey(resolved.canonicalPath)) return privateKeyReadRefusal();

  // The app's own data folders hold the secret store, the settings and the
  // built-in browser's signed-in sessions: closed to reads ahead of every grant.
  if (await isAbuAppDataPath(resolved.lexicalPath, home) || await isAbuAppDataPath(resolved.canonicalPath, canonicalHome)) {
    return appDataReadRefusal();
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
      permissionIsFolder: true,
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
      permissionIsFolder: true,
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
  /**
   * `purpose: 'delete'`: the write takes the file away. Removing an entry
   * from an autostart folder undoes an automatic start, so it is asked about
   * like any other write there instead of being refused.
   */
  options: { followFinalSymlink?: boolean; purpose?: 'write' | 'delete' } = {},
): Promise<PathCheckResult> {
  // Block UNC network paths
  if (isUNCPath(path)) {
    return { allowed: false, reason: 'UNC network paths are not supported' };
  }
  if (!isAbsolutePolicyPath(path)) return relativePathResult();

  const normalizedPath = normalizePath(path);

  // Check blocked paths first
  const blockCheck = await isBlockedPath(normalizedPath);
  if (blockCheck.blocked) {
    return { allowed: false, reason: blockCheck.reason, denialKind: 'blocked' };
  }

  // Abu's own config and state — checked before the authorized-workspace
  // shortcut on purpose: authorizing a parent directory (or the home dir)
  // must not hand the agent write access to its own permission config,
  // secret store, or task definitions.
  if (await isAbuSelfManagedPath(normalizedPath)) {
    return { allowed: false, reason: '禁止写入阿布自身的配置与状态目录' };
  }

  // Start-at-sign-in locations: no mode and no grant writes there.
  const deletes = options.purpose === 'delete';
  const autostart = deletes ? null : await isAutostartPath(normalizedPath);
  if (autostart) return autostartWriteRefusal(autostart);

  const resolved = await resolvePathForPolicy(path, options);
  if (!resolved.ok) return unresolvedPathResult(resolved);

  const home = await getHomeDir();
  const canonicalHome = await canonicalizePolicyAnchor(home);
  if (!canonicalHome) return { allowed: false, reason: '无法安全解析用户目录' };

  const canonicalBlock = await isBlockedPath(resolved.canonicalPath, canonicalHome);
  if (canonicalBlock.blocked) {
    return { allowed: false, reason: canonicalBlock.reason, denialKind: 'blocked' };
  }
  if (await isAbuSelfManagedPath(resolved.canonicalPath, canonicalHome)) {
    return { allowed: false, reason: '禁止写入阿布自身的配置与状态目录' };
  }
  const canonicalAutostart = deletes ? null : await isAutostartPath(resolved.canonicalPath, canonicalHome);
  if (canonicalAutostart) return autostartWriteRefusal(canonicalAutostart);

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
      permissionIsFolder: true,
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
      permissionIsFolder: true,
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
 * The system-ish folder of home a listing of `path` lies in (`~/Library`,
 * `~/.Trash`; `~/AppData`, `~/$Recycle.Bin`), or null. Folded: macOS lists
 * `~/library` as `~/Library`.
 */
function closedListingRoot(path: string, home: string): { root: string; name: string } | null {
  const names = isWindows() ? ['$Recycle.Bin', 'AppData'] : ['.Trash', 'Library'];
  const folded = foldPath(path);
  for (const name of names) {
    const root = `${home}/${name}`;
    const foldedRoot = foldPath(root);
    if (folded === foldedRoot || folded.startsWith(`${foldedRoot}/`)) return { root: normalizePath(root), name };
  }
  return null;
}

/**
 * Check if a path is safe for listing (more permissive than read/write)
 */
export async function checkListPath(path: string, scopeId?: AuthorizationScopeId, options: { followFinalSymlink?: boolean } = {}): Promise<PathCheckResult> {
  // Block UNC network paths
  if (isUNCPath(path)) {
    return { allowed: false, reason: 'UNC network paths are not supported' };
  }
  if (!isAbsolutePolicyPath(path)) return relativePathResult();

  const normalizedPath = normalizePath(path);

  // Block sensitive directories from listing too
  const blockCheck = await isBlockedPath(normalizedPath);
  if (blockCheck.blocked) {
    return { allowed: false, reason: blockCheck.reason, denialKind: 'blocked' };
  }

  const resolved = await resolvePathForPolicy(path, options);
  if (!resolved.ok) return unresolvedPathResult(resolved);

  const home = await getHomeDir();
  const canonicalHome = await canonicalizePolicyAnchor(home);
  if (!canonicalHome) return { allowed: false, reason: '无法安全解析用户目录' };

  const canonicalBlock = await isBlockedPath(resolved.canonicalPath, canonicalHome);
  if (canonicalBlock.blocked) {
    return { allowed: false, reason: canonicalBlock.reason, denialKind: 'blocked' };
  }
  if (await isAbuAppDataPath(resolved.lexicalPath, home) || await isAbuAppDataPath(resolved.canonicalPath, canonicalHome)) {
    return appDataReadRefusal();
  }

  // `~/Library`, `~/AppData` and the trash are not listed through a grant of
  // a folder above them (reading never asks, so a read of home leaves home
  // read-granted); a grant of a folder inside them (an iCloud Drive folder)
  // still lists that folder.
  const listingClosedRoot = closedListingRoot(normalizedPath, home);
  const workspaceMatch = await matchAuthorizedWorkspaces(
    resolved.lexicalPath,
    resolved.canonicalPath,
    'read',
    scopeId,
    listingClosedRoot?.root,
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
  // (The Windows temp folder, inside AppData, is an implicit root above.)
  if (listingClosedRoot) return { allowed: false, reason: `禁止列出目录: ~/${listingClosedRoot.name}` };

  if (scopeId === undefined && (workspaceMatch.lexical || implicitMatch.lexical)) {
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: resolved.canonicalPath,
      // 列目录时被列的文件夹本身就是授权单位
      permissionIsFolder: true,
      capability: 'read',
    };
  }

  // For listing under home, require permission (system-ish paths are closed above)
  const normalizedHome = normalizePath(home);
  if (normalizedPath.startsWith(normalizedHome)) {

    // Home directory itself — need permission
    const permDir = getPermissionDirectory(normalizedPath, normalizedHome);
    return {
      allowed: false,
      needsPermission: true,
      permissionPath: permDir,
      permissionIsFolder: true,
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
      permissionIsFolder: true,
      capability: 'read',
    };
  }

  // Path passed all security checks but isn't pre-authorized — offer permission dialog
  return {
    allowed: false,
    needsPermission: true,
    permissionPath: normalizedPath,
    permissionIsFolder: true,
    capability: 'read',
  };
}

/**
 * Whether the hard blocks close `path` to reads (credential stores, private
 * keys, the app's own data), judged on the spelling alone. A recursive search
 * path-checks the folder it starts in and then meets every file below it; it
 * asks this of each one, so the search reads exactly what `read_file` would.
 */
export async function isReadClosed(path: string): Promise<boolean> {
  if (!isAbsolutePolicyPath(path) || isUNCPath(path)) return true;
  const normalized = normalizePath(path);
  return (await isBlockedPath(normalized)).blocked
    || await isAbuAppDataPath(normalized)
    || await holdsPrivateKey(path);
}
