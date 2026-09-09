import { useEffect, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { Button } from '@/components/ui/button';
import { bootstrapPluginUpdates, usePluginStore } from '@/stores/pluginStore';
import { useI18n } from '@/i18n';
import AuthoredPluginList from './AuthoredPluginList';
import MarketplaceBrowser from './MarketplaceBrowser';
import AddMarketplaceDialog from './AddMarketplaceDialog';

interface PluginsTabProps {
  /** Shared toolbox header search box. */
  searchQuery: string;
  addTrigger?: number;

}

export default function PluginsTab({ searchQuery, addTrigger = 0 }: PluginsTabProps) {
  const { t } = useI18n();
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [requestedMarket, setRequestedMarket] = useState<{ name: string }>();
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => { if (addTrigger > 0) setAddOpen(true); }, [addTrigger]);
  const [recovering, setRecovering] = useState(false);
  const recoveryError = usePluginStore(s => s.recoveryError);
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
    <div ref={setScrollParent} className="h-full overflow-y-auto overlay-scroll pb-6">
      {recoveryError && <div role="alert" className="mx-8 mb-4 rounded-xl border border-[var(--abu-border)] p-4">
        <p className="text-body text-[var(--abu-text-primary)]">{t.toolbox.pluginsRecoveryNeeded}</p>
        <p className="mt-1 break-words text-minor text-[var(--abu-text-muted)]">{recoveryError}</p>
        <Button size="sm" className="mt-3" disabled={recovering} onClick={() => {
          setRecovering(true);
          void bootstrapPluginUpdates().catch(() => {}).finally(() => setRecovering(false));
        }}>{t.toolbox.pluginsRetryRecovery}</Button>
      </div>}
      {home !== null && <>
        <AuthoredPluginList home={home} searchQuery={searchQuery} />
        <section>
          <h3 className="mx-auto max-w-[1088px] pl-11 pr-8 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.sourceMarket}</h3>
          <MarketplaceBrowser
            home={home}
            requestedMarket={requestedMarket}
            searchQuery={searchQuery}
            onAddMarketplace={() => setAddOpen(true)}
            scrollParent={scrollParent ?? undefined}
          />
        </section>
      </>}

      {home !== null && (
        <AddMarketplaceDialog onAdded={name => setRequestedMarket({ name })} open={addOpen} home={home} onClose={() => setAddOpen(false)} />
      )}
    </div>
  );
}
