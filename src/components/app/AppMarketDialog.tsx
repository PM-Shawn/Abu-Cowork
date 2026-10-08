/**
 * 应用市场 — what the switcher's 查看更多 opens (product brief §2.1, features
 * 3, 4, 36, 38, 39, 40).
 *
 * Lists the apps of every market the user has (the official one first), each
 * with 使用, or 进入 and 更新 once added; an app that needs a newer Abu says so
 * and cannot be used. The top carries 添加市场 and 从文件夹添加, and the markets
 * the user added, each with 移除. Adding goes through the shared confirmation
 * (`AppAddConfirmDialog`).
 */

import { useEffect, useMemo, useState } from 'react';
import { homeDir } from '@tauri-apps/api/path';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, FolderOpen, LayoutGrid, Loader2, Plus, Search, X } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import AddMarketplaceDialog from '@/components/toolbox/plugins/AddMarketplaceDialog';
import AppLogo from './AppLogo';

function matches(listing: AppListing, query: string): boolean {
  if (!query) return true;
  return [listing.name, listing.description ?? '', ...listing.uses].join(' ').toLowerCase().includes(query);
}

export default function AppMarketDialog() {
  const { t, format } = useI18n();
  const open = useAppStore((s) => s.appMarketOpen);
  const setOpen = useAppStore((s) => s.setAppMarketOpen);
  const addedApps = useAppStore((s) => s.addedApps);
  const enterApp = useAppStore((s) => s.enterApp);
  const startAdd = useAppAddFlowStore((s) => s.start);
  const flow = useAppAddFlowStore((s) => s.flow);
  const marketplaces = usePluginStore((s) => s.marketplaces);
  const refreshInstalled = usePluginStore((s) => s.refreshInstalled);
  const ensureBuiltinMarketplace = usePluginStore((s) => s.ensureBuiltinMarketplace);
  const installed = usePluginStore((s) => s.installed);
  const teams = useTeamStore((s) => s.teams);
  const agents = useDiscoveryStore((s) => s.agents);
  const [home, setHome] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [listing, setListing] = useState<AppMarketListing | null>(null);
  const [addingMarket, setAddingMarket] = useState(false);
  const [removingMarket, setRemovingMarket] = useState<string | null>(null);
  // Bumped once markets added by address have been fetched again, so the list is read anew.
  const [fetchedAt, setFetchedAt] = useState(0);
  const onClose = () => setOpen(false);

  // The same bootstrap 扩展 → 插件 does on mount: the app market is often the
  // first market surface a user opens, and without it there is no market to
  // read and no plugin records to resolve an app's references against.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    let cancelled = false;
    void homeDir().then(async (dir) => {
      if (cancelled) return;
      setHome(dir);
      await refreshInstalled(dir);
      await refreshFetchedMarkets(dir);
      if (!cancelled) setFetchedAt((value) => value + 1);
    });
    void resolveBuiltinMarketDir().then((marketDir) => {
      if (!cancelled && marketDir) ensureBuiltinMarketplace(marketDir);
    });
    return () => { cancelled = true; };
  }, [open, refreshInstalled, ensureBuiltinMarketplace]);

  // Re-read whenever the markets change, a flow finishes (an app was added or
  // updated), or what references resolve against changes.
  const flowClosed = flow.kind === 'closed';
  useEffect(() => {
    if (!open || !flowClosed) return;
    let cancelled = false;
    const markets = [...marketplaces].sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)));
    void loadAppListings(markets, liveRefCatalog()).then((result) => { if (!cancelled) setListing(result); });
    return () => { cancelled = true; };
  }, [open, marketplaces, installed, teams, agents, flowClosed, fetchedAt]);

  const visible = useMemo(() => (listing?.listings ?? []).filter((item) => matches(item, query.trim().toLowerCase())), [listing, query]);
  const addedById = useMemo(() => new Map(addedApps.map((app) => [app.appId, app])), [addedApps]);
  const userMarkets = marketplaces.filter((market) => !market.builtin);

  const addFromFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== 'string') return;
    await startAdd({ kind: 'folder', dir: picked }, getBaseName(picked), 'preview');
  };

  const row = (item: AppListing) => {
    const added = addedById.get(item.appId);
    const canUpdate = added !== undefined && item.version !== undefined && added.version !== item.version && !item.needsUpgrade;
    return (
      <div key={item.appId} data-testid="app-market-entry" data-app-id={item.appId} className="flex h-full flex-col gap-2 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] p-3">
        <div className="flex items-start gap-3">
          <AppLogo name={item.name} logo={item.logo} logoDark={item.logoDark} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-body font-medium text-[var(--abu-text-primary)]">{item.name}</p>
            {item.description && <p className="line-clamp-2 text-minor text-[var(--abu-text-tertiary)]">{item.description}</p>}
          </div>
        </div>
        {item.uses.length > 0 && <p className="line-clamp-2 text-caption text-[var(--abu-text-muted)]">{format(t.appMarket.uses, { names: item.uses.join('、') })}</p>}
        <div className="mt-auto flex items-center justify-end gap-2">
          {item.invalid && <span className="text-caption text-[var(--abu-danger)]" title={item.invalid}>{t.appMarket.invalidApp}</span>}
          {!item.invalid && item.needsUpgrade && <span data-testid="app-market-needs-upgrade" className="text-caption text-[var(--abu-warning)]">{t.appMarket.needsUpgrade}</span>}
          {added ? (
            <>
              {canUpdate && <Button size="xs" className="h-7 px-2.5" data-testid="app-market-update" onClick={() => void startAdd({ kind: 'market', market: item.market, entry: item.entry }, item.name, 'update')}>{t.appMarket.update}</Button>}
              <Button variant="tint" size="xs" className="h-7 px-2.5" data-testid="app-market-enter" onClick={() => enterApp(item.appId)}>{t.appMarket.enter}</Button>
            </>
          ) : (
            <Button
              variant="tint"
              size="xs"
              className="h-7 px-2.5"
              data-testid="app-market-use"
              disabled={Boolean(item.invalid) || item.needsUpgrade}
              onClick={() => void startAdd({ kind: 'market', market: item.market, entry: item.entry }, item.name, 'add')}
            >
              {t.appMarket.use}
            </Button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      <ToolDetailModal
        open={open}
        onClose={onClose}
        ariaLabel={t.appMarket.title}
        testId="app-market-dialog"
        title={t.appMarket.title}
        subtitle={t.appMarket.subtitle}
        maxWidth="max-w-4xl"
        panelClassName="h-[70vh]"
        headerActions={
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--abu-text-muted)]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.appMarket.searchPlaceholder}
              aria-label={t.appMarket.searchPlaceholder}
              data-testid="app-market-search"
              className="h-8 pl-8"
            />
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" data-testid="app-market-add-market" onClick={() => setAddingMarket(true)} disabled={home === null}>
              <Plus className="h-3.5 w-3.5" />{t.appMarket.addMarket}
            </Button>
            <Button size="sm" variant="outline" data-testid="app-market-from-folder" onClick={() => void addFromFolder()}>
              <FolderOpen className="h-3.5 w-3.5" />{t.appMarket.fromFolder}
            </Button>
            {listing && <span className="ml-auto text-minor text-[var(--abu-text-muted)]">{format(t.appMarket.entryCount, { count: visible.length })}</span>}
          </div>

          {userMarkets.length > 0 && (
            <div data-testid="app-market-markets" className="flex flex-wrap items-center gap-2">
              <span className="text-caption text-[var(--abu-text-tertiary)]">{t.appMarket.marketsTitle}</span>
              {userMarkets.map((market) => (
                <span key={market.name} data-testid="app-market-market" className="inline-flex items-center gap-1 rounded-full bg-[var(--abu-bg-muted)] py-0.5 pl-2.5 pr-1 text-caption text-[var(--abu-text-secondary)]">
                  {market.name}
                  <button
                    type="button"
                    data-testid={`app-market-remove-market-${market.name}`}
                    aria-label={`${t.appMarket.removeMarket}: ${market.name}`}
                    title={t.appMarket.removeMarket}
                    onClick={() => setRemovingMarket(market.name)}
                    className="rounded-full p-0.5 hover:bg-[var(--abu-bg-active)]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {listing?.failures.map(({ market, message }) => (
            <div key={market.name} role="alert" className="flex items-start gap-2 rounded-lg bg-[var(--abu-danger-bg)] p-3 text-minor text-[var(--abu-danger)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{market.name}: {message}</span>
            </div>
          ))}

          {listing === null ? (
            <p className="flex items-center gap-2 py-8 text-body text-[var(--abu-text-tertiary)]"><Loader2 className="h-4 w-4 animate-spin" />{t.common.loading}</p>
          ) : visible.length === 0 ? (
            <div data-testid="app-market-empty" className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <LayoutGrid className="h-8 w-8 text-[var(--abu-text-placeholder)]" />
              <p className="text-h-sm text-[var(--abu-text-primary)]">{t.appMarket.emptyTitle}</p>
              <p className="max-w-md text-body text-[var(--abu-text-tertiary)]">{t.appMarket.emptyHint}</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4" data-testid="app-market-list">
              {visible.map(row)}
            </div>
          )}
        </div>
      </ToolDetailModal>

      {home !== null && (
        <AddMarketplaceDialog open={addingMarket} home={home} onClose={() => setAddingMarket(false)} />
      )}

      <ConfirmDialog
        open={removingMarket !== null}
        title={format(t.appMarket.removeMarketTitle, { name: removingMarket ?? '' })}
        message={t.appMarket.removeMarketMessage}
        confirmText={t.appMarket.removeMarket}
        cancelText={t.common.cancel}
        variant="danger"
        onConfirm={() => {
          if (removingMarket && home !== null) void removeMarket(removingMarket, home);
          setRemovingMarket(null);
        }}
        onCancel={() => setRemovingMarket(null)}
      />
    </>
  );
}
