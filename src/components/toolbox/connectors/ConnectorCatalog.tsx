/**
 * 「市场」 for the Connectors tab — connectors the user did not write: the
 * curated catalog Abu ships (the same {@link BUILTIN_REGISTRY} the agent
 * searches when it hits a capability gap) and the servers an installed plugin
 * brought with it.
 *
 * Two rules shape the panel:
 *
 * 1. 「添加」 never writes a server. A catalog entry carries env-var *keys* with
 *    empty values — a token slot, not a token — so adding it silently would
 *    persist a config that cannot connect and hide the reason. The button hands
 *    the entry to the host, which opens 「我的」's add-server form pre-filled and
 *    lets the user supply the secrets.
 * 2. A plugin's server is not the user's to remove. It arrived with a package
 *    and leaves when that package is uninstalled, from the Plugins tab; a 移除
 *    here would strand the plugin's install record describing a server that is
 *    gone. So the `···` on a plugin-owned server offers exactly what is true:
 *    try it, or manage it.
 *
 * Rule 2 applies by ownership, not by group: a plugin is free to contribute a
 * server named after a catalog entry, and that catalog row cannot offer 移除
 * either. There the item stays but is disabled and names the owning plugin —
 * among rows that otherwise look identical, an item that quietly disappears
 * reads as a glitch, and a disabled one answers "why not". Such a server is
 * listed once — in the catalog, where its name belongs — and not repeated below.
 */

import { useCallback, useMemo } from 'react';
import { Server } from 'lucide-react';
import { format, useI18n } from '@/i18n';
import { BUILTIN_REGISTRY, getEntryDescription, getRegistryEntry, type MCPRegistryEntry } from '@/core/agent/mcpDiscovery';
import { pluginServerOwners } from '@/core/plugin/pluginMcpBridge';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import { usePluginStore } from '@/stores/pluginStore';
import { Button } from '@/components/ui/button';
import InstalledItemMenu, { type InstalledItemMenuAction } from '@/components/toolbox/InstalledItemMenu';
import { useTrialLauncher } from '@/components/toolbox/useTrialLauncher';

interface ConnectorCatalogProps {
  searchQuery: string;
  /** 「添加」 — hand the catalog entry to the host, which opens the add-server
   *  form pre-filled. Deliberately not an install: see rule 1 above. */
  onPrefillAdd: (entry: MCPRegistryEntry) => void;
  /** 「管理」 — the host switches to 「我的」 focused on this server, which owns
   *  the per-server editor. Required: a menu item that goes nowhere is worse
   *  than no menu item. */
  onManage: (name: string) => void;
}

/** What a configured server's row says under its name — its command line. */
function commandLine(entry: MCPServerEntry): string {
  const c = entry.config;
  if (c.url || c.transport === 'http') return c.url ?? '';
  return [c.command, ...(c.args ?? [])].filter(Boolean).join(' ');
}

