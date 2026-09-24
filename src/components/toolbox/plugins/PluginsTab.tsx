import { useEffect, useRef, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { Button } from '@/components/ui/button';
import { bootstrapPluginUpdates, usePluginStore } from '@/stores/pluginStore';
import { useI18n } from '@/i18n';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { archivePluginOperation } from '@/core/plugin/operationBridge';
import AuthoredPluginList from './AuthoredPluginList';
import InstalledPluginList from './InstalledPluginList';
import MarketplaceBrowser from './MarketplaceBrowser';
import AddMarketplaceDialog from './AddMarketplaceDialog';
import type { ExtensionSource } from '../extensionSource';
import { useExtensionSourceStore } from '@/stores/extensionSourceStore';

interface PluginsTabProps {
  /** Shared toolbox header search box. */
  searchQuery: string;
  addTrigger?: number;
  /** Which shelf this render is showing — the sub-nav's current pick.
   *  Defaults to 市场, the shelf a fresh install has something on. */
  source?: ExtensionSource;
}

export default function PluginsTab({ searchQuery, addTrigger = 0, source = 'market' }: PluginsTabProps) {
  const { t } = useI18n();
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [requestedMarket, setRequestedMarket] = useState<{ name: string }>();
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => { if (addTrigger > 0) setAddOpen(true); }, [addTrigger]);
  const [recovering, setRecovering] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archiving = useRef(false);
  const [archiveResult, setArchiveResult] = useState<{ archivedPath: string; backupPaths: string[] } | null>(null);
  // How many cards the authored list is contributing to the shelf's one grid,
  // so an empty install list with a draft in it is not called empty.
  const [authoredCount, setAuthoredCount] = useState(0);
  const unreadable = usePluginStore(s => s.unreadableOperation);
  const recoveryError = usePluginStore(s => s.recoveryError);
  const refreshInstalled = usePluginStore((s) => s.refreshInstalled);
  const ensureBuiltinMarketplace = usePluginStore((s) => s.ensureBuiltinMarketplace);
  const setSource = useExtensionSourceStore((s) => s.setSource);

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
        {unreadable && <ul className="mt-2 max-h-40 overflow-y-auto text-minor break-all">{unreadable.backupPaths.map(file => <li key={file}>{file}</li>)}</ul>}
        {unreadable ? <Button size="sm" className="mt-3" disabled={recovering} onClick={() => setArchiveOpen(true)}>{t.toolbox.pluginsArchiveContinue}</Button> : <Button size="sm" className="mt-3" disabled={recovering} onClick={() => {
          setRecovering(true);
          void bootstrapPluginUpdates().catch(() => {}).finally(() => setRecovering(false));
        }}>{t.toolbox.pluginsRetryRecovery}</Button>}
      </div>}
      <ConfirmDialog open={archiveOpen && unreadable !== null} title={t.toolbox.pluginsArchiveContinue}
        message={<><p>{t.toolbox.pluginsArchiveWarning}</p><ul className="mt-2 max-h-40 overflow-y-auto break-all">{unreadable?.backupPaths.map(file => <li key={file}>{file}</li>)}</ul></>}
        confirmText={t.toolbox.pluginsArchiveContinue} cancelText={t.common.cancel} confirmDisabled={recovering}
        onCancel={() => { if (!archiving.current) setArchiveOpen(false); }} onConfirm={() => {
          if (!unreadable || archiving.current) return;
          archiving.current = true; setRecovering(true);
          void archivePluginOperation(unreadable.fingerprint).then(async result => {
            setArchiveResult(result); setArchiveOpen(false); await bootstrapPluginUpdates();
          }).catch(error => usePluginStore.setState({ recoveryError: String(error) }))
            .finally(() => { archiving.current = false; setRecovering(false); });
        }} />
      {archiveResult && <div role="status" className="mx-8 mb-4 rounded-xl border border-[var(--abu-border)] p-4 text-minor break-all">
        <p>{t.toolbox.pluginsArchivedNotice}</p><p>{archiveResult.archivedPath}</p>
        <ul className="max-h-40 overflow-y-auto">{archiveResult.backupPaths.map(file => <li key={file}>{file}</li>)}</ul>
      </div>}
      {/* One shelf at a time: 「我的」 is what this user has — the plugins they
          installed and the ones they created here, in one list — 「市场」 the
          marketplaces they browse. The sub-nav above names which. */}
      {home !== null && (source === 'mine'
        ? <InstalledPluginList home={home} searchQuery={searchQuery} childCount={authoredCount} onBrowseMarketplace={() => setSource('plugins', 'market')}>
            <AuthoredPluginList home={home} searchQuery={searchQuery} onVisibleCount={setAuthoredCount} />
          </InstalledPluginList>
        : <section>
            <MarketplaceBrowser
              home={home}
              requestedMarket={requestedMarket}
              searchQuery={searchQuery}
              onAddMarketplace={() => setAddOpen(true)}
              scrollParent={scrollParent ?? undefined}
            />
          </section>)}

      {home !== null && (
        // The new market is browsed on the 市场 shelf, and `requestedMarket` is
        // consumed by MarketplaceBrowser — which 「我的」 does not mount. Adding
        // one from 「我的」 without this switch closes the dialog onto an
        // unchanged authored list: a silent no-op.
        <AddMarketplaceDialog
          onAdded={name => { setSource('plugins', 'market'); setRequestedMarket({ name }); }}
          open={addOpen} home={home} onClose={() => setAddOpen(false)}
        />
      )}
    </div>
  );
}
