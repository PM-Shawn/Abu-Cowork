import { joinPath, normalizeSeparators } from '../../utils/pathUtils';

/**
 * Install root directory name, under `<home>/.abu/`.
 *
 * ⚠️ Deliberately NOT `plugins` — that name is already taken by the IM plugin
 * loader (`src/core/im/pluginLoader.ts:92`, `~/.abu/plugins/`), which uses an
 * unrelated manifest schema. Mixing the two directories would corrupt both
 * loaders. If this ever needs to change, change only this constant.
 */
export const PLUGIN_ROOT_DIRNAME = 'plugin-packages';

/** `<home>/.abu/<PLUGIN_ROOT_DIRNAME>` */
export function pluginRoot(home: string): string {
  return joinPath(home, '.abu', PLUGIN_ROOT_DIRNAME);
}


/** A third-party string was not usable as a path segment. */
export class PluginPathError extends Error {
  readonly field: string;

  constructor(field: string, value: string) {
    super(`Unsafe plugin path segment for ${field}: ${JSON.stringify(value)}`);
    this.name = 'PluginPathError';
    this.field = field;
  }
}

/** Normalize a package-relative component path without consulting the filesystem. */
export function normalizePluginComponentPath(value: string): string {
  const path = normalizeSeparators(value);
  // Also reject drive/ADS syntax and control characters on non-Windows hosts.
  // eslint-disable-next-line no-control-regex
  if (!path || path.trim() !== path || path.startsWith('/') || path.startsWith('~') || /[:\u0000-\u001f\u007f]/.test(path)) {
    throw new PluginPathError('component', value);
  }
  const segments = path.split('/').filter(segment => segment !== '' && segment !== '.');
  if (segments.includes('..')) throw new PluginPathError('component', value);
  return segments.join('/') || '.';
}

/**
 * Reject a third-party string that must not escape its directory.
 *
 * `marketplace`, plugin `name` and `version` all come from JSON written by
 * whoever authored the marketplace. Concatenated unchecked they are a path
 * traversal: a marketplace named `../../Library`, a plugin named
 * `LaunchAgents` and version `.` resolve to `~/Library/LaunchAgents`, which is
 * still inside $HOME and therefore passes Electron's capability scope
 * (`fsHost.cjs` `assertAllowed`). Install would write into a login-item
 * directory; uninstall would `remove(recursive: true)` it.
 *
 * Windows is worse — `assertAllowed` returns before any scope check there — so
 * backslash is rejected alongside forward slash rather than treated as an
 * ordinary character.
 *
 * Denylist rather than a charset allowlist: plugin names legitimately carry
 * `@`, `.` and unicode, and an allowlist narrow enough to be safe would reject
 * real packages. What must never appear is a separator, a NUL, or a segment
 * that is only dots.
 */
function assertSafeSegment(field: string, value: string): string {
  if (typeof value !== 'string') throw new PluginPathError(field, String(value));
  if (value.trim() !== value || value.length === 0) throw new PluginPathError(field, value);
  // Separators, plus every control character. A control char is never a
  // legitimate part of a package name, and one embedded in a displayed name
  // can hide what a path really is from whoever is approving the install.
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(value)) throw new PluginPathError(field, value);
  if (/^\.+$/.test(value)) throw new PluginPathError(field, value);
  return value;
}

/** `<home>/.abu/<PLUGIN_ROOT_DIRNAME>/<marketplace>/<name>/<version>` */
export function pluginInstallDir(
  home: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  return joinPath(
    pluginRoot(home),
    assertSafeSegment('marketplace', marketplace),
    assertSafeSegment('name', name),
    assertSafeSegment('version', version),
  );
}

/** `<pluginRoot>/installed.json` — the installed-plugins manifest. */
export function installedManifestPath(home: string): string {
  return joinPath(pluginRoot(home), 'installed.json');
}

/**
 * Composite key `${name}@${marketplace}`.
 * Mirrors Codex: the same plugin name can be installed from multiple
 * marketplaces and must coexist, so the key needs both parts.
 */
export function pluginKey(name: string, marketplace: string): string {
  return `${name}@${marketplace}`;
}

/**
 * Inverse of {@link pluginKey}.
 *
 * Plugin names may themselves contain `@` (e.g. npm-scoped names like
 * `@scope/name`), so splitting on the FIRST `@` would be wrong. We split on
 * the LAST `@`: everything before it is the name, everything after is the
 * marketplace.
 *
 * Returns `null` when there is no `@` at all (not a valid key).
 */
export function parsePluginKey(key: string): { name: string; marketplace: string } | null {
  const idx = key.lastIndexOf('@');
  if (idx <= 0 || idx === key.length - 1) return null;
  return {
    name: key.slice(0, idx),
    marketplace: key.slice(idx + 1),
  };
}