export default function ConnectorCatalog({ searchQuery, onPrefillAdd, onManage }: ConnectorCatalogProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const servers = useMCPStore((s) => s.servers);
  const removeServer = useMCPStore((s) => s.removeServer);
  const disconnectServer = useMCPStore((s) => s.disconnectServer);
  const installedPlugins = usePluginStore((s) => s.installed);
  const launchTrial = useTrialLauncher();

  // server name → owning plugin. The single source of "this is not yours".
  const owners = useMemo(() => pluginServerOwners(installedPlugins), [installedPlugins]);

  // Resolved the way this host would actually run them, so a prefill matches
  // what an install would have produced (Electron swaps the Chrome bridge).
  const catalog = useMemo(
    () => BUILTIN_REGISTRY.map((entry) => getRegistryEntry(entry.name) ?? entry),
    [],
  );
  const catalogNames = useMemo(() => new Set(catalog.map((e) => e.name)), [catalog]);

  const query = searchQuery.trim().toLowerCase();

  const visibleCatalog = useMemo(() => {
    if (!query) return catalog;
    return catalog.filter((entry) =>
      entry.name.toLowerCase().includes(query)
      || getEntryDescription(entry.name).toLowerCase().includes(query)
      || entry.keywords.some((k) => k.toLowerCase().includes(query)));
  }, [catalog, query]);

  // Plugin-contributed servers that the catalog does not already list.
  const visiblePluginServers = useMemo(() => {
    const rows = Object.keys(owners)
      .filter((name) => !catalogNames.has(name))
      .map((name) => servers[name])
      .filter((entry): entry is MCPServerEntry => Boolean(entry));
    if (!query) return rows;
    return rows.filter((entry) => {
      const name = entry.config.name;
      return name.toLowerCase().includes(query) || owners[name].toLowerCase().includes(query);
    });
  }, [owners, catalogNames, servers, query]);

  /**
   * Disconnect first: `removeServer` drops the config, and a live client that
   * outlived it would keep a child process around with nothing left describing
   * it. A failed disconnect must not strand the config either — removal is the
   * user's stated intent, so it proceeds.
   */
  const handleRemove = useCallback(async (name: string) => {
    try { await disconnectServer(name); } catch { /* removal is still the intent */ }
    removeServer(name);
  }, [disconnectServer, removeServer]);

  /**
   * `remove` describes what this row's 移除 may do: `undefined` withholds the
   * item (the plugin group, whose rows never carried one), `{}` enables it, and
   * a `disabledReason` keeps it visible but inert. A catalog row whose server a
   * plugin owns takes the third: silently dropping an item from a menu that is
   * otherwise identical to its neighbours' reads as a glitch, and leaves the
   * user hunting for an action that is gone for a reason nobody stated.
   */
  const menuActions = useCallback((
    name: string,
    description: string,
    remove?: { disabledReason?: string },
  ): InstalledItemMenuAction[] => {
    const actions: InstalledItemMenuAction[] = [
      { id: 'trial', label: tb.menuTrial, onSelect: () => launchTrial({ name, description }) },
      { id: 'manage', label: tb.menuManage, onSelect: () => onManage(name) },
    ];
    if (remove) {
      actions.push({
        id: 'remove',
        label: tb.menuRemove,
        destructive: true,
        disabledReason: remove.disabledReason,
        onSelect: () => { void handleRemove(name); },
      });
    }
    return actions;
  }, [tb, launchTrial, onManage, handleRemove]);

  const row = (name: string, description: string, trailing: React.ReactNode, provenance?: string) => (
    <li
      key={name}
      data-testid="connector-row"
      className="flex items-center gap-3 rounded-lg border border-[var(--abu-border)] px-3 py-2.5"
    >
      <Server className="h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" />
      <div className="min-w-0 flex-1">
        <span className="block truncate text-h-xs text-[var(--abu-text-primary)]">{name}</span>
        <p className="truncate text-minor text-[var(--abu-text-tertiary)]">{description}</p>
        {provenance && (
          <p className="truncate text-caption text-[var(--abu-text-muted)]">{provenance}</p>
        )}
      </div>
      {trailing}
    </li>
  );

  return (
    <div className="h-full overflow-y-auto overlay-scroll px-8 py-3">
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <div className="mb-3 text-body font-medium text-[var(--abu-text-muted)]">{tb.connectorsMarketTitle}</div>
          {visibleCatalog.length === 0 ? (
            <p className="py-8 text-center text-body text-[var(--abu-text-tertiary)]">{tb.noServersConfigured}</p>
          ) : (
            <ul className="space-y-1.5">
              {visibleCatalog.map((entry) => {
                const configured = servers[entry.name];
                const description = getEntryDescription(entry.name);
                const owner = owners[entry.name];
                const provenance = owner ? format(tb.mcpFromPlugin, { name: owner }) : undefined;
                return row(
                  entry.name,
                  description,
                  configured ? (
                    <InstalledItemMenu
                      testId="connector-item-menu"
                      ariaLabel={format(tb.itemMenuLabel, { name: entry.name })}
                      actions={menuActions(entry.name, description, { disabledReason: provenance })}
                    />
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="connector-add-button"
                      aria-label={format(tb.connectorAddLabel, { name: entry.name })}
                      onClick={() => onPrefillAdd(entry)}
                    >
                      {tb.connectorsAdd}
                    </Button>
                  ),
                  provenance,
                );
              })}
            </ul>
          )}
        </div>

        {visiblePluginServers.length > 0 && (
          <div data-testid="connectors-from-plugins">
            <div className="mb-3 text-body font-medium text-[var(--abu-text-muted)]">{tb.connectorsFromPlugins}</div>
            <ul className="space-y-1.5">
              {visiblePluginServers.map((entry) => {
                const name = entry.config.name;
                const command = commandLine(entry);
                const provenance = format(tb.mcpFromPlugin, { name: owners[name] });
                const description = command ? `${provenance} · ${command}` : provenance;
                return row(
                  name,
                  description,
                  <InstalledItemMenu
                    testId="connector-item-menu"
                    ariaLabel={format(tb.itemMenuLabel, { name })}
                    actions={menuActions(name, description)}
                  />,
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
