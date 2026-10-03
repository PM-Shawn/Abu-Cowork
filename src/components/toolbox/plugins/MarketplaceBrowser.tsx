/** Marketplace rows remain in place after installation. Refresh keeps the
 * last readable listing visible, but only a fresh listing can plan installs.
 * Every install consumes an immutable preview after explicit confirmation.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Virtuoso } from 'react-virtuoso';
import { useI18n, format } from '@/i18n';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Select } from '@/components/ds/select';
import { Spinner } from '@/components/ds/spinner';
import { BUSY } from '@/components/ds/styles';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toastStore';
import { cleanupPluginConfiguration, usePluginStore } from '@/stores/pluginStore';
import { useAppStore } from '@/stores/appStore';
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
import { focusIsOnWindow, pluginCardIndex, pluginCardOrNeighbour, pluginCardProps, type PluginCardKind } from './cardFocus';

/** The centred content column, the width the 「我的」 shelf has. `gutter` is the page's side padding. */
function Column({ gutter, className, children }: { gutter: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn(gutter, className)}>
      <div className="mx-auto w-full max-w-5xl">{children}</div>
    </div>
  );
}

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
  /**
   * Which half of a marketplace this render is for. `plugins` (the 扩展 page)
   * lists everything except apps; `apps` (the app market dialog) lists only
   * apps. A package never shows up on both, so a user browsing plugins is
   * never handed an app and the other way round.
   */
  mode?: 'plugins' | 'apps';
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

/** What a card calls this package: an app is known by its own name, not its package id. */
function entryLabel(entry: MarketplaceEntry): string {
  return entry.displayName ?? entry.name;
}

