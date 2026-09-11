/** Marketplace rows remain in place after installation. Refresh keeps the
 * last readable listing visible, but only a fresh listing can plan installs.
 * Every install consumes an immutable preview after explicit confirmation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { Loader2, Package, Plus, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { useToastStore } from '@/stores/toastStore';
import { cleanupPluginConfiguration, usePluginStore } from '@/stores/pluginStore';
import { pluginConfigFields, savePluginConfiguration } from '@/core/plugin/configuration';
import { orphanedInstalls } from '@/core/plugin/authored';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { planInstall, releasePreparedInstall, UnsupportedSourceError, type InstallDisclosure } from '@/core/plugin/installer';
import { PluginSymlinkRootError } from '@/core/plugin/fsOps';
import { fetchRemotePluginSource } from '@/core/plugin/remoteFetch';
import { installedByEntryName } from '@/core/plugin/updateCheck';
import { pluginKey } from '@/core/plugin/paths';
import {
  type Marketplace,
  type MarketplaceEntry,
  type PluginSource,
} from '@/core/plugin/marketplace';
import { loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';
import InstallDisclosureDialog, { type InstallPlanState } from './InstallDisclosureDialog';
import MarketplaceEntryRow from './MarketplaceEntryRow';
import InstalledPluginCard from './InstalledPluginCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import InstalledPluginDetail from './InstalledPluginDetail';
import UninstallPluginDialog from './UninstallPluginDialog';

const ALL_CATEGORIES = '__all__';

/**
 * The whole install-disclosure flow as one value. `pendingEntry` (is the dialog
 * open?) and the plan result used to be two independent states, which let them
 * disagree: the dialog could be open for entry B while the plan data still
 * described entry A. Carrying the entry *inside* every non-closed state makes
 * that mismatch unrepresentable — the dialog can only ever show a plan that
 * belongs to the entry it is open for.
 */
type InstallFlow =
  | { kind: 'closed' }
  | { kind: 'planning'; entry: MarketplaceEntry }
  | { kind: 'ready'; entry: MarketplaceEntry; disclosure: InstallDisclosure }
  | { kind: 'unsupported'; entry: MarketplaceEntry; sourceKind: PluginSource['kind'] }
  | { kind: 'error'; entry: MarketplaceEntry; message: string };

interface MarketplaceBrowserProps {
  home: string;
  scrollParent?: HTMLElement;
  /** Shared toolbox header search box — 291 entries are unusable without it. */
  searchQuery: string;
  requestedMarket?: { name: string };
  onAddMarketplace: () => void;
}

type EntriesState =
  | { kind: 'idle' }
  | { kind: 'loading'; marketplace?: Marketplace }
  | { kind: 'ready'; marketplace: Marketplace }
  | { kind: 'error'; message: string; marketplace?: Marketplace };

function authorName(author: MarketplaceEntry['author']): string | undefined {
  if (!author) return undefined;
  return typeof author === 'string' ? author : author.name;
}

