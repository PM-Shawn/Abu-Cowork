import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { InlineMessage } from '@/components/ds/inline-message';
import { bootstrapPluginUpdates, usePluginStore } from '@/stores/pluginStore';
import { useI18n } from '@/i18n';
import { archivePluginOperation } from '@/core/plugin/operationBridge';
import AuthoredPluginList from './AuthoredPluginList';
import InstalledPluginList from './InstalledPluginList';
import MarketplaceBrowser from './MarketplaceBrowser';
import AddMarketplaceDialog from './AddMarketplaceDialog';
import { focusAddButton, focusIsOnWindow } from './cardFocus';
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
  const confirm = useConfirm();
  const [scrollParent, setScrollParent] = useState<HTMLDivElement | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [requestedMarket, setRequestedMarket] = useState<{ name: string }>();
  const [addOpen, setAddOpen] = useState(false);
  // What had the focus when the add window was asked for: the page's 「添加」 button, or the
  // empty market's own button, which is gone once a marketplace has been added.
  const addOpener = useRef<Element | null>(null);
  const openAdd = () => { addOpener.current = document.activeElement; setAddOpen(true); };
  useEffect(() => { if (addTrigger > 0) { addOpener.current = document.activeElement; setAddOpen(true); } }, [addTrigger]);
  const [recovering, setRecovering] = useState(false);
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

  // Recovery succeeded: its message leaves with the button that was pressed. The focus goes to the page's 「添加」.
  const hadRecoveryError = useRef(false);
  useLayoutEffect(() => {
    if (hadRecoveryError.current && !recoveryError && focusIsOnWindow()) focusAddButton();
    hadRecoveryError.current = Boolean(recoveryError);
  }, [recoveryError]);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Archiving stops the automatic recovery of an operation record that cannot be read. It is
  // asked first, with the backup paths the user has to keep; the answer acts on the record that
  // is unreadable at that moment. The question outlives the page when the view changes under it:
  // an answer given then archives nothing, because the notice with the paths could not be shown.
  const archive = async () => {
    const asked = usePluginStore.getState().unreadableOperation;
    if (!asked || archiving.current) return;
    const confirmed = await confirm({
      title: t.toolbox.pluginsArchiveContinue,
      message: `${t.toolbox.pluginsArchiveWarning} ${asked.backupPaths.join('、')}`,
      confirmLabel: t.toolbox.pluginsArchiveContinue,
    });
    const current = usePluginStore.getState().unreadableOperation;
    if (!confirmed || !mounted.current || !current || current.fingerprint !== asked.fingerprint || archiving.current) return;
    archiving.current = true; setRecovering(true);
    void archivePluginOperation(current.fingerprint).then(async result => {
      setArchiveResult(result); await bootstrapPluginUpdates();
    }).catch(error => usePluginStore.setState({ recoveryError: String(error) }))
      .finally(() => { archiving.current = false; setRecovering(false); });
  };

  return (
    <div ref={setScrollParent} className="h-full overflow-y-auto overlay-scroll pb-6">
      {recoveryError && <div className="mx-8 mb-4">
        <InlineMessage
          tone="danger"
          action={unreadable
            ? <Button size="sm" busy={recovering} onClick={() => { void archive(); }}>{t.toolbox.pluginsArchiveContinue}</Button>
            : <Button size="sm" busy={recovering} onClick={() => {
              setRecovering(true);
              void bootstrapPluginUpdates().catch(() => {}).finally(() => setRecovering(false));
            }}>{t.toolbox.pluginsRetryRecovery}</Button>}
        >
          <p>{t.toolbox.pluginsRecoveryNeeded}</p>
          <p className="mt-1 break-words text-ui-sm text-label-secondary">{recoveryError}</p>
          {unreadable && <ul className="mt-2 max-h-40 overflow-y-auto break-all font-code text-ui-sm text-label-secondary">{unreadable.backupPaths.map(file => <li key={file}>{file}</li>)}</ul>}
        </InlineMessage>
      </div>}
      {archiveResult && <div className="mx-8 mb-4">
        <InlineMessage tone="success">
          <p>{t.toolbox.pluginsArchivedNotice}</p>
          <p className="break-all font-code text-ui-sm text-label-secondary">{archiveResult.archivedPath}</p>
          <ul className="max-h-40 overflow-y-auto break-all font-code text-ui-sm text-label-secondary">{archiveResult.backupPaths.map(file => <li key={file}>{file}</li>)}</ul>
        </InlineMessage>
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
              onAddMarketplace={openAdd}
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
          onCloseAutoFocus={(event) => {
            const from = addOpener.current;
            // Another layer took the focus, or the button that opened the window is still there and gets it back.
            if (event.defaultPrevented || (from !== null && from !== document.body && from.isConnected)) return;
            event.preventDefault();
            (scrollParent?.querySelector<HTMLElement>('[data-marketplace-toolbar] button') ?? null)?.focus();
            if (focusIsOnWindow()) focusAddButton();
          }}
        />
      )}
    </div>
  );
}
