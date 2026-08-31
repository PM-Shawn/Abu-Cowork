import { joinPath } from '../../utils/pathUtils';

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

/** `<home>/.abu/<PLUGIN_ROOT_DIRNAME>/<marketplace>/<name>/<version>` */
export function pluginInstallDir(
  home: string,
  marketplace: string,
  name: string,
  version: string,
): string {
  return joinPath(pluginRoot(home), marketplace, name, version);
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
