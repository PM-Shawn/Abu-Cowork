/**
 * SkillHistoryModal — full-screen modal listing every recorded
 * modification to a single skill, with unified diffs and per-turn
 * revert.
 *
 * Design notes
 * ------------
 * - **Single-column accordion** (not a two-pane split). Users browse
 *   top-to-bottom chronologically; expanding an entry reveals the
 *   diff + revert button. Simpler than a split view, matches the
 *   Notion/Linear "modal timeline" UX the research recommended for
 *   non-technical users.
 * - **Unified diff**, not side-by-side. The `diff` library generates
 *   a standard patch string; we render it line by line with +/- color
 *   coding. Lightweight vs shipping Monaco.
 * - **Revert is per-turn**, not per-file. Users think "undo what the
 *   AI just did" (Cursor/Windsurf precedent), so restoring all files
 *   from a turn as one unit matches intent better than finer grain.
 * - **Empty state matters** — Phase A only started recording on its
 *   ship date, so existing skills will show no history for the first
 *   few days. Empty copy explains this so users don't think it's broken.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPatch } from 'diff';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
import { cn } from '@/lib/utils';
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { useI18n, format } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import {
  readHistory,
  revertTurn,
  type HistoryEntry,
  type HistoryFileChange,
} from '@/core/skill/history';
import { joinPath } from '@/utils/pathUtils';
import { relativeTime } from './skillHistoryTime';

interface Props {
  skillDir: string;
  skillName: string;
  onClose: () => void;
  /** Package-managed skills allow inspection without changing their installed files. */
  readOnly?: boolean;
  /** Whether the window is open. Left out, it is open for as long as it is mounted. */
  open?: boolean;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the control that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

