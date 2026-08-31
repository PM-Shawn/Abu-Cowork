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
 * point at remote git sources this build cannot fetch, so `UnsupportedSourceError`
 * is a *normal* outcome, not an exception path — it renders as an explanatory
 * notice in the same dialog rather than a toast-shaped failure.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Package, Plus, Trash2, AlertTriangle } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { useToastStore } from '@/stores/toastStore';
import { usePluginStore } from '@/stores/pluginStore';
import { planInstall, UnsupportedSourceError } from '@/core/plugin/installer';
import { resolveRename, type Marketplace, type MarketplaceEntry } from '@/core/plugin/marketplace';
import { loadMarketplaceFromDir } from './loadMarketplace';
import InstallDisclosureDialog, { type InstallPlanState } from './InstallDisclosureDialog';

const ALL_CATEGORIES = '__all__';

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
  const addToast = useToastStore((s) => s.addToast);

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [entriesState, setEntriesState] = useState<EntriesState>({ kind: 'idle' });
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const [pendingEntry, setPendingEntry] = useState<MarketplaceEntry | null>(null);
  const [planState, setPlanState] = useState<InstallPlanState>({ kind: 'loading' });
  const [installing, setInstalling] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  // Keep the selection valid as marketplaces are added/removed.
  useEffect(() => {
    if (marketplaces.length === 0) {
      setSelectedName(null);
      return;
    }
    if (!selectedName || !marketplaces.some((m) => m.name === selectedName)) {
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
      setPendingEntry(entry);
      setPlanState({ kind: 'loading' });
      try {
        const disclosure = await planInstall({
          marketplaceName: selected.name,
          marketplaceDir: selected.dir,
          entry,
        });
        setPlanState({ kind: 'ready', disclosure });
      } catch (err) {
        // Remote-source entries are the majority of a real marketplace, so
        // this branch is a first-class outcome with its own explanation.
        if (err instanceof UnsupportedSourceError) {
          setPlanState({ kind: 'unsupported', sourceKind: err.kind });
          return;
        }
        setPlanState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [selected],
  );

  const handleConfirmInstall = useCallback(async () => {
    if (!selected || !pendingEntry || planState.kind !== 'ready') return;
    setInstalling(true);
    try {
      await install({
        home,
        marketplaceName: selected.name,
        marketplaceDir: selected.dir,
        entry: pendingEntry,
      });
      addToast({
        type: 'success',
        title: format(tb.pluginsInstallSucceeded, { name: pendingEntry.name }),
      });
      setPendingEntry(null);
    } catch (err) {
      addToast({
        type: 'error',
        title: tb.pluginsInstallFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setInstalling(false);
    }
  }, [selected, pendingEntry, planState.kind, install, home, addToast, tb]);

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
          <Button variant="ghost" size="sm" onClick={onAddMarketplace}>
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
                          is remote-sourced and cannot install yet. Saying so
                          on the row beats letting the user find out only
                          after clicking Install; the button stays live so the
                          full explanation is still one click away. */}
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
                    variant={isInstalled ? 'outline' : 'default'}
                    disabled={isInstalled}
                    onClick={() => void handlePlan(entry)}
                    aria-label={`${isInstalled ? tb.pluginsAlreadyInstalled : tb.pluginsInstall}: ${entry.name}`}
                  >
                    {isInstalled ? tb.pluginsAlreadyInstalled : tb.pluginsInstall}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <InstallDisclosureDialog
        open={pendingEntry !== null}
        entryName={pendingEntry?.name ?? ''}
        state={planState}
        installing={installing}
        onConfirm={() => void handleConfirmInstall()}
        onCancel={() => setPendingEntry(null)}
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
