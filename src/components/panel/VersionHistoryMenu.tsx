import { useEffect, useState, type ReactNode } from 'react';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel } from '@/components/ds/menu';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
import { listVersions, REVERT_LABEL, type VersionMeta } from '@/utils/canvasVersions';
import { useToastStore } from '@/stores/toastStore';
import { useI18n } from '@/i18n';

interface VersionHistoryMenuProps {
  /** Absolute path of the file this history belongs to. */
  filePath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens the menu. */
  trigger: ReactNode;
  /**
   * Perform the revert. Owned by the parent (PreviewPanel) because reverting
   * must be authoritative over the live editor buffer — it writes disk AND
   * adopts the content into the editor, cancelling any pending autosave, so
   * the fs-watch reload can't be misread as an external conflict. Rejects on
   * failure.
   */
  onRevert: (id: string) => Promise<void>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Absolute timestamp, precise to the second — relative labels ("just now")
 * collapse rapid successive saves into indistinguishable rows, hiding their
 * order. Time-only for today's versions; date-prefixed for older ones.
 */
function formatVersionTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}

/**
 * Menu listing per-file version snapshots (see `@/utils/canvasVersions`).
 * Choosing a version reverts the file to it: the arrow keys only move the
 * highlight, Enter or a click reverts. Each row is the time, with what the
 * version is and its size on a second line.
 */
export function VersionHistoryMenu({ filePath, open, onOpenChange, trigger, onRevert }: VersionHistoryMenuProps) {
  const { t } = useI18n();
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [revertingId, setRevertingId] = useState<string | null>(null);

  // Load the version list every time the menu opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    listVersions(filePath)
      .then((list) => {
        if (!cancelled) setVersions(list);
      })
      .catch((err) => {
        console.error('[VersionHistoryMenu] Failed to list versions:', filePath, err);
        if (!cancelled) {
          setVersions([]);
          useToastStore.getState().addToast({
            type: 'error',
            title: t.panel.versionHistoryLoadFailed,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable from i18n singleton
  }, [open, filePath]);

  const handleRevert = async (id: string) => {
    if (revertingId) return;
    setRevertingId(id);
    try {
      // Delegate to the parent, which writes disk AND authoritatively adopts
      // the reverted content into the editor (cancelling any pending autosave)
      // so an unsaved draft can't turn the revert into a silently-dropped
      // "external conflict".
      await onRevert(id);
      useToastStore.getState().addToast({
        type: 'success',
        title: t.panel.versionHistoryReverted,
      });
      // The menu closed when the version was chosen; if it was opened again
      // meanwhile, its list no longer matches the file.
      onOpenChange(false);
    } catch (err) {
      console.error('[VersionHistoryMenu] Revert failed:', filePath, id, err);
      useToastStore.getState().addToast({
        type: 'error',
        title: t.panel.versionHistoryRevertFailedTitle,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRevertingId(null);
    }
  };

  return (
    <Menu align="end" open={open} onOpenChange={onOpenChange} trigger={trigger}>
      <MenuLabel>{t.panel.versionHistory}</MenuLabel>
      {loading ? (
        <div className="flex justify-center px-2 py-3">
          <Spinner size="sm" label={t.common.loading} />
        </div>
      ) : versions.length === 0 ? (
        <p className="px-2 py-3 text-center text-ui-sm text-label-tertiary">{t.panel.versionHistoryEmpty}</p>
      ) : (
        // The menu limits its own height to the window and scrolls, so the rows sit directly in it.
        versions.map((v) => {
          const label = v.label === REVERT_LABEL ? t.panel.versionRevertPoint : v.label;
          return (
            <MenuItem
              key={v.id}
              icon={AppIcons.clock}
              title={t.panel.versionHistoryRevert}
              disabled={revertingId !== null}
              description={(
                // One line: a long label is cut short, the size always stays in view.
                <span className="flex">
                  {label && <span className="min-w-0 truncate">{label}</span>}
                  <span className="shrink-0 whitespace-pre">{label ? ' · ' : ''}{formatBytes(v.byteSize)}</span>
                </span>
              )}
              onSelect={() => { void handleRevert(v.id); }}
            >
              {/* The tag's height on every row, so rows with and without it are equally tall. */}
              <span className="flex h-5 items-center gap-2">
                <span className="tabular-nums">{formatVersionTime(v.ts)}</span>
                {v.source === 'ai' && <Tag tone="info">{t.panel.versionSourceAi}</Tag>}
              </span>
            </MenuItem>
          );
        })
      )}
    </Menu>
  );
}
