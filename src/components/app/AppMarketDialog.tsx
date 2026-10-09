/**
 * 应用市场 — what the switcher's 查看更多 opens (product brief §2.1, features
 * 3, 4, 36, 38, 39, 40).
 *
 * Lists the apps of every market the user has (the official one first), each
 * with 使用, or 进入 and 更新 once added; an app that needs a newer Abu says so
 * and cannot be used. The top carries 添加市场 and 从文件夹添加, and the markets
 * the user added, each with 移除. Adding goes through the shared confirmation
 * (`AppAddConfirmDialog`), which opens inside this window.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import { useAppStore } from '@/stores/appStore';
import { useAppAddFlowStore } from '@/stores/appAddFlowStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useTeamStore } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { resolveBuiltinMarketDir } from '@/core/plugin/builtinMarket';
import { refreshFetchedMarkets, removeMarket } from '@/core/plugin/marketSource';
import { loadAppListings, type AppListing, type AppMarketListing } from '@/core/app/appMarket';
import { liveRefCatalog } from '@/core/app/appRefs';
import { getBaseName } from '@/utils/pathUtils';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { TextField } from '@/components/ds/text-field';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import AddMarketplaceDialog from '@/components/toolbox/plugins/AddMarketplaceDialog';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';
import AppAddConfirmDialog from './AppAddConfirmDialog';
import AppLogo from './AppLogo';

function matches(listing: AppListing, query: string): boolean {
  if (!query) return true;
  return [listing.name, listing.description ?? '', ...listing.uses].join(' ').toLowerCase().includes(query);
}

/**
 * One app of a market. memo: a window opening over the list, or another card
 * changing, renders no card again; its callbacks are the same for the life of
 * the window. It mounts no tooltip, menu or select root.
 */
const AppCard = memo(function AppCard({ item, addedVersion, onAdd, onUpdate, onEnter }: {
  item: AppListing;
  /** The version the user has added; `undefined` while the app is not added. */
  addedVersion: string | null | undefined;
  onAdd: (item: AppListing) => void;
  onUpdate: (item: AppListing) => void;
  onEnter: (appId: string) => void;
}) {
  const { t, format } = useI18n();
  const added = addedVersion !== undefined;
  const canUpdate = added && item.version !== undefined && addedVersion !== item.version && !item.needsUpgrade;
  return (
    <div data-testid="app-market-entry" data-app-id={item.appId} className="flex h-full flex-col gap-2 rounded-panel border border-separator bg-surface p-3">
      <div className="flex items-start gap-3">
        <AppLogo name={item.name} logo={item.logo} logoDark={item.logoDark} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-medium text-label">{item.name}</p>
          {item.description && <p className="line-clamp-2 text-ui-sm text-label-secondary">{item.description}</p>}
        </div>
      </div>
      {item.uses.length > 0 && <p className="line-clamp-2 text-caption text-label-tertiary">{format(t.appMarket.uses, { names: item.uses.join('、') })}</p>}
      <div className="mt-auto flex items-center justify-end gap-2">
        {item.invalid && <span className="text-caption text-danger" title={item.invalid}>{t.appMarket.invalidApp}</span>}
        {!item.invalid && item.needsUpgrade && <span data-testid="app-market-needs-upgrade" className="text-caption text-warning">{t.appMarket.needsUpgrade}</span>}
        {added ? (
          <>
            {canUpdate && <Button variant="secondary" size="sm" data-testid="app-market-update" onClick={() => onUpdate(item)}>{t.appMarket.update}</Button>}
            <Button variant="secondary" size="sm" data-testid="app-market-enter" onClick={() => onEnter(item.appId)}>{t.appMarket.enter}</Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            data-testid="app-market-use"
            disabled={Boolean(item.invalid) || item.needsUpgrade}
            onClick={() => onAdd(item)}
          >
            {t.appMarket.use}
          </Button>
        )}
      </div>
    </div>
  );
});

