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

import { useCallback, useEffect, useState } from 'react';
import { X, Clock, RotateCcw, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { createPatch } from 'diff';
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

interface Props {
  skillDir: string;
  skillName: string;
  onClose: () => void;
}

function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return `${Math.round(diff / 86_400_000)} d ago`;
}

export default function SkillHistoryModal({ skillDir, skillName, onClose }: Props) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--abu-bg-active)]">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-[var(--abu-text-tertiary)]" />
            <h2 className="text-base font-semibold text-[var(--abu-text-primary)]">
              {t.toolbox.historyModalTitle} — {skillName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)] transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overlay-scroll">
          {loading ? (
            <div className="py-12 text-center text-sm text-[var(--abu-text-muted)]">
              <Loader2 className="h-4 w-4 mx-auto animate-spin" />
            </div>
          ) : entries.length === 0 ? (
            <div className="py-12 px-8 text-center text-sm text-[var(--abu-text-muted)]">
              {t.toolbox.historyEmpty}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--abu-border-subtle)]">
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
                  isReverting={revertingTurnId === entry.turnId}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
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
}

function HistoryRow({ entry, skillDir, expanded, onToggle, onRevert, isReverting }: RowProps) {
  const { t } = useI18n();
  const fileCount = entry.files.length;
  const fileNames = entry.files.map((f) => f.relPath).join(', ');
  const isRevertEntry = entry.op === 'revert';

  return (
    <li className="px-4 py-3">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 text-left hover:bg-[var(--abu-bg-muted)]/50 rounded-md -mx-2 px-2 py-1 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
        )}
        <span className="text-xs text-[var(--abu-text-muted)] shrink-0">
          {relativeTime(entry.ts)}
        </span>
        <span className="text-xs font-medium text-[var(--abu-text-primary)] shrink-0">
          {t.toolbox[historyOpLabelKey(entry.op)]}
        </span>
        <span className="text-xs text-[var(--abu-text-tertiary)] truncate flex-1">
          {fileCount === 1 ? fileNames : format(t.toolbox.historyFileCount, { count: String(fileCount) })}
        </span>
        {entry.summary && !isRevertEntry && (
          <span className="text-[11px] text-[var(--abu-text-muted)] truncate max-w-[180px]">
            {entry.summary}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-3 ml-5 space-y-3">
          {entry.files.map((change) => (
            <FileDiffBlock key={change.relPath} skillDir={skillDir} change={change} />
          ))}

          {/* Revert button. Hidden for 'revert' entries themselves (no
              point reverting a revert — user can do a fresh action) and
              only shown when the entry still has something actionable. */}
          {!isRevertEntry && (
            <div className="flex justify-end pt-1">
              <button
                onClick={onRevert}
                disabled={isReverting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-[var(--abu-border)] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors disabled:opacity-50"
              >
                {isReverting ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                {t.toolbox.historyRevert}
              </button>
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
    <div className="border border-[var(--abu-border-subtle)] rounded-md overflow-hidden">
      <div className="px-3 py-1.5 bg-[var(--abu-bg-muted)] flex items-center gap-2 text-[11px]">
        <span className={cn(
          'px-1.5 py-0.5 rounded font-medium',
          change.action === 'modified' && 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
          change.action === 'created' && 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400',
          change.action === 'removed' && 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400',
        )}>
          {t.toolbox[historyActionLabelKey(change.action)]}
        </span>
        <span className="text-[var(--abu-text-primary)] font-mono">{change.relPath}</span>
      </div>
      {error ? (
        <div className="px-3 py-2 text-xs text-red-600">{error}</div>
      ) : diffText === null ? (
        <div className="px-3 py-2 text-xs text-[var(--abu-text-muted)]">…</div>
      ) : (
        <DiffView text={diffText} />
      )}
    </div>
  );
}

function DiffView({ text }: { text: string }) {
  return (
    <pre className="text-[11px] leading-relaxed font-mono max-h-64 overflow-y-auto overlay-scroll bg-[var(--abu-bg-base)]">
      {text.split('\n').map((line, i) => (
        <div key={i} className={diffLineClass(line)}>
          {line || '\u00A0'}
        </div>
      ))}
    </pre>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'px-3 text-[var(--abu-text-muted)]';
  if (line.startsWith('@@')) return 'px-3 bg-[var(--abu-bg-muted)] text-[var(--abu-text-tertiary)]';
  if (line.startsWith('+')) return 'px-3 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-400';
  if (line.startsWith('-')) return 'px-3 bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-400';
  return 'px-3 text-[var(--abu-text-secondary)]';
}

// Tiny local util so we don't pull in @/lib/utils for one call site.
function cn(...parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join(' ');
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
