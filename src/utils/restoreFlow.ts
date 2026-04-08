/**
 * Shared "restore snapshot" UX flow.
 *
 * Used by FileAttachment and FilesSection — both surface a "restore to original"
 * action when a file's original location is gone but a snapshot is available.
 *
 * Flow:
 *   1. Try restoreSnapshotToOriginal → on success, show success toast.
 *   2. On no-snapshot error → show error toast (can't recover).
 *   3. On no-parent-dir or copy-failed → show actionable toast:
 *      "Original directory is gone, save to a new location?" → opens save dialog.
 *
 * Returns true if a file was successfully written to disk (either restored or saved-as).
 */

import { restoreSnapshotToOriginal, saveSnapshotAs } from '@/core/session/outputSnapshots';
import { useToastStore } from '@/stores/toastStore';
import { bumpFileRefresh } from '@/stores/fileRefreshStore';
import { getI18n, format } from '@/i18n';
import { getBaseName } from '@/utils/pathUtils';

/**
 * Run the restore flow for a snapshotted file.
 * Returns true on successful disk write (either to original or to save-as target).
 */
export async function runRestoreFlow(
  convId: string,
  originalPath: string,
): Promise<boolean> {
  const t = getI18n();
  const toast = useToastStore.getState();
  const basename = getBaseName(originalPath);

  const result = await restoreSnapshotToOriginal(convId, originalPath);

  if (result.ok) {
    toast.addToast({
      type: 'success',
      title: format(t.chat.restoreSuccess, { path: result.path }),
    });
    // Notify all file-display components to re-resolve so any "Restore" button
    // anywhere in the UI flips back to "Open in Finder".
    bumpFileRefresh();
    return true;
  }

  // Error branches
  if (result.error === 'no-snapshot') {
    toast.addToast({
      type: 'error',
      title: t.chat.restoreFailedNoSnapshot,
    });
    return false;
  }

  // no-parent-dir or copy-failed → offer save-as fallback
  const titleKey = result.error === 'no-parent-dir'
    ? t.chat.restoreFailedNoParent
    : format(t.chat.restoreFailedCopy, { reason: result.message ?? '' });

  return new Promise<boolean>((resolve) => {
    toast.addToast({
      type: 'warning',
      title: titleKey,
      duration: 0,  // sticky until user acts
      actions: [
        {
          label: t.chat.saveSnapshotAs,
          onClick: () => {
            void (async () => {
              try {
                const { save } = await import('@tauri-apps/plugin-dialog');
                const dest = await save({ defaultPath: basename });
                if (!dest) {
                  resolve(false);
                  return;
                }
                const sa = await saveSnapshotAs(convId, originalPath, dest);
                if (sa.ok) {
                  toast.addToast({
                    type: 'success',
                    title: format(t.chat.saveSnapshotAsSuccess, { path: sa.path }),
                  });
                  bumpFileRefresh();
                  resolve(true);
                } else {
                  toast.addToast({
                    type: 'error',
                    title: format(t.chat.restoreFailedCopy, { reason: sa.message ?? '' }),
                  });
                  resolve(false);
                }
              } catch {
                resolve(false);
              }
            })();
          },
        },
      ],
    });
  });
}