function matchesQuery(entry: MarketplaceEntry, query: string): boolean {
  if (!query) return true;
  const haystack = [
    entry.name,
    entry.displayName ?? '',
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
  mode = 'plugins',
}: MarketplaceBrowserProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const ask = useConfirm();
  const enterApp = useAppStore((s) => s.enterApp);
  const enterInstalledApp = useAppStore((s) => s.enterAppWhenAvailable);
  const appsOnly = mode === 'apps';
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
  const [flow, setFlow] = useState<InstallFlow>({ kind: 'closed' });
  const [installing, setInstalling] = useState(false);
  const [managing, setManaging] = useState<InstalledPlugin | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<InstalledPlugin | null>(null);

  // Keyboard focus. The card a window was opened from, and for a card that can leave the page
  // (an install whose marketplace is gone) where it sat. An install or an uninstall replaces the
  // card and what was on it, so the control that had the focus may be gone when the window
  // closes: the focus then goes to the card, to what took its place, or to the toolbar.
  const rootRef = useRef<HTMLDivElement>(null);
  const opener = useRef<{ kind: PluginCardKind; id: string; index: number } | null>(null);
  const openedFrom = useRef<Element | null>(null);
  const noteOpener = useCallback((kind: PluginCardKind, id: string) => {
    opener.current = { kind, id, index: rootRef.current ? pluginCardIndex(rootRef.current, kind, id) : -1 };
    openedFrom.current = document.activeElement;
  }, []);
  const focusToolbar = useCallback(() => {
    rootRef.current?.querySelector<HTMLElement>('[data-marketplace-toolbar] button, [data-testid="plugin-add-marketplace-cta"]')?.focus();
  }, []);
  const focusOpener = useCallback(() => {
    const root = rootRef.current;
    const from = opener.current;
    if (!root || !from) return;
    const card = pluginCardOrNeighbour(root, from.kind, from.id, from.kind === 'orphan' ? from.index : -1);
    if (card) card.focus();
    else focusToolbar();
  }, [focusToolbar]);
  const windowOpen = useRef(false);
  useLayoutEffect(() => { windowOpen.current = flow.kind !== 'closed' || managing !== null || uninstallTarget !== null; });
  // Set when an uninstall is asked for: once the record has gone, its card has been replaced.
  const uninstalling = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = uninstalling.current;
    if (key === null || installed.some((plugin) => plugin.key === key)) return;
    uninstalling.current = null;
    if (!windowOpen.current && focusIsOnWindow()) focusOpener();
  }, [installed, focusOpener]);
  // Set when a marketplace was removed: its Remove button went with it.
  const removedMarketplace = useRef(false);
  useLayoutEffect(() => {
    if (!removedMarketplace.current) return;
    removedMarketplace.current = false;
    focusToolbar();
  }, [marketplaces, focusToolbar]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

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

  const visibleEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return (marketplace?.plugins ?? []).filter((entry) => (entry.providesApp === true) === appsOnly && matchesQuery(entry, query));
  }, [marketplace, searchQuery, appsOnly]);

  const handlePlan = useCallback(
    async (entry: MarketplaceEntry) => {
      if (!selected || entriesState.kind !== 'ready') return;
      noteOpener('market', entry.name);
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
    [selected, entriesState.kind, home, tb, releasePreparation, noteOpener],
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
        title: format(existing ? tb.pluginsUpdateSucceeded : tb.pluginsInstallSucceeded, { name: entryLabel(entry) }),
        message: tb.pluginsUpdateReloadHint,
      });
      closeFlow();
      // 「使用」 is install-and-enter: a fresh app install lands the user on its
      // home. The app list refreshes from the records the install just wrote,
      // so the switcher may still be catching up — the store checks the record
      // directly, and an update to an app the user is already in stays put.
      if (flow.disclosure.app && !existing) enterInstalledApp(flow.disclosure.key);
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
  }, [selected, flow, install, update, installedByName, home, addToast, tb, closeFlow, releasePreparation, enterInstalledApp]);

  // One object per flow value: the window compares what it is handed with what it shows, and a
  // new object on every render of this page would make it render twice each time.
  const dialogState = useMemo<InstallPlanState>(() => (
    flow.kind === 'ready'
      ? { kind: 'ready', disclosure: flow.disclosure }
      : flow.kind === 'unsupported'
        ? { kind: 'unsupported', sourceKind: flow.sourceKind }
        : flow.kind === 'error'
          ? { kind: 'error', message: flow.message }
          : { kind: 'loading' }
  ), [flow]);

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
    // An installed app keeps its market card (marked installed by the switch)
    // and offers 进入; an app not yet installed offers 使用, which installs and
    // enters in one step.
    const isApp = entry.providesApp === true;
    if (installedRecord) return <InstalledPluginCard
      plugin={installedRecord}
      home={home}
      control={appsOnly ? 'none' : 'installed'}
      name={entryLabel(entry)}
      description={entry.description}
      testId="plugin-marketplace-entry"
      onClick={() => { noteOpener('market', entry.name); setManaging(installedRecord); }}
      actions={<>
        {hasUpdate && <Button variant="secondary" size="sm" data-testid="plugin-update-button" disabled={entriesState.kind !== 'ready'} aria-label={`${tb.pluginsUpdate}: ${entryLabel(entry)}`} onClick={event => { event.stopPropagation(); void handlePlan(entry); }}>{tb.pluginsUpdate}</Button>}
        {isApp && <Button variant="secondary" size="sm" data-testid="plugin-enter-app" aria-label={`${tb.pluginsEnter}: ${entryLabel(entry)}`} onClick={event => { event.stopPropagation(); enterApp(installedRecord.key); }}>{tb.pluginsEnter}</Button>}
      </>}
    />;
    const installLabel = isApp ? tb.pluginsUse : tb.pluginsInstall;
    return (
      <div className="h-full">
        <MarketplaceEntryRow
          testId="plugin-marketplace-entry"
          name={entryLabel(entry)}
          description={entry.description}
          onClick={() => void handlePlan(entry)}
          actions={<Button variant="secondary" size="sm" disabled={entriesState.kind !== 'ready'} onClick={event => { event.stopPropagation(); void handlePlan(entry); }} aria-label={`${installLabel}: ${entryLabel(entry)}`}>{installLabel}</Button>}
        />
      </div>
    );
  };

  // Removing a marketplace is asked first, by name. The answer acts on what is in the list at
  // that moment: a marketplace that has gone meanwhile is not removed again.
  const askToRemoveMarketplace = async (name: string) => {
    const confirmed = await ask({
      title: tb.pluginsRemoveMarketplaceTitle,
      message: format(tb.pluginsRemoveMarketplaceMessage, { name }),
      confirmLabel: tb.pluginsRemoveMarketplace,
      tone: 'danger',
    });
    if (!confirmed || !mounted.current) return;
    if (!usePluginStore.getState().marketplaces.some((m) => m.name === name)) return;
    removedMarketplace.current = true;
    removeMarketplace(name);
  };

  // The app market sits in a window that has its own side padding; the page brings its own.
  const gutter = appsOnly ? '' : 'px-8';

  if (marketplaces.length === 0) {
    // Adding a market is a plugin-page job, so the app market says where to go
    // rather than offering a button that belongs to another page.
    return (
      <div ref={rootRef} className={cn('flex h-full flex-col items-center justify-center', gutter)}>
        <EmptyState
          icon={AppIcons.bundle}
          title={appsOnly ? t.appMarket.emptyTitle : tb.pluginsNoMarketplaces}
          description={appsOnly ? t.appMarket.emptyHint : tb.pluginsNoMarketplacesHint}
          action={!appsOnly && (
            <Button variant="secondary" icon={AppIcons.add} onClick={onAddMarketplace} data-testid="plugin-add-marketplace-cta">
              {tb.pluginsAddMarketplace}
            </Button>
          )}
        />
      </div>
    );
  }

  const loading = entriesState.kind === 'loading';

  return (
    <div ref={rootRef} className={scrollParent ? "flex flex-col" : "flex h-full flex-col"}>
      <Column gutter={gutter} className="shrink-0 py-3">
        <div data-marketplace-toolbar className="flex flex-wrap items-center gap-2">
          {marketplaces.length > 1 ? (
            <div className="w-56">
              <Select
                fullWidth
                label={tb.pluginsMarketplaceTab}
                value={selectedName ?? ''}
                onValueChange={setSelectedName}
                options={marketplaces.map((m) => ({ value: m.name, label: m.name }))}
              />
            </div>
          ) : (
            <span className="text-ui font-medium text-label">{selectedName}</span>
          )}

          {marketplace && (
            <span className="text-ui-sm text-label-tertiary">
              {format(appsOnly ? t.appMarket.entryCount : tb.pluginsEntryCount, { count: visibleEntries.length })}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* While the list is being read the button takes no press; it stays focusable, so the
                focus stays on it when it was pressed from the keyboard. */}
            {selectedName && (
              <IconButton
                size="sm"
                icon={AppIcons.retry}
                label={tb.pluginsRefreshMarketplace}
                aria-disabled={loading || undefined}
                className={BUSY}
                onClick={() => { if (!loading) setReload(value => value + 1); }}
              />
            )}
            {/* The built-in market cannot be removed (the store short-circuits it),
                so it gets no Remove control rather than one that silently no-ops.
                Managing which markets exist belongs to 扩展 → 插件, so the app
                market dialog shows no Remove either. Keyed by the market: the
                button of a removed market is gone, not handed to the next one. */}
            {selectedName && !selected?.builtin && !appsOnly && (
              <IconButton
                key={selectedName}
                size="sm"
                icon={AppIcons.delete}
                label={tb.pluginsRemoveMarketplace}
                onClick={() => { void askToRemoveMarketplace(selectedName); }}
              />
            )}
          </div>
        </div>
      </Column>

      {entriesState.kind === 'error' && marketplace && (
        <Column gutter={gutter} className="mb-3">
          <InlineMessage tone="danger"><p>{entriesState.message}</p><p>{tb.pluginsCachedMarketplace}</p></InlineMessage>
        </Column>
      )}
      {showList ? (
        // The ready-state list is virtualized: the official marketplace alone
        // has ~291 entries and organization catalogs grow, so only the rows in
        // view are mounted. Virtuoso owns scrolling here, which is why this
        // wrapper has no `overflow-y-auto` of its own.
        <div className={cn('min-h-0 flex-1 pb-6', gutter)}>
          <div ref={gridViewport} className="mx-auto h-full w-full max-w-5xl">
            <Virtuoso
              className={scrollParent ? undefined : "h-full"}
              customScrollParent={scrollParent}
              data-testid="plugin-marketplace-list"
              data={entryRows}
              computeItemKey={(_, row) => row[0].name}
              itemContent={(_, row) => <div className="pb-4"><ToolGrid>{row.map(entry => <div key={entry.name} className="h-full" {...pluginCardProps('market', entry.name)}>{renderEntry(entry)}</div>)}</ToolGrid></div>}
            />
          </div>
        </div>
      ) : (
        <Column gutter={gutter} className="min-h-0 flex-1 overflow-y-auto pb-6">
          {loading && <div className="py-8"><Spinner label={t.common.loading} /></div>}

          {entriesState.kind === 'error' && (
            <div className="mt-4">
              <InlineMessage tone="danger">
                <p className="font-medium">{tb.pluginsMarketplaceReadFailed}</p>
                <p className="break-words text-ui-sm text-label-secondary">
                  {entriesState.message}
                  {marketplace && <span className="block">{tb.pluginsCachedMarketplace}</span>}
                </p>
              </InlineMessage>
            </div>
          )}

          {entriesState.kind === 'ready' && visibleEntries.length === 0 && <EmptyState title={tb.pluginsNoMatches} />}
        </Column>
      )}

      {orphans.length > 0 && !appsOnly && (
        <section
          data-testid="plugin-orphan-group"
          className="shrink-0 border-t border-separator py-3"
        >
          {/* Same centred column as the grid above, or this block sits to the left of the cards. */}
          <Column gutter={gutter}>
            <h4 className="text-ui font-medium text-label">{tb.pluginsOrphanGroup}</h4>
            <p className="text-ui-sm text-label-tertiary">{tb.pluginsOrphanHint}</p>
            <div className="mt-2">
              <ToolGrid>
                {orphans.map((plugin) => (
                  <div key={plugin.key} className="h-full" {...pluginCardProps('orphan', plugin.key)}>
                    <MarketplaceEntryRow
                      testId="plugin-orphan-row"
                      name={plugin.name}
                      description={format(tb.pluginsFromMarketplace, { name: plugin.marketplace })}
                      onClick={() => { noteOpener('orphan', plugin.key); setManaging(plugin); }}
                    />
                  </div>
                ))}
              </ToolGrid>
            </div>
          </Column>
        </section>
      )}

      <InstalledPluginDetail
        plugin={managing}
        description={managing?.marketplace === selected?.name ? marketplace?.plugins.find(entry => entry.name === managing?.name)?.description : undefined}
        home={home}
        onClose={() => setManaging(null)}
        onUninstall={(plugin) => {
          setManaging(null);
          uninstalling.current = plugin.key;
          setUninstallTarget(plugin);
        }}
      />

      <UninstallPluginDialog
        home={home}
        target={uninstallTarget}
        // The window the question came from is gone: the focus goes back to the card it was opened from.
        onClose={() => { setUninstallTarget(null); if (focusIsOnWindow()) focusOpener(); }}
      />

      <InstallDisclosureDialog
        open={flow.kind !== 'closed'}
        entryName={flow.kind === 'closed' ? '' : entryLabel(flow.entry)}
        state={dialogState}
        installing={installing}
        onConfirm={configuration => void handleConfirmInstall(configuration)}
        onCancel={closeFlow}
        onCloseAutoFocus={(event) => {
          const from = openedFrom.current;
          // Another layer took the focus, or the button the window opened from is still there
          // and gets it back. After an install that button is gone: the card takes the focus.
          if (event.defaultPrevented || (from !== null && from !== document.body && from.isConnected)) return;
          event.preventDefault();
          focusOpener();
        }}
      />
    </div>
  );
}
