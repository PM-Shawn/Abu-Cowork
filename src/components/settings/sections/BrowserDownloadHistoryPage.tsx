import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { exists } from '@tauri-apps/plugin-fs';
import { formatBytes } from '@/core/permissions/browserUploadFiles';
import { loadMessages, type ConversationMeta } from '@/core/session/conversationStorage';
import { format, useI18n } from '@/i18n';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
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
    <Pressable
      onClick={onOpen}
      // The entry of the history page: the capabilities page gives it the focus when that page is left.
      data-capability-entry="downloads"
      aria-label={t.settings.browserDownloadsTitle}
      className="flex w-full items-center gap-3 rounded-panel border border-separator p-4 text-left hover:bg-fill-hover"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-label">
          {t.settings.browserDownloadsTitle}
        </span>
        <span className="mt-1 block text-ui-sm text-label-secondary">
          {t.settings.browserDownloadsEntryDesc}
        </span>
      </span>
      <Icon icon={AppIcons.disclose} className="text-label-tertiary" />
    </Pressable>
  );
}

function availabilityCopy(
  availability: BrowserDownloadAvailability,
  settings: ReturnType<typeof useI18n>['t']['settings'],
): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (availability === 'completed') {
    return { label: settings.browserDownloadsCompleted, tone: 'success' };
  }
  if (availability === 'unavailable') {
    return { label: settings.browserDownloadsUnavailable, tone: 'warning' };
  }
  return { label: settings.browserDownloadsUnknown, tone: 'neutral' };
}

// One record of the list. The list can be long and the page re-renders on every character
// typed in the search field, so a record renders again only when it changes itself.
const DownloadRow = memo(function DownloadRow({
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
        <Pressable disabled={!available}
          onClick={() => onFileAction(row, 'open')}
          aria-label={format(t.settings.browserDownloadsOpenFileLabel, { file: row.name })}
          title={row.name}
          className="block max-w-full truncate rounded-control text-left text-ui font-medium text-label hover:underline">
          {row.name}
        </Pressable>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-label-tertiary">
          <span>{formatBytes(row.bytes)}</span>
          <span className="max-w-64 truncate" title={row.sourceOrigin}>{row.sourceOrigin}</span>
          <Pressable onClick={() => onOpenTask(row)}
            className="block max-w-64 truncate rounded-control text-left text-caption text-label-tertiary hover:underline"
            aria-label={format(t.settings.browserDownloadsOpenTaskLabel, { task: row.conversationTitle })}>
            {row.conversationTitle}
          </Pressable>
        </div>
        {(checking || row.availability !== 'completed') && (
          <div className="mt-1">
            {/* A record being checked waits with a still icon; the page spins only while the history is read. */}
            {checking
              ? <Tag><Icon icon={AppIcons.loading} size="sm" />{t.settings.browserDownloadsChecking}</Tag>
              : <Tag tone={status.tone}>{status.label}</Tag>}
          </div>
        )}
      </div>
      <time className="shrink-0 text-ui-sm text-label-secondary" dateTime={new Date(row.recordedAt).toISOString()}>{recordedAt}</time>
      <IconButton size="sm" icon={AppIcons.folderOpen} disabled={!available}
        onClick={() => onFileAction(row, 'reveal')}
        label={format(t.settings.browserDownloadsRevealLabel, { file: row.name })} />
    </li>
  );
});

function OmissionNotes({ omissions }: { omissions: BrowserDownloadHistoryOmission[] }) {
  const { t } = useI18n();
  if (omissions.length === 0) return null;
  return (
    <ul className="space-y-1 border-t border-separator pt-3 text-ui-sm text-label-tertiary">
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

  // Records keep the same two callbacks for as long as the page lives; each runs the latest action.
  const latestActions = useRef({ runFileAction, openTask });
  useLayoutEffect(() => { latestActions.current = { runFileAction, openTask }; });
  const onFileAction = useCallback((row: BrowserDownloadHistoryRow, action: 'open' | 'reveal') => {
    void latestActions.current.runFileAction(row, action);
  }, []);
  const onOpenTask = useCallback((row: BrowserDownloadHistoryRow) => {
    void latestActions.current.openTask(row);
  }, []);

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
        <h3 className="text-title text-label">
          {t.settings.browserDownloadsTitle}
        </h3>
        <p className="mt-1 max-w-2xl text-ui-sm text-label-secondary">
          {t.settings.browserDownloadsDesc}
        </p>
        {taskUnavailable && (
          <div className="mt-2">
            <InlineMessage tone="warning">{t.settings.browserDownloadsTaskUnavailable}</InlineMessage>
          </div>
        )}
        </div>
        {rows.length > 0 && <div className="w-56 max-w-full shrink-0">
          <TextField
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t.settings.browserDownloadsSearchPlaceholder}
            aria-label={t.settings.browserDownloadsSearchLabel}
          />
        </div>}
      </div>

      <div className="space-y-5">
        {!loading && historyReadFailures > 0 && (
          <InlineMessage
            tone="warning"
            action={(
              <Button variant="secondary" size="sm" onClick={() => setReloadRevision((revision) => revision + 1)}>
                {t.settings.browserDownloadsReadAgain}
              </Button>
            )}
          >
            {everyHistoryReadFailed
              ? t.settings.browserDownloadsReadFailed
              : t.settings.browserDownloadsPartialRead}
          </InlineMessage>
        )}
        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner label={t.settings.browserDownloadsLoading} />
          </div>
        ) : everyHistoryReadFailed ? null : rows.length === 0 ? (
          <p className="py-8 text-center text-ui-sm text-label-tertiary">
            {t.settings.browserDownloadsEmpty}
          </p>
        ) : visibleRows.length === 0 ? (
          <div className="border-t border-separator pt-3">
            <p className="text-ui-sm text-label-tertiary">
              {t.settings.browserDownloadsNoResults}
            </p>
            {filtersActive && (
              <div className="mt-2">
                <Button variant="secondary" size="sm" onClick={() => onQueryChange('')}>
                  {t.settings.browserDownloadsClearSearch}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {[...groups].map(([date, entries]) => (
              <section key={date} className="rounded-panel border border-separator px-4">
                <h4 className="border-b border-separator py-3 text-ui font-medium text-label">{date}</h4>
                <ul className="divide-y divide-separator">
                  {entries.map((row) => (
                    <DownloadRow key={row.key} row={row} checking={checkingKeys.has(row.key)}
                      onFileAction={onFileAction}
                      onOpenTask={onOpenTask} />
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
