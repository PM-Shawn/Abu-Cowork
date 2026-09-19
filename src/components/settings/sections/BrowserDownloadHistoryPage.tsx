import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FolderOpen, LoaderCircle, Search } from 'lucide-react';
import { exists } from '@tauri-apps/plugin-fs';
import { formatBytes } from '@/core/permissions/browserUploadFiles';
import { loadMessages, type ConversationMeta } from '@/core/session/conversationStorage';
import { format, useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { CapabilityBreadcrumb } from './CapabilitySetupView';
import {
  filterBrowserDownloadHistoryRows,
  projectBrowserDownloadHistory,
  type BrowserDownloadAvailability,
  type BrowserDownloadConversationSnapshot,
  type BrowserDownloadHistoryOmission,
  type BrowserDownloadHistoryRow,
} from './browserDownloadHistoryProjection';

const HISTORY_READ_CONCURRENCY = 4;

async function mapConcurrently<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await map(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function eligibleConversation(meta: ConversationMeta): boolean {
  return meta.readOnly !== true && meta.importedFrom === undefined;
}

async function checkAvailability(path: string): Promise<BrowserDownloadAvailability> {
  try {
    return await exists(path) ? 'completed' : 'unavailable';
  } catch {
    return 'unknown';
  }
}

export function BrowserDownloadHistoryEntry({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onOpen}
      aria-label={t.settings.browserDownloadsTitle}
      className="h-auto w-full items-center justify-start gap-3 whitespace-normal rounded-lg border border-[var(--abu-border)] bg-transparent p-4 text-left hover:bg-[var(--abu-bg-hover)]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-[var(--abu-text-primary)]">
          {t.settings.browserDownloadsTitle}
        </span>
        <span className="mt-1 block text-minor font-normal leading-relaxed text-[var(--abu-text-muted)]">
          {t.settings.browserDownloadsEntryDesc}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-[var(--abu-text-muted)]" aria-hidden="true" />
    </Button>
  );
}

function availabilityCopy(
  availability: BrowserDownloadAvailability,
  settings: ReturnType<typeof useI18n>['t']['settings'],
): { label: string; className: string } {
  if (availability === 'completed') {
    return {
      label: settings.browserDownloadsCompleted,
      className: 'bg-[var(--abu-success-bg)] text-[var(--abu-success)]',
    };
  }
  if (availability === 'unavailable') {
    return {
      label: settings.browserDownloadsUnavailable,
      className: 'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)]',
    };
  }
  return {
    label: settings.browserDownloadsUnknown,
    className: 'bg-[var(--abu-bg-active)] text-[var(--abu-text-muted)]',
  };
}

function DownloadRow({
  row,
  checking,
  onFileAction,
  onOpenTask,
}: {
  row: BrowserDownloadHistoryRow;
  checking: boolean;
  onFileAction: (row: BrowserDownloadHistoryRow, action: 'open' | 'reveal') => void;
  onOpenTask: (row: BrowserDownloadHistoryRow) => void;
}) {
  const { t, locale } = useI18n();
  const status = availabilityCopy(row.availability, t.settings);
  const available = row.availability === 'completed' && !checking;
  const recordedAt = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(row.recordedAt));
  return (
    <li className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <Button type="button" variant="link" disabled={!available}
          onClick={() => onFileAction(row, 'open')}
          aria-label={format(t.settings.browserDownloadsOpenFileLabel, { file: row.name })}
          title={row.name}
          className="h-auto max-w-full justify-start truncate p-0 text-body font-medium text-[var(--abu-text-primary)]">
          {row.name}
        </Button>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-[var(--abu-text-muted)]">
          <span>{formatBytes(row.bytes)}</span>
          <span className="max-w-64 truncate" title={row.sourceOrigin}>{row.sourceOrigin}</span>
          <Button type="button" variant="link" size="sm" onClick={() => onOpenTask(row)}
            className="h-auto max-w-64 justify-start truncate p-0 text-caption text-[var(--abu-text-muted)]"
            aria-label={format(t.settings.browserDownloadsOpenTaskLabel, { task: row.conversationTitle })}>
            {row.conversationTitle}
          </Button>
        </div>
        {(checking || row.availability !== 'completed') && (
          <p className={`mt-1 inline-flex items-center gap-1 text-caption ${status.className}`}>
            {checking && <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />}
            {checking ? t.settings.browserDownloadsChecking : status.label}
          </p>
        )}
      </div>
      <time className="shrink-0 text-minor text-[var(--abu-text-muted)]" dateTime={new Date(row.recordedAt).toISOString()}>{recordedAt}</time>
      <Button type="button" variant="ghost" size="sm" disabled={!available}
        onClick={() => onFileAction(row, 'reveal')}
        aria-label={format(t.settings.browserDownloadsRevealLabel, { file: row.name })}
        title={t.settings.browserDownloadsReveal} className="size-8 shrink-0 p-0 text-[var(--abu-text-muted)]">
        <FolderOpen className="size-4" aria-hidden="true" />
      </Button>
    </li>
  );
}