export default function SkillHistoryModal({ skillDir, skillName, onClose, readOnly = false, open = true, onCloseAutoFocus }: Props) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);
  // The window stays on the page while it fades out; a revert reads whether it is still open.
  const openRef = useRef(open);
  useLayoutEffect(() => { openRef.current = open; });

  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTurnId, setExpandedTurnId] = useState<string | null>(null);
  const [revertingTurnId, setRevertingTurnId] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const list = await readHistory(skillDir);
      setEntries(list);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [skillDir]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const handleRevert = async (turnId: string) => {
    if (readOnly) return;
    // A revert rewrites the skill's files: nothing is reverted from a window that is closing.
    if (!openRef.current) return;
    setRevertingTurnId(turnId);
    try {
      const result = await revertTurn(skillDir, turnId);
      if (result.ok) {
        addToast({
          type: 'success',
          title: t.toolbox.historyRevertSuccess,
          message: format(t.toolbox.historyRevertRestoredFiles, {
            count: String(result.restored),
          }),
        });
        // Reload list so the new 'revert' audit entry shows up.
        await loadEntries();
      } else {
        addToast({
          type: 'error',
          title: t.toolbox.historyRevertFailed,
          message: result.failed.map((f) => `${f.relPath}: ${f.reason}`).join('; '),
        });
      }
    } finally {
      setRevertingTurnId(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={`${t.toolbox.historyModalTitle} — ${skillName}`}
      size="xl"
      closeButton
      onCloseAutoFocus={onCloseAutoFocus}
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner label={t.common.loading} />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState title={t.toolbox.historyEmpty} />
      ) : (
        <ul className="divide-y divide-separator">
          {entries.map((entry) => (
            <HistoryRow
              key={entry.turnId}
              entry={entry}
              skillDir={skillDir}
              expanded={expandedTurnId === entry.turnId}
              onToggle={() =>
                setExpandedTurnId(expandedTurnId === entry.turnId ? null : entry.turnId)
              }
              onRevert={() => handleRevert(entry.turnId)}
              readOnly={readOnly}
              isReverting={revertingTurnId === entry.turnId}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────

interface RowProps {
  entry: HistoryEntry;
  skillDir: string;
  expanded: boolean;
  onToggle: () => void;
  onRevert: () => void;
  isReverting: boolean;
  readOnly: boolean;
}

function HistoryRow({ entry, skillDir, expanded, onToggle, onRevert, isReverting, readOnly }: RowProps) {
  const { t } = useI18n();
  const fileCount = entry.files.length;
  const fileNames = entry.files.map((f) => f.relPath).join(', ');
  const isRevertEntry = entry.op === 'revert';

  return (
    <li className="px-2 py-3">
      <Pressable
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-control px-2 py-1 text-left hover:bg-fill-hover"
      >
        <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" className="text-label-tertiary" />
        <span className="shrink-0 text-ui-sm text-label-tertiary">
          {relativeTime(entry.ts, Date.now())}
        </span>
        <span className="shrink-0 text-ui-sm font-medium text-label">
          {t.toolbox[historyOpLabelKey(entry.op)]}
        </span>
        <span className="flex-1 truncate text-ui-sm text-label-secondary">
          {fileCount === 1 ? fileNames : format(t.toolbox.historyFileCount, { count: String(fileCount) })}
        </span>
        {entry.summary && !isRevertEntry && (
          <span className="max-w-45 truncate text-caption text-label-tertiary">
            {entry.summary}
          </span>
        )}
      </Pressable>

      {expanded && (
        <div className="mt-3 space-y-3 pl-8 pr-2">
          {entry.files.map((change) => (
            <FileDiffBlock key={change.relPath} skillDir={skillDir} change={change} />
          ))}

          {/* Revert button. Hidden for 'revert' entries themselves (no
              point reverting a revert — user can do a fresh action) and
              only shown when the entry still has something actionable.
              Busy while its revert runs, so it keeps the focus. */}
          {!readOnly && !isRevertEntry && (
            <div className="flex justify-end pt-1">
              <Button variant="secondary" size="sm" busy={isReverting} onClick={onRevert}>
                {t.toolbox.historyRevert}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────

function FileDiffBlock({ skillDir, change }: { skillDir: string; change: HistoryFileChange }) {
  const { t } = useI18n();
  const [diffText, setDiffText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Load the "before" and "after" contents based on the action type.
        // - modified: before = snapshotPath, after = current file on disk
        // - created:  before = empty, after = current file on disk
        // - removed:  before = snapshotPath (tombstone), after = empty
        let before = '';
        let after = '';

        const currentPath = joinPath(skillDir, change.relPath);
        const currentExists = await exists(currentPath).catch(() => false);

        if (change.action === 'modified') {
          if (change.snapshotPath && (await exists(change.snapshotPath).catch(() => false))) {
            before = await readTextFile(change.snapshotPath).catch(() => '');
          }
          if (currentExists) {
            after = await readTextFile(currentPath).catch(() => '');
          }
        } else if (change.action === 'created') {
          if (currentExists) {
            after = await readTextFile(currentPath).catch(() => '');
          }
        } else if (change.action === 'removed') {
          if (change.snapshotPath && (await exists(change.snapshotPath).catch(() => false))) {
            before = await readTextFile(change.snapshotPath).catch(() => '');
          }
        }

        if (cancelled) return;

        // `diff.createPatch` returns the unified-diff text. We trim off
        // the leading `Index:` / `===` / `---` / `+++` header lines
        // because they just repeat the filename we already show in the
        // row heading above — keeps the visible diff compact.
        const patch = createPatch(change.relPath, before, after);
        const trimmed = patch.split('\n').slice(4).join('\n');
        setDiffText(trimmed || '(no textual diff — content may be identical)');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skillDir, change]);

  return (
    <div className="overflow-hidden rounded-control border border-separator">
      <div className="flex items-center gap-2 bg-fill px-3 py-1">
        <Tag tone={ACTION_TONE[change.action]}>{t.toolbox[historyActionLabelKey(change.action)]}</Tag>
        <span className="font-code text-ui-sm text-label">{change.relPath}</span>
      </div>
      {error ? (
        <div className="p-2"><InlineMessage tone="danger">{error}</InlineMessage></div>
      ) : diffText === null ? (
        <div className="px-3 py-2 text-ui-sm text-label-tertiary">…</div>
      ) : (
        <DiffView text={diffText} />
      )}
    </div>
  );
}

// What happened to the file, as a status: changed, added, taken away.
const ACTION_TONE = { modified: 'info', created: 'success', removed: 'danger' } as const;

function DiffView({ text }: { text: string }) {
  return (
    <pre className="max-h-64 overflow-y-auto overlay-scroll bg-code font-code text-ui-sm">
      {text.split('\n').map((line, i) => (
        <div key={i} className={cn('px-3', diffLineClass(line))}>
          {line || '\u00A0'}
        </div>
      ))}
    </pre>
  );
}

// The sign at the start of the line says added or removed; the colour repeats it.
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-label-tertiary';
  if (line.startsWith('@@')) return 'bg-fill text-label-secondary';
  if (line.startsWith('+')) return 'bg-success-soft text-success';
  if (line.startsWith('-')) return 'bg-danger-soft text-danger';
  return 'text-label-secondary';
}

// Map enum values to i18n keys. Split out so TypeScript can narrow
// the key lookups and catch typos at build time.
function historyOpLabelKey(op: HistoryEntry['op']):
  | 'historyOpEdit'
  | 'historyOpPatch'
  | 'historyOpWriteFile'
  | 'historyOpRemoveFile'
  | 'historyOpRevert' {
  switch (op) {
    case 'edit': return 'historyOpEdit';
    case 'patch': return 'historyOpPatch';
    case 'write_file': return 'historyOpWriteFile';
    case 'remove_file': return 'historyOpRemoveFile';
    case 'revert': return 'historyOpRevert';
  }
}

function historyActionLabelKey(action: HistoryFileChange['action']):
  | 'historyActionModified'
  | 'historyActionCreated'
  | 'historyActionRemoved' {
  switch (action) {
    case 'modified': return 'historyActionModified';
    case 'created': return 'historyActionCreated';
    case 'removed': return 'historyActionRemoved';
  }
}