export default function AppMarketDialog() {
  const { t, format } = useI18n();
  const open = useAppStore((s) => s.appMarketOpen);
  const setOpen = useAppStore((s) => s.setAppMarketOpen);
  const addedApps = useAppStore((s) => s.addedApps);
  const enterApp = useAppStore((s) => s.enterApp);
  const startAdd = useAppAddFlowStore((s) => s.start);
  const flowClosed = useAppAddFlowStore((s) => s.flow.kind === 'closed');
  const marketplaces = usePluginStore((s) => s.marketplaces);
  const refreshInstalled = usePluginStore((s) => s.refreshInstalled);
  const ensureBuiltinMarketplace = usePluginStore((s) => s.ensureBuiltinMarketplace);
  const installed = usePluginStore((s) => s.installed);
  const teams = useTeamStore((s) => s.teams);
  const agents = useDiscoveryStore((s) => s.agents);
  const confirm = useConfirm();
  const [home, setHome] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<AppMarketListing | null>(null);
  const [addingMarket, setAddingMarket] = useState(false);
  // Bumped once markets added by address have been fetched again, so the list is read anew.
  const [fetchedAt, setFetchedAt] = useState(0);
  const onClose = () => setOpen(false);
  // The window stays on the page while it fades out; nothing pressed there starts anything.
  const openRef = useRef(open);
  useLayoutEffect(() => { openRef.current = open; });
  const addMarketRef = useRef<HTMLButtonElement>(null);

  // The same bootstrap 扩展 → 插件 does on mount: the app market is often the
  // first market surface a user opens, and without it there is no market to
  // read and no plugin records to resolve an app's references against.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    let cancelled = false;
    homeDir()
      .then(async (dir) => {
        if (cancelled) return;
        setHome(dir);
        await refreshInstalled(dir);
        await refreshFetchedMarkets(dir);
        if (!cancelled) setFetchedAt((value) => value + 1);
      })
      .catch((error) => console.error('[app-market] home directory unavailable', error));
    resolveBuiltinMarketDir()
      .then((marketDir) => {
        if (cancelled || !marketDir) return;
        ensureBuiltinMarketplace(marketDir);
      })
      .catch((error) => console.error('[app-market] built-in market unavailable', error));
    return () => { cancelled = true; };
  }, [open, refreshInstalled, ensureBuiltinMarketplace]);

  // Re-read whenever the markets change, a flow finishes (an app was added or
  // updated), or what references resolve against changes.
  useEffect(() => {
    if (!open || !flowClosed) return;
    let cancelled = false;
    const markets = [...marketplaces].sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)));
    void loadAppListings(markets, liveRefCatalog()).then((result) => { if (!cancelled) setListing(result); });
    return () => { cancelled = true; };
  }, [open, marketplaces, installed, teams, agents, flowClosed, fetchedAt]);

  const visible = useMemo(() => (listing?.listings ?? []).filter((item) => matches(item, query.trim().toLowerCase())), [listing, query]);
  const addedVersionById = useMemo(() => new Map(addedApps.map((app) => [app.appId, app.version])), [addedApps]);
  const userMarkets = marketplaces.filter((market) => !market.builtin);

  // The cards are memo: what they call stays the same while the window renders.
  const add = useCallback((item: AppListing) => {
    if (!openRef.current) return;
    void startAdd({ kind: 'market', market: item.market, entry: item.entry }, item.name, 'add');
  }, [startAdd]);
  const update = useCallback((item: AppListing) => {
    if (!openRef.current) return;
    void startAdd({ kind: 'market', market: item.market, entry: item.entry }, item.name, 'update');
  }, [startAdd]);
  const enter = useCallback((appId: string) => {
    if (!openRef.current) return;
    enterApp(appId);
  }, [enterApp]);

  const addFromFolder = async () => {
    if (!openRef.current) return;
    const picked = await openDialog({ directory: true, multiple: false });
    // The folder dialog can outlast the window.
    if (typeof picked !== 'string' || !openRef.current) return;
    await startAdd({ kind: 'folder', dir: picked }, getBaseName(picked), 'preview');
  };

  // Set when a market was removed: its 移除 button went with it, and 添加市场 takes the focus.
  const removedMarket = useRef(false);
  useLayoutEffect(() => {
    if (!removedMarket.current) return;
    removedMarket.current = false;
    if (focusIsOnWindow() || !document.activeElement?.isConnected) addMarketRef.current?.focus();
  }, [marketplaces]);
  // Removing a market is asked first, by name. The answer acts on what is in the list at that
  // moment: a market that has gone meanwhile is not removed again.
  const askToRemoveMarket = async (name: string) => {
    if (!openRef.current || home === null) return;
    const confirmed = await confirm({
      title: format(t.appMarket.removeMarketTitle, { name }),
      message: t.appMarket.removeMarketMessage,
      confirmLabel: t.appMarket.removeMarket,
      tone: 'danger',
    });
    if (!confirmed || !openRef.current) return;
    if (!usePluginStore.getState().marketplaces.some((market) => market.name === name && !market.builtin)) return;
    removedMarket.current = true;
    // The market leaves the list at once; a copy fetched by address is deleted after it.
    void removeMarket(name, home);
  };

  return (
    <ToolDetailModal
      open={open}
      onClose={onClose}
      onCloseAutoFocus={() => {
        // The control that opened the window may be gone by now (a notice above the composer, a
        // menu item). Once the window has handed the focus back: when nothing took it, the
        // switcher's button does.
        queueMicrotask(() => {
          if (focusIsOnWindow()) document.querySelector<HTMLElement>('[data-testid="app-switcher-trigger"]')?.focus();
        });
      }}
      ariaLabel={t.appMarket.title}
      testId="app-market-dialog"
      title={t.appMarket.title}
      subtitle={t.appMarket.subtitle}
      maxWidth="max-w-4xl"
      // The list scrolls inside a fixed height, so the window keeps its size while the markets are read.
      panelClassName="h-120"
      headerActions={
        <div className="relative w-56">
          <Icon icon={AppIcons.search} size="sm" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-label-tertiary" />
          <TextField
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t.appMarket.searchPlaceholder}
            aria-label={t.appMarket.searchPlaceholder}
            data-testid="app-market-search"
            className="pl-7"
          />
        </div>
      }
    >
      <div className="flex h-full flex-col gap-3">
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button ref={addMarketRef} variant="secondary" size="sm" icon={AppIcons.add} data-testid="app-market-add-market" onClick={() => { if (openRef.current) setAddingMarket(true); }} disabled={home === null}>
            {t.appMarket.addMarket}
          </Button>
          <Button variant="secondary" size="sm" icon={AppIcons.folderOpen} data-testid="app-market-from-folder" onClick={() => void addFromFolder()}>
            {t.appMarket.fromFolder}
          </Button>
          {listing && <span className="ml-auto text-ui-sm text-label-tertiary">{format(t.appMarket.entryCount, { count: visible.length })}</span>}
        </div>

        {userMarkets.length > 0 && (
          <div data-testid="app-market-markets" className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="text-caption text-label-tertiary">{t.appMarket.marketsTitle}</span>
            {userMarkets.map((market) => (
              // Keyed by the market: the button of a removed market is gone, not handed to the next one.
              <span key={market.name} data-testid="app-market-market" className="inline-flex items-center gap-1 rounded-control bg-fill pl-2 text-ui-sm text-label-secondary">
                {market.name}
                <IconButton
                  size="sm"
                  icon={AppIcons.close}
                  label={`${t.appMarket.removeMarket}: ${market.name}`}
                  data-testid={`app-market-remove-market-${market.name}`}
                  onClick={() => { void askToRemoveMarket(market.name); }}
                />
              </span>
            ))}
          </div>
        )}

        {listing?.failures.map(({ market, message }) => (
          <div key={market.name} className="shrink-0">
            <InlineMessage tone="danger"><span className="break-words">{market.name}: {message}</span></InlineMessage>
          </div>
        ))}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listing === null ? (
            <div className="py-8"><Spinner label={t.common.loading} /></div>
          ) : visible.length === 0 ? (
            <div data-testid="app-market-empty">
              <EmptyState icon={AppIcons.appMarket} title={t.appMarket.emptyTitle} description={t.appMarket.emptyHint} />
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4" data-testid="app-market-list">
              {visible.map((item) => (
                <AppCard key={item.appId} item={item} addedVersion={addedVersionById.get(item.appId)} onAdd={add} onUpdate={update} onEnter={enter} />
              ))}
            </div>
          )}
        </div>
      </div>

      {home !== null && (
        <AddMarketplaceDialog open={addingMarket} home={home} onClose={() => setAddingMarket(false)} />
      )}
      <AppAddConfirmDialog within="market" />
    </ToolDetailModal>
  );
}
