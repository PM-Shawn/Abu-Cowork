/**
 * Plugins tab (Toolbox → Plugins, behind LABS_PLUGIN_SYSTEM).
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
 */

import { useEffect, useMemo, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { partitionInstalled } from '@/core/plugin/enterpriseMarket';
import { useI18n } from '@/i18n';
import SubTabBar from '@/components/customize/SubTabBar';
import { usePluginStore } from '@/stores/pluginStore';
import InstalledPluginList from './InstalledPluginList';
import MarketplaceBrowser from './MarketplaceBrowser';
import AddMarketplaceDialog from './AddMarketplaceDialog';

type PluginSubTab = 'installed' | 'marketplace';

interface PluginsTabProps {
  /** Shared toolbox header search box. */
  searchQuery: string;
}

export default function PluginsTab({ searchQuery }: PluginsTabProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const [home, setHome] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<PluginSubTab>('installed');
  const [addOpen, setAddOpen] = useState(false);
  const installed = usePluginStore((s) => s.installed);
  const refreshInstalled = usePluginStore((s) => s.refreshInstalled);
  const ensureBuiltinMarketplace = usePluginStore((s) => s.ensureBuiltinMarketplace);
  // Organization (enterprise-market) installs are shown in their own surface
  // (private module), so the installed-tab count should read as "how many of
  // MY installs" rather than being inflated by an org-managed catalog.
  const personalInstalledCount = useMemo(() => partitionInstalled(installed).personal.length, [installed]);

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
      <div className="shrink-0 px-8 pt-2">
        <div className="inline-block">
          <SubTabBar
            tabs={[
              { id: 'installed', label: tb.pluginsInstalledTab, count: personalInstalledCount },
              { id: 'marketplace', label: tb.pluginsMarketplaceTab },
            ]}
            activeTab={subTab}
            onChange={(id) => setSubTab(id as PluginSubTab)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {home === null ? null : subTab === 'installed' ? (
          <InstalledPluginList
            home={home}
            searchQuery={searchQuery}
            onBrowseMarketplace={() => setSubTab('marketplace')}
          />
        ) : (
          <MarketplaceBrowser
            home={home}
            searchQuery={searchQuery}
            onAddMarketplace={() => setAddOpen(true)}
          />
        )}
      </div>

      {home !== null && (
        <AddMarketplaceDialog
          open={addOpen}
          home={home}
          onClose={() => setAddOpen(false)}
          onAdded={() => setSubTab('marketplace')}
        />
      )}
    </div>
  );
}
