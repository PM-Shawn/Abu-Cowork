/**
 * Plugins tab (Extensions → 插件).
 *
 * Owns the two things the sub-views should not each own: the resolved home
 * directory, and the mount-time hydration of the installed set.
 *
 * The hydration is not just for display. `refreshInstalled` is also what arms
 * `pluginToolPolicy`'s in-memory server-name set (see pluginStore's module
 * doc); without a hydrate somewhere, a plugin installed in a *previous*
 * session would have its MCP tools run unapproved until the next install.
 * Opening this tab is the earliest guaranteed point for that today — a startup
 * hydrate belongs with the skill loader's bootstrap and is tracked separately.
 *
 * What it deliberately does NOT own any more is navigation. 市场 | 我的 is a
 * choice shared by every Extensions tab, so the sub-nav lives above this
 * component and arrives as `source`; the old 已安装 / 插件市场 sub-tabs are
 * gone, and installed plugins are shown in place inside 市场 instead.
 */

import { useEffect, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { usePluginStore } from '@/stores/pluginStore';
import type { ExtensionSource } from '@/components/toolbox/extensionSource';
import InstalledPluginList from './InstalledPluginList';
import MarketplaceBrowser from './MarketplaceBrowser';
import AddMarketplaceDialog from './AddMarketplaceDialog';

interface PluginsTabProps {
  /** Shared toolbox header search box. */
  searchQuery: string;
  /**
   * Which source to show. The sub-nav above this component supplies it; the
   * default keeps 市场 as the surface for any caller that renders the tab
   * without a sub-nav (a test harness, a deep link that names no source),
   * rather than leaving them a blank panel.
   */
  source?: ExtensionSource;
}

export default function PluginsTab({ searchQuery, source = 'market' }: PluginsTabProps) {
  const [home, setHome] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const refreshInstalled = usePluginStore((s) => s.refreshInstalled);
  const ensureBuiltinMarketplace = usePluginStore((s) => s.ensureBuiltinMarketplace);

  useEffect(() => {
    let cancelled = false;
    homeDir()
      .then(async (dir) => {
        if (cancelled) return;
        setHome(dir);
        // Also re-arms the MCP approval gate — see the module doc.
        await refreshInstalled(dir);
      })
      .catch((err) => console.error('Plugins tab: failed to resolve home', err));
    // Preload the built-in Abu market so a fresh install already has a market
    // to browse. Best-effort: a missing bundle degrades to no built-in market.
    // It is also what tells the market panel that the marketplace list has
    // hydrated, so orphaned installs are only claimed once it lands.
    resolveBuiltinMarketDir()
      .then((marketDir) => {
        if (cancelled || !marketDir) return;
        ensureBuiltinMarketplace(marketDir);
      })
      .catch((err) => console.error('Plugins tab: failed to resolve built-in market', err));
    return () => {
      cancelled = true;
    };
  }, [refreshInstalled, ensureBuiltinMarketplace]);

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        {home === null ? null : source === 'mine' ? (
          <InstalledPluginList home={home} mode="authored" searchQuery={searchQuery} />
        ) : (
          <MarketplaceBrowser
            home={home}
            searchQuery={searchQuery}
            onAddMarketplace={() => setAddOpen(true)}
          />
        )}
      </div>

      {home !== null && (
        <AddMarketplaceDialog open={addOpen} home={home} onClose={() => setAddOpen(false)} />
      )}
    </div>
  );
}