function matchesQuery(entry: MarketplaceEntry, query: string): boolean {
  if (!query) return true;
  const haystack = [
    entry.name,
    entry.description ?? '',
    entry.category ?? '',
    authorName(entry.author) ?? '',
    ...(entry.keywords ?? []),
    ...(entry.tags ?? []),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export default function MarketplaceBrowser({
  home,
  searchQuery,
  requestedMarket,
  onAddMarketplace,
  scrollParent,
}: MarketplaceBrowserProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const marketplaces = usePluginStore((s) => s.marketplaces);
  const removeMarketplace = usePluginStore((s) => s.removeMarketplace);
  const installed = usePluginStore((s) => s.installed);
  const install = usePluginStore((s) => s.install);
  const update = usePluginStore((s) => s.update);
  const recomputeUpdates = usePluginStore((s) => s.recomputeUpdates);
  const updateAvailableKeys = usePluginStore((s) => s.updateAvailableKeys);
  const addToast = useToastStore((s) => s.addToast);

  const cachedMarkets = useRef(new Map<string, Marketplace>());
  const [reload, setReload] = useState(0);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  useEffect(() => { if (requestedMarket) setSelectedName(requestedMarket.name); }, [requestedMarket]);
  const [entriesState, setEntriesState] = useState<EntriesState>({ kind: 'idle' });
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [flow, setFlow] = useState<InstallFlow>({ kind: 'closed' });
  const [installing, setInstalling] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [managing, setManaging] = useState<InstalledPlugin | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPlugin | null>(null);

  /**
   * Bumped on every new plan request and on every close. A `planInstall` that
   * resolves after its epoch is stale (the user cancelled, or moved on to
   * another entry) is dropped instead of writing itself over the current flow —
   * the same staleness guard the marketplace-load effect above uses, which the
   * async plan path was missing.
   */
  const planEpochRef = useRef(0);
  const preparedTokenRef = useRef<string | undefined>(undefined);
  const installingRef = useRef(false);
  const releasePreparation = useCallback(() => {
    const token = preparedTokenRef.current;
    preparedTokenRef.current = undefined;
    if (token) void releasePreparedInstall(token).catch(() => {});
  }, []);
  useEffect(() => () => { planEpochRef.current += 1; releasePreparation(); }, [releasePreparation]);

  const closeFlow = useCallback(() => {
    planEpochRef.current += 1;
    releasePreparation();
    setFlow({ kind: 'closed' });
  }, [releasePreparation]);

  // Keep the selection valid as marketplaces are added/removed, and land the
  // user on a market they just added. User markets are appended last (the
  // built-in abu-official is prepended), so when the list grows the newest
  // entry is last — select it, otherwise adding a market while abu-official is
  // selected would leave the user staring at abu-official's plugins instead of
  // the one they just added.
  const prevMarketCount = useRef(0);
  useEffect(() => {
    if (marketplaces.length === 0) {
      setSelectedName(null);
      prevMarketCount.current = 0;
      return;
    }
    const grew = marketplaces.length > prevMarketCount.current;
    prevMarketCount.current = marketplaces.length;
    if (grew || !selectedName || !marketplaces.some((m) => m.name === selectedName)) {
      setSelectedName(marketplaces[marketplaces.length - 1].name);
    }
  }, [marketplaces, selectedName]);

  const selected = useMemo(
    () => marketplaces.find((m) => m.name === selectedName) ?? null,
    [marketplaces, selectedName],
  );

  useEffect(() => {
    if (!selected) {
      setEntriesState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setEntriesState({ kind: 'loading', marketplace: cachedMarkets.current.get(selected.dir) });
    setCategory(ALL_CATEGORIES);
    loadMarketplaceFromDir(selected.dir)
      .then((marketplace) => {
        if (marketplace.name !== selected.name) throw new Error(tb.pluginsMarketplaceIdentityChanged);
        if (!cancelled) { cachedMarkets.current.set(selected.dir, marketplace); setEntriesState({ kind: 'ready', marketplace }); }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEntriesState({
          kind: 'error',
          marketplace: cachedMarkets.current.get(selected.dir),
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selected, reload, tb.pluginsMarketplaceIdentityChanged]);

  const marketplace = entriesState.kind === 'ready' || entriesState.kind === 'error' || entriesState.kind === 'loading' ? entriesState.marketplace ?? null : null;

  /**
   * Names already installed *from this marketplace*, resolved through the
   * marketplace's rename table so a plugin installed under its old name still
   * reads as installed after an upstream rename.
   */
  const installedByName = useMemo(
    () => installedByEntryName(installed, selected?.name ?? '', marketplace?.renames),
    [installed, marketplace, selected],
  );

  // Opening the market panel is one of the three moments the update badge is
  // recomputed (the others: app start, and after an install/uninstall inside
  // the store). It scans EVERY added market, not just the displayed one, so
  // the count is the union rather than "whatever was browsed last" — and the
  // rows below read their 「更新」 state from the same store keys, so the badge
  // and the buttons cannot disagree.
  //
  // `installed` IS a dep: the rows read their update state only from the store,
  // so a panel opened before the boot-time hydrate lands would show every row
  // as up-to-date forever — the first scan ran against an empty `installed` and
  // nothing re-runs it. Redundant scans are the store's problem, not this
  // effect's: `recomputeUpdates` carries a `recomputeSeq` guard that drops
  // whatever a superseded scan computes.
  useEffect(() => {
    void recomputeUpdates(home);
  }, [recomputeUpdates, home, marketplaces, installed, reload]);

  /** Store keys are `pluginKey(entryName, marketName)` — see `updateCheck`. */
  const updateKeySet = useMemo(() => new Set(updateAvailableKeys), [updateAvailableKeys]);

  /**
   * Installs whose marketplace is no longer in the user's list. Only asked
   * once the built-in market is present: `orphanedInstalls` cannot tell "no
   * markets" from "markets have not hydrated yet", and the built-in entry is
   * re-injected right after hydration (it is stripped by the store's
   * `partialize`), so its arrival is the signal that the list is real.
   */
  const marketsHydrated = useMemo(() => marketplaces.some((m) => m.builtin), [marketplaces]);
  const orphans = useMemo(
    // No join against the author list: orphanedInstalls reads provenance off
    // the record itself, so a failed author-store read can no longer relabel a
    // locally created plugin as a market plugin whose source is gone.
    () => (marketsHydrated ? orphanedInstalls(installed, marketplaces) : []),
    [marketsHydrated, installed, marketplaces],
  );

  const categoryOptions = useMemo(() => {
    const names = new Set<string>();
    for (const entry of marketplace?.plugins ?? []) {
      if (entry.category) names.add(entry.category);
    }
    return [
      { value: ALL_CATEGORIES, label: tb.pluginsCategoryAll },
      ...[...names].sort().map((name) => ({ value: name, label: name })),
    ];
  }, [marketplace, tb.pluginsCategoryAll]);

  const visibleEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return (marketplace?.plugins ?? []).filter(
      (entry) =>
        (category === ALL_CATEGORIES || entry.category === category) && matchesQuery(entry, query),
    );
  }, [marketplace, category, searchQuery]);

  const handlePlan = useCallback(
    async (entry: MarketplaceEntry) => {
      if (!selected || entriesState.kind !== 'ready') return;
      releasePreparation();
      const epoch = (planEpochRef.current += 1);
      setFlow({ kind: 'planning', entry });
      try {
        const disclosure = await planInstall({
          prepareSnapshot: true,
          marketplaceName: selected.name,
          marketplaceDir: selected.dir,
          entry,
          home,
          // Remote sources are fetched (sha-verified, in the main process)
          // before disclosure, so what the user reads is what will install.
          fetchRemote: fetchRemotePluginSource,
        });
        if (planEpochRef.current !== epoch) {
          if (disclosure.preparedToken) await releasePreparedInstall(disclosure.preparedToken).catch(() => {});
          return;
        }
        preparedTokenRef.current = disclosure.preparedToken;
        setFlow({ kind: 'ready', entry, disclosure });
      } catch (err) {
        if (planEpochRef.current !== epoch) return; // superseded or cancelled
        // Remote-source entries are the majority of a real marketplace, so
        // this branch is a first-class outcome with its own explanation.
        if (err instanceof UnsupportedSourceError) {
          setFlow({ kind: 'unsupported', entry, sourceKind: err.kind });
          return;
        }
        // A package whose own directory is a link is a refusal we can explain,
        // not a read failure. Mapped from the error TYPE here — the dialog is
        // purely presentational and only ever receives a finished string.
        if (err instanceof PluginSymlinkRootError) {
          setFlow({
            kind: 'error',
            entry,
            message: format(tb.pluginsSymlinkRootRefused, { path: err.dir }),
          });
          return;
        }
        setFlow({
          kind: 'error',
          entry,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [selected, entriesState.kind, home, tb, releasePreparation],
  );

  const handleConfirmInstall = useCallback(async (configuration: Record<string, string>) => {
    if (!selected || flow.kind !== 'ready' || installingRef.current) return;
    const { entry } = flow;
    const preparedToken = flow.disclosure.preparedToken;
    if (!preparedToken) return;
    const existing = installedByName.get(entry.name);
    setInstalling(true);
    installingRef.current = true;
    preparedTokenRef.current = undefined;
    let pluginConfiguration: string | undefined;
    try {
      pluginConfiguration = await savePluginConfiguration(flow.disclosure.key, pluginConfigFields(flow.disclosure.manifest.mcpServers), configuration);
      if (existing) {
        await update({
          preparedToken,
          pluginConfiguration,
          enableMcp: true,
          home,
          marketplaceName: selected.name,
          marketplaceDir: selected.dir,
          entry,
          key: existing.key,
        });
      } else {
        await install({
          preparedToken,
          pluginConfiguration,
          enableMcp: true,
          home,
          marketplaceName: selected.name,
          marketplaceDir: selected.dir,
          entry,
        });
      }
      addToast({
        type: 'success',
        title: format(existing ? tb.pluginsUpdateSucceeded : tb.pluginsInstallSucceeded, { name: entry.name }),
        message: tb.pluginsUpdateReloadHint,
      });
      closeFlow();
    } catch (err) {
      releasePreparation();
      setFlow({ kind: 'error', entry, message: err instanceof Error ? err.message : String(err) });
      addToast({
        type: 'error',
        title: tb.pluginsInstallFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      await releasePreparedInstall(preparedToken).catch(() => {});
      await cleanupPluginConfiguration(pluginConfiguration);
      installingRef.current = false;
      setInstalling(false);
    }
  }, [selected, flow, install, update, installedByName, home, addToast, tb, closeFlow, releasePreparation]);

  const dialogState: InstallPlanState =
    flow.kind === 'ready'
      ? { kind: 'ready', disclosure: flow.disclosure }
      : flow.kind === 'unsupported'
        ? { kind: 'unsupported', sourceKind: flow.sourceKind }
        : flow.kind === 'error'
          ? { kind: 'error', message: flow.message }
          : { kind: 'loading' };

  const showList = marketplace !== null && visibleEntries.length > 0;

  // Virtualize complete grid rows: their heights may differ when disclosure
  // chips wrap. Virtuoso measures each row instead of assuming equal card heights.
  const gridViewport = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(3);
  useEffect(() => {
    const element = gridViewport.current;
    if (!showList || !element) return;
    const observer = new ResizeObserver(([entry]) => {
      setColumns(Math.max(1, Math.floor((entry.contentRect.width + 16) / 256)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showList]);
  const entryRows = useMemo(() => Array.from(
    { length: Math.ceil(visibleEntries.length / columns) },
    (_, index) => visibleEntries.slice(index * columns, (index + 1) * columns),
  ), [visibleEntries, columns]);

  // Plugin cards reuse the released toolbox geometry; the grid owns spacing.
  const renderEntry = (entry: MarketplaceEntry) => {
    // "Installed" is read from the record map, not a separate name set: the
    // row's menu acts on that exact record, so a row that claims to be
    // installed without one would offer 管理/卸载 that quietly do nothing.
    const installedRecord = installedByName.get(entry.name);
    // Read from the store rather than scored here: one source of truth for the
    // badge count and this button (see the recompute effect above).
    const hasUpdate = !!selected && updateKeySet.has(pluginKey(entry.name, selected.name));
    if (installedRecord) return <InstalledPluginCard
      plugin={installedRecord}
      home={home}
      description={entry.description}
      testId="plugin-marketplace-entry"
      onClick={() => setManaging(installedRecord)}
      actions={hasUpdate ? <Button size="sm" data-testid="plugin-update-button" disabled={entriesState.kind !== 'ready'} aria-label={`${tb.pluginsUpdate}: ${entry.name}`} onClick={event => { event.stopPropagation(); void handlePlan(entry); }}>{tb.pluginsUpdate}</Button> : undefined}
    />;
    return (
      <div className="h-full">
        <MarketplaceEntryRow
          testId="plugin-marketplace-entry"
          name={entry.name}
          description={entry.description}
          onClick={() => void handlePlan(entry)}
          actions={<Button size="sm" disabled={entriesState.kind !== 'ready'} onClick={event => { event.stopPropagation(); void handlePlan(entry); }} aria-label={`${tb.pluginsInstall}: ${entry.name}`}>{tb.pluginsInstall}</Button>}
        />
      </div>
    );
  };

  if (marketplaces.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <Package className="h-8 w-8 text-[var(--abu-text-placeholder)]" />
        <p className="text-h-sm text-[var(--abu-text-primary)]">{tb.pluginsNoMarketplaces}</p>
        <p className="max-w-md text-body text-[var(--abu-text-tertiary)]">
          {tb.pluginsNoMarketplacesHint}
        </p>
        <Button className="mt-1" onClick={onAddMarketplace} data-testid="plugin-add-marketplace-cta">
          <Plus className="h-3.5 w-3.5" />
          {tb.pluginsAddMarketplace}
        </Button>
      </div>
    );
  }

  return (
    <div className={scrollParent ? "flex flex-col" : "flex h-full flex-col"}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-8 py-3 w-full max-w-[1088px] mx-auto">
        {marketplaces.length > 1 ? (
          <Select
            variant="inline"
            value={selectedName ?? ''}
            onChange={setSelectedName}
            ariaLabel={tb.pluginsMarketplaceTab}
            options={marketplaces.map((m) => ({ value: m.name, label: m.name }))}
            className="w-56"
          />
        ) : (
          <span className="text-h-xs text-[var(--abu-text-primary)]">{selectedName}</span>
        )}

        <Select
          variant="inline"
          value={category}
          onChange={setCategory}
          ariaLabel={tb.pluginsCategoryAll}
          options={categoryOptions}
          className="w-44"
        />

        {marketplace && (
          <span className="text-minor text-[var(--abu-text-muted)]">
            {format(tb.pluginsEntryCount, { count: visibleEntries.length })}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {selectedName && <Button size="icon-sm" variant="ghost" aria-label={tb.pluginsRefreshMarketplace} disabled={entriesState.kind === 'loading'} onClick={() => setReload(value => value + 1)}><RefreshCw className="h-3.5 w-3.5" /></Button>}
          {selectedName && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tb.pluginsRemoveMarketplace}
              title={tb.pluginsRemoveMarketplace}
              onClick={() => setRemoveTarget(selectedName)}
            >
              <Trash2 className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
            </Button>
          )}
        </div>
      </div>

      {entriesState.kind === 'error' && marketplace && <div role="alert" className="mx-8 mb-3 rounded-lg bg-[var(--abu-danger-bg)] p-3 text-minor text-[var(--abu-danger)]"><p>{entriesState.message}</p><p>{tb.pluginsCachedMarketplace}</p></div>}
      {showList ? (
        // The ready-state list is virtualized: the official marketplace alone
        // has ~291 entries and organization catalogs grow, so only the rows in
        // view are mounted. Virtuoso owns scrolling here, which is why this
        // wrapper has no `overflow-y-auto` of its own.
        <div ref={gridViewport} className="min-h-0 flex-1 px-8 pb-6 w-full max-w-[1088px] mx-auto">
          <Virtuoso
            className={scrollParent ? undefined : "h-full"}
            customScrollParent={scrollParent}
            data-testid="plugin-marketplace-list"
            data={entryRows}
            computeItemKey={(_, row) => row[0].name}
            itemContent={(_, row) => <div className="pb-4"><ToolGrid>{row.map(entry => <div key={entry.name} className="h-full">{renderEntry(entry)}</div>)}</ToolGrid></div>}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-6">
          {entriesState.kind === 'loading' && (
            <p className="flex items-center gap-2 py-8 text-body text-[var(--abu-text-tertiary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.common.loading}
            </p>
          )}

          {entriesState.kind === 'error' && (
            <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-[var(--abu-danger-bg)] p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-danger)]" />
              <div className="min-w-0">
                <p className="text-h-xs text-[var(--abu-text-primary)]">
                  {tb.pluginsMarketplaceReadFailed}
                </p>
                <p className="mt-1 break-words text-minor text-[var(--abu-text-tertiary)]">
                  {entriesState.message}
                  {marketplace && <span className="block">{tb.pluginsCachedMarketplace}</span>}
                </p>
              </div>
            </div>
          )}

          {entriesState.kind === 'ready' && visibleEntries.length === 0 && (
            <p className="py-8 text-center text-body text-[var(--abu-text-tertiary)]">
              {tb.pluginsNoMatches}
            </p>
          )}
        </div>
      )}

      {orphans.length > 0 && (
        <section
          data-testid="plugin-orphan-group"
          className="shrink-0 border-t border-[var(--abu-border)] px-8 py-3"
        >
          <h4 className="text-h-xs text-[var(--abu-text-primary)]">{tb.pluginsOrphanGroup}</h4>
          <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
            {orphans.map((plugin) => (
              <MarketplaceEntryRow
                key={plugin.key}
                testId="plugin-orphan-row"
                name={plugin.name}
                description={format(tb.pluginsFromMarketplace, { name: plugin.marketplace })}
                onClick={() => setManaging(plugin)}
              />
            ))}
          </div>
        </section>
      )}

      <InstalledPluginDetail
        plugin={managing}
        description={managing?.marketplace === selected?.name ? marketplace?.plugins.find(entry => entry.name === managing?.name)?.description : undefined}
        home={home}
        onClose={() => setManaging(null)}
        onUninstall={(plugin) => {
          setManaging(null);
          setUninstallTarget(plugin);
        }}
      />

      <UninstallPluginDialog
        home={home}
        target={uninstallTarget}
        onClose={() => setUninstallTarget(null)}
      />

      <InstallDisclosureDialog
        open={flow.kind !== 'closed'}
        entryName={flow.kind === 'closed' ? '' : flow.entry.name}
        state={dialogState}
        installing={installing}
        onConfirm={configuration => void handleConfirmInstall(configuration)}
        onCancel={closeFlow}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        title={tb.pluginsRemoveMarketplaceTitle}
        message={format(tb.pluginsRemoveMarketplaceMessage, { name: removeTarget ?? '' })}
        confirmText={tb.pluginsRemoveMarketplace}
        cancelText={t.common.cancel}
        variant="danger"
        onConfirm={() => {
          if (removeTarget) removeMarketplace(removeTarget);
          setRemoveTarget(null);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
