/**
 * Browse a local marketplace and install from it.
 *
 * Two decisions worth keeping:
 *
 * 1. **Entries are read from disk on every mount / marketplace switch**, never
 *    cached in the store. The official marketplace is a git clone the user can
 *    `git pull`; a cached listing would offer packages that are no longer
 *    there.
 * 2. **`planInstall` and `installPlugin` are separated by a user decision.**
 *    Clicking Install only *plans* — it reads the manifest and shows the
 *    disclosure. Nothing is written until the user confirms in the dialog.
 *    This is the invariant the tests pin: no confirmation, no `installPlugin`.
 *
 * Most entries in the real world (~82% of the 291 in `claude-plugins-official`)
 * are remote git sources. Those now install too: `planInstall` fetches the
 * package (sha-verified, in the main process) before disclosing it, so the
 * user still reads the real contents before confirming. `UnsupportedSourceError`
 * remains only as the graceful degradation when no fetcher is wired (headless
 * surfaces) — it renders as an explanatory notice, not a toast-shaped failure.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Package, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { useToastStore } from '@/stores/toastStore';
import { usePluginStore } from '@/stores/pluginStore';
import { planInstall, UnsupportedSourceError, type InstallDisclosure } from '@/core/plugin/installer';
import { fetchRemotePluginSource } from '@/core/plugin/remoteFetch';
import { entryUpdateStatus } from '@/core/plugin/updateCheck';
import {
  resolveRename,
  type Marketplace,
  type MarketplaceEntry,
  type PluginSource,
} from '@/core/plugin/marketplace';
import { loadMarketplaceFromDir } from './loadMarketplace';
import InstallDisclosureDialog, { type InstallPlanState } from './InstallDisclosureDialog';

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
  /** Shared toolbox header search box — 291 entries are unusable without it. */
  searchQuery: string;
  onAddMarketplace: () => void;
}

type EntriesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; marketplace: Marketplace }
  | { kind: 'error'; message: string };

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
  onAddMarketplace,
}: MarketplaceBrowserProps) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const marketplaces = usePluginStore((s) => s.marketplaces);
  const removeMarketplace = usePluginStore((s) => s.removeMarketplace);
  const installed = usePluginStore((s) => s.installed);
  const install = usePluginStore((s) => s.install);
  const update = usePluginStore((s) => s.update);
  const addToast = useToastStore((s) => s.addToast);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [entriesState, setEntriesState] = useState<EntriesState>({ kind: 'idle' });
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [flow, setFlow] = useState<InstallFlow>({ kind: 'closed' });
  const [installing, setInstalling] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  /**
   * Bumped on every new plan request and on every close. A `planInstall` that
   * resolves after its epoch is stale (the user cancelled, or moved on to
   * another entry) is dropped instead of writing itself over the current flow —
   * the same staleness guard the marketplace-load effect above uses, which the
   * async plan path was missing.
   */
  const planEpochRef = useRef(0);
  useEffect(() => () => void (planEpochRef.current += 1), []);

  const closeFlow = useCallback(() => {
    planEpochRef.current += 1;
    setFlow({ kind: 'closed' });
  }, []);

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
    setEntriesState({ kind: 'loading' });
    setCategory(ALL_CATEGORIES);
    loadMarketplaceFromDir(selected.dir)
      .then((marketplace) => {
        if (!cancelled) setEntriesState({ kind: 'ready', marketplace });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEntriesState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const marketplace = entriesState.kind === 'ready' ? entriesState.marketplace : null;

  /**
   * Names already installed *from this marketplace*, resolved through the
   * marketplace's rename table so a plugin installed under its old name still
   * reads as installed after an upstream rename.
   */
  const installedByName = useMemo(() => {
    const renames = marketplace?.renames ?? {};
    const byName = new Map<string, typeof installed[number]>();
    for (const p of installed) {
      if (p.marketplace !== selected?.name) continue;
      byName.set(resolveRename(p.name, renames), p);
    }
    return byName;
  }, [installed, marketplace, selected]);

  const installedNames = useMemo(() => {
    if (!marketplace) return new Set<string>();
    return new Set(
      installed
        .filter((p) => p.marketplace === marketplace.name)
        .map((p) => resolveRename(p.name, marketplace.renames)),
    );
  }, [installed, marketplace]);

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
      if (!selected) return;
      const epoch = (planEpochRef.current += 1);
      setFlow({ kind: 'planning', entry });
      try {
        const disclosure = await planInstall({
          marketplaceName: selected.name,
          marketplaceDir: selected.dir,
          entry,
          home,
          // Remote sources are fetched (sha-verified, in the main process)
          // before disclosure, so what the user reads is what will install.
          fetchRemote: fetchRemotePluginSource,
        });
        if (planEpochRef.current !== epoch) return; // superseded or cancelled
        setFlow({ kind: 'ready', entry, disclosure });
      } catch (err) {
        if (planEpochRef.current !== epoch) return; // superseded or cancelled
        // Remote-source entries are the majority of a real marketplace, so
        // this branch is a first-class outcome with its own explanation.
        if (err instanceof UnsupportedSourceError) {
          setFlow({ kind: 'unsupported', entry, sourceKind: err.kind });
          return;
        }
        setFlow({
          kind: 'error',
          entry,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [selected, home],
  );

  const handleConfirmInstall = useCallback(async () => {
    if (!selected || flow.kind !== 'ready') return;
    const { entry } = flow;
    const existing = installedByName.get(entry.name);
    setInstalling(true);
    try {
      if (existing) {
        await update({
          home,
          marketplaceName: selected.name,
          marketplaceDir: selected.dir,
          entry,
          key: existing.key,
        });
      } else {
        await install({
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
      addToast({
        type: 'error',
        title: tb.pluginsInstallFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInstalling(false);
    }
  }, [selected, flow, install, update, installedByName, home, addToast, tb, closeFlow]);

  const dialogState: InstallPlanState =
    flow.kind === 'ready'
      ? { kind: 'ready', disclosure: flow.disclosure }
      : flow.kind === 'unsupported'
        ? { kind: 'unsupported', sourceKind: flow.sourceKind }
        : flow.kind === 'error'
          ? { kind: 'error', message: flow.message }
          : { kind: 'loading' };

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
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-8 py-3">
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
          <Button
            variant="ghost"
            size="sm"
            onClick={onAddMarketplace}
            data-testid="plugin-add-marketplace-open"
          >
            <Plus className="h-3.5 w-3.5" />
            {tb.pluginsAddMarketplace}
          </Button>
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
              </p>
            </div>
          </div>
        )}

        {entriesState.kind === 'ready' && visibleEntries.length === 0 && (
          <p className="py-8 text-center text-body text-[var(--abu-text-tertiary)]">
            {tb.pluginsNoMatches}
          </p>
        )}

        {entriesState.kind === 'ready' && visibleEntries.length > 0 && (
          <ul className="space-y-1.5">
            {visibleEntries.map((entry) => {
              const isInstalled = installedNames.has(entry.name);
              const updateStatus = entryUpdateStatus(entry, installedByName.get(entry.name));
              const hasUpdate = updateStatus === 'update-available';
              return (
                <li
                  key={entry.name}
                  data-testid="plugin-marketplace-entry"
                  className="flex items-start gap-3 rounded-lg border border-[var(--abu-border)] px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-h-xs text-[var(--abu-text-primary)]">
                        {entry.name}
                      </span>
                      {entry.version && (
                        <span className="shrink-0 text-caption text-[var(--abu-text-muted)]">
                          v{entry.version}
                        </span>
                      )}
                      {entry.category && (
                        <span className="shrink-0 rounded-full bg-[var(--abu-bg-muted)] px-2 py-0.5 text-caption text-[var(--abu-text-tertiary)]">
                          {entry.category}
                        </span>
                      )}
                      {/* Most of a real marketplace (238 of the official 291)
                          is remote-sourced: installing one fetches it from git
                          (sha-verified) rather than copying a local folder, so
                          the row flags it up front. */}
                      {entry.source.kind !== 'relative' && (
                        <span
                          data-testid="plugin-remote-source-badge"
                          className="shrink-0 rounded-full bg-[var(--abu-warning-bg)] px-2 py-0.5 text-caption text-[var(--abu-warning)]"
                        >
                          {tb.pluginsRemoteSourceBadge}
                        </span>
                      )}
                    </div>
                    {entry.description && (
                      <p className="mt-0.5 line-clamp-2 text-minor text-[var(--abu-text-tertiary)]">
                        {entry.description}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant={hasUpdate ? 'default' : isInstalled ? 'outline' : 'default'}
                    disabled={isInstalled && !hasUpdate}
                    data-testid={hasUpdate ? 'plugin-update-button' : undefined}
                    onClick={() => void handlePlan(entry)}
                    aria-label={`${
                      hasUpdate ? tb.pluginsUpdate : isInstalled ? tb.pluginsAlreadyInstalled : tb.pluginsInstall
                    }: ${entry.name}`}
                  >
                    {hasUpdate ? tb.pluginsUpdate : isInstalled ? tb.pluginsAlreadyInstalled : tb.pluginsInstall}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <InstallDisclosureDialog
        open={flow.kind !== 'closed'}
        entryName={flow.kind === 'closed' ? '' : flow.entry.name}
        state={dialogState}
        installing={installing}
        onConfirm={() => void handleConfirmInstall()}
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