function OmissionNotes({ omissions }: { omissions: BrowserDownloadHistoryOmission[] }) {
  const { t } = useI18n();
  if (omissions.length === 0) return null;
  return (
    <ul className="space-y-1 border-t border-[var(--abu-border)] pt-3 text-minor text-[var(--abu-text-tertiary)]">
      {omissions.map((omission) => (
        <li key={omission.key}>
          {format(t.settings.browserDownloadsOmitted, {
            task: omission.conversationTitle,
            count: omission.count,
          })}
        </li>
      ))}
    </ul>
  );
}

export function BrowserDownloadHistoryPage({
  trail,
  onNavigate,
  query,
  onQueryChange,
}: {
  trail: string[];
  onNavigate: (index: number) => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const { t, locale } = useI18n();
  const conversationIndex = useChatStore((state) => state.conversationIndex);
  const openPreview = usePreviewStore((state) => state.openPreview);
  const closeSystemSettings = useSettingsStore((state) => state.closeSystemSettings);
  const [rows, setRows] = useState<BrowserDownloadHistoryRow[]>([]);
  const [omissions, setOmissions] = useState<BrowserDownloadHistoryOmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingKeys, setCheckingKeys] = useState<Set<string>>(() => new Set());
  const [taskUnavailable, setTaskUnavailable] = useState(false);
  const [historyReadFailures, setHistoryReadFailures] = useState(0);
  const [reloadRevision, setReloadRevision] = useState(0);
  const loadGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    const mounted = mountedRef;
    const actionGeneration = actionGenerationRef;
    mounted.current = true;
    return () => {
      mounted.current = false;
      actionGeneration.current++;
    };
  }, []);

  const metas = useMemo(() => Object.values(conversationIndex)
    .filter(eligibleConversation)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)), [conversationIndex]);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    // A new authoritative history snapshot invalidates file/task actions
    // started from the rows it replaces, even though this page stays mounted.
    actionGenerationRef.current++;
    let cancelled = false;
    setLoading(true);
    setCheckingKeys(new Set());
    setTaskUnavailable(false);
    setHistoryReadFailures(0);

    const current = () => !cancelled && loadGenerationRef.current === generation;
    void (async () => {
      const results = await mapConcurrently(
        metas,
        HISTORY_READ_CONCURRENCY,
        async (meta): Promise<{
          snapshot: BrowserDownloadConversationSnapshot;
          failed: boolean;
        }> => {
          try {
            return {
              snapshot: { meta, messages: await loadMessages(meta.id) },
              failed: false,
            };
          } catch {
            return {
              snapshot: { meta, messages: [] },
              failed: true,
            };
          }
        },
      );
      if (!current()) return;
      const projection = projectBrowserDownloadHistory(results.map((result) => result.snapshot));
      const checkedRows = await mapConcurrently(
        projection.rows,
        HISTORY_READ_CONCURRENCY,
        async (row) => ({ ...row, availability: await checkAvailability(row.path) }),
      );
      if (!current()) return;
      setRows(checkedRows);
      setOmissions(projection.omissions);
      setHistoryReadFailures(results.filter((result) => result.failed).length);
      setLoading(false);
    })().catch(() => {
      if (!current()) return;
      setRows([]);
      setOmissions([]);
      setHistoryReadFailures(metas.length);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [metas, reloadRevision]);

  const visibleRows = useMemo(
    () => filterBrowserDownloadHistoryRows(rows, query),
    [query, rows],
  );
  const filtersActive = query.trim() !== '';
  const everyHistoryReadFailed = metas.length > 0 && historyReadFailures === metas.length;

  const updateAvailability = (key: string, availability: BrowserDownloadAvailability) => {
    setRows((current) => current.map((row) => (
      row.key === key ? { ...row, availability } : row
    )));
  };

  const runFileAction = async (
    row: BrowserDownloadHistoryRow,
    action: 'open' | 'reveal',
  ) => {
    const generation = ++actionGenerationRef.current;
    const current = () => mountedRef.current && actionGenerationRef.current === generation;
    setCheckingKeys(new Set([row.key]));
    const availability = await checkAvailability(row.path);
    if (!current()) return;
    updateAvailability(row.key, availability);
    if (availability === 'completed') {
      if (action === 'open') {
        closeSystemSettings();
        openPreview(row.path);
      } else {
        try {
          const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
          if (!current()) return;
          await revealItemInDir(row.path);
        } catch {
          if (!current()) return;
          updateAvailability(row.key, 'unknown');
        }
      }
    }
    if (!current()) return;
    setCheckingKeys((currentKeys) => {
      const next = new Set(currentKeys);
      next.delete(row.key);
      return next;
    });
  };

  const openTask = async (row: BrowserDownloadHistoryRow) => {
    const currentMeta = useChatStore.getState().conversationIndex[row.conversationId];
    if (!currentMeta || !eligibleConversation(currentMeta)) {
      setTaskUnavailable(true);
      return;
    }
    const generation = ++actionGenerationRef.current;
    setTaskUnavailable(false);
    try {
      await useChatStore.getState().switchConversation(row.conversationId);
    } catch {
      if (mountedRef.current && actionGenerationRef.current === generation) {
        setTaskUnavailable(true);
      }
      return;
    }
    if (!mountedRef.current || actionGenerationRef.current !== generation) return;
    closeSystemSettings();
  };

  const groups = new Map<string, BrowserDownloadHistoryRow[]>();
  for (const row of visibleRows) {
    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(row.recordedAt));
    const group = groups.get(date) ?? [];
    group.push(row);
    groups.set(date, group);
  }

  return (
    <div className="space-y-5">
      <CapabilityBreadcrumb trail={trail} onNavigate={onNavigate} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
        <h3 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
          {t.settings.browserDownloadsTitle}
        </h3>
        <p className="mt-1 max-w-2xl text-minor leading-relaxed text-[var(--abu-text-muted)]">
          {t.settings.browserDownloadsDesc}
        </p>
        {taskUnavailable && (
          <p role="status" className="mt-1 text-minor text-[var(--abu-warning)]">
            {t.settings.browserDownloadsTaskUnavailable}
          </p>
        )}
        </div>
        {rows.length > 0 && <div className="relative w-56 max-w-full shrink-0">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--abu-text-muted)]" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t.settings.browserDownloadsSearchPlaceholder}
            aria-label={t.settings.browserDownloadsSearchLabel}
            className="h-8 w-full rounded-lg pl-8 text-minor"
          />
        </div>}
      </div>

      <div className="space-y-5">
        {!loading && historyReadFailures > 0 && (
          <div
            role="status"
            className="mb-3 flex flex-wrap items-center gap-2 border-t border-[var(--abu-border)] pt-3"
          >
            <p className="min-w-0 flex-1 text-minor text-[var(--abu-warning)]">
              {everyHistoryReadFailed
                ? t.settings.browserDownloadsReadFailed
                : t.settings.browserDownloadsPartialRead}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReloadRevision((revision) => revision + 1)}
              className="shrink-0 border-[var(--abu-border)] bg-[var(--abu-bg-base)]"
            >
              {t.settings.browserDownloadsReadAgain}
            </Button>
          </div>
        )}
        {loading ? (
          <p role="status" className="py-8 text-center text-minor text-[var(--abu-text-tertiary)]">
            {t.settings.browserDownloadsLoading}
          </p>
        ) : everyHistoryReadFailed ? null : rows.length === 0 ? (
          <p className="py-8 text-center text-minor text-[var(--abu-text-tertiary)]">
            {t.settings.browserDownloadsEmpty}
          </p>
        ) : visibleRows.length === 0 ? (
          <div className="border-t border-[var(--abu-border)] pt-3">
            <p className="text-minor text-[var(--abu-text-tertiary)]">
              {t.settings.browserDownloadsNoResults}
            </p>
            {filtersActive && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onQueryChange('')}
                className="mt-2 border-[var(--abu-border)] bg-[var(--abu-bg-base)]"
              >
                {t.settings.browserDownloadsClearSearch}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {[...groups].map(([date, entries]) => (
              <section key={date} className="rounded-xl border border-[var(--abu-border)] px-4">
                <h4 className="border-b border-[var(--abu-border)] py-3 text-body font-medium text-[var(--abu-text-primary)]">{date}</h4>
                <ul className="divide-y divide-[var(--abu-border)]">
                  {entries.map((row) => (
                    <DownloadRow key={row.key} row={row} checking={checkingKeys.has(row.key)}
                      onFileAction={(item, action) => void runFileAction(item, action)}
                      onOpenTask={(item) => void openTask(item)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
        {!loading && <OmissionNotes omissions={omissions} />}
      </div>
    </div>
  );
}
