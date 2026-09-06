/**
 * Where installed plugins' contributions live, for the systems that consume
 * them: the skill loader (skills) and the tool approval policy (MCP servers).
 *
 * Both read from `installed.json` rather than scanning directories, so what a
 * plugin is credited with is exactly what it declared at install time — the
 * same list uninstall uses. Scanning would let a plugin gain contributions
 * after the user approved its disclosure.
 */

import { joinPath } from '../../utils/pathUtils';
import { readInstalled, type InstalledPlugin } from './installedStore';
import { pluginInstallDir } from './paths';
import { isEnterpriseModuleActive } from '../enterprise/entitlement';
import { isEnterpriseInstall } from './enterpriseMarket';

/**
 * `skills/` root of every installed plugin, in install-record order.
 *
 * Ranked *below* the user's own skill directories by the loader: a
 * hand-written skill must always win a name collision against one a plugin
 * brought in.
 */
export async function pluginSkillDirs(home: string): Promise<string[]> {
  const installed = await readInstalled(home);
  // Organization plugins are entitlement-gated the same way enterprise skills
  // are (loader.ts): licence lapsed/offline → their skills stop loading,
  // files stay on disk.
  const entitled = isEnterpriseModuleActive('skills');
  return installed
    .filter((p) => entitled || !isEnterpriseInstall(p))
    .map((p) => joinPath(pluginInstallDir(home, p.marketplace, p.name, p.version), 'skills'));
}

/**
 * Every MCP server name contributed by these install records, de-duplicated.
 *
 * Pure, and separate from the disk read on purpose: the approval gate is armed
 * from records the caller has ALREADY read successfully (see
 * `pluginStore.refreshInstalled`). Re-reading the file to answer the same
 * question would open a second failure window in which the read fails, yields
 * `[]`, and quietly empties the gate.
 */
export function mcpServerNamesOf(installed: readonly InstalledPlugin[]): string[] {
  const names = new Set<string>();
  for (const plugin of installed) {
    for (const server of plugin.contributed.mcpServers) names.add(server);
  }
  return [...names];
}

/** Every MCP server name contributed by an installed plugin, de-duplicated. */
export async function pluginMcpServerNames(home: string): Promise<string[]> {
  return mcpServerNamesOf(await readInstalled(home));
}
