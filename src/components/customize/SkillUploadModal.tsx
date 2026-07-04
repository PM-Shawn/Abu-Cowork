import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { unpackSkill, validateArchive, ConflictError } from '@/core/skill/packager';
import { installSkillFromFolder } from '@/core/skill/installer';
import { useFileDragDrop } from '@/hooks/useFileDragDrop';
import { useToastStore } from '@/stores/toastStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { getParentDir, normalizeSeparators } from '@/utils/pathUtils';
import { FileArchive, Upload, X, Loader2 } from 'lucide-react';
import ConfirmDialog from '@/components/common/ConfirmDialog';

/**
 * Discriminated union for the install conflict state.
 * A single <ConfirmDialog> handles both archive and folder conflicts;
 * the confirm handler branches on `kind`.
 */
type UploadConflict =
  | { kind: 'archive'; bytes: Uint8Array; baseDir: string; skillName: string }
  | { kind: 'folder'; folderPath: string; skillName: string };

interface SkillUploadModalProps {
  onClose: () => void;
  /** Called with the installed skill name on successful install / overwrite. */
  onInstalled: (skillName: string) => void;
}

/**
 * Unified skill-upload modal (Fix #10 extract, Fix #1 folder conflict, Fix #3 close-on-success).
 *
 * Mounted conditionally by SkillsSection — so useFileDragDrop's window-level
 * Tauri listener only runs while the modal is actually open.
 */
export default function SkillUploadModal({ onClose, onInstalled }: SkillUploadModalProps) {
  const { t } = useI18n();
  const [importInProgress, setImportInProgress] = useState(false);
  const [importConflict, setImportConflict] = useState<UploadConflict | null>(null);

  // ── Install helpers ────────────────────────────────────────────────

  /**
   * Unpack a .askill / .zip archive into ~/.abu/skills/.
   * Returns true on success, false on conflict (ConfirmDialog takes over) or error.
   */
  const installArchive = async (path: string): Promise<boolean> => {
    const addToast = useToastStore.getState().addToast;
    const bytes = await readFile(path);
    const archiveBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    const validationError = validateArchive(archiveBytes);
    if (validationError) {
      addToast({ type: 'error', title: t.toolbox.importFailed, message: validationError.message });
      return false;
    }

    const home = await homeDir();
    const baseDir = `${home}/.abu/skills`;

    try {
      const result = await unpackSkill(archiveBytes, baseDir);
      addToast({ type: 'success', title: t.toolbox.importSuccess, message: `"${result.name}"` });
      await useDiscoveryStore.getState().refresh();
      onInstalled(result.name);
      return true;
    } catch (err) {
      if (err instanceof ConflictError) {
        setImportConflict({ kind: 'archive', bytes: archiveBytes, baseDir, skillName: err.skillName });
        return false; // ConfirmDialog takes over from here
      }
      throw err;
    }
  };

  /**
   * Install a skill from a local folder (copies into ~/.abu/skills/).
   * Calls installSkillFromFolder WITHOUT overwrite first; on ALREADY_EXISTS
   * pops a ConfirmDialog instead of silently clobbering.
   * Returns true on success, false on conflict or error.
   */
  const installFolder = async (folderPath: string): Promise<boolean> => {
    const addToast = useToastStore.getState().addToast;
    const result = await installSkillFromFolder(folderPath); // no overwrite

    if (!result.ok) {
      if (result.code === 'ALREADY_EXISTS') {
        // Extract name from message: `Skill "NAME" already exists`
        const nameMatch = result.message.match(/"([^"]+)"/);
        const skillName = nameMatch?.[1] ?? folderPath.split('/').pop() ?? '?';
        setImportConflict({ kind: 'folder', folderPath, skillName });
        return false; // ConfirmDialog takes over
      }
      addToast({ type: 'error', title: t.toolbox.importFailed, message: result.message });
      return false;
    }

    await useDiscoveryStore.getState().refresh();
    onInstalled(result.name);
    const skippedNote = result.skipped.length > 0
      ? ` · ${format(t.toolbox.importSkippedFiles, { n: String(result.skipped.length), names: result.skipped.join('、') })}`
      : '';
    addToast({ type: 'success', title: t.toolbox.importSuccess, message: `"${result.name}"${skippedNote}` });
    return true;
  };

  /**
   * Unified router for the drop zone and both file pickers.
   * Calls onClose ONLY when install actually succeeded (Fix #3).
   */
  const installFromPath = async (rawPath: string) => {
    const path = normalizeSeparators(rawPath);
    setImportInProgress(true);
    try {
      let success: boolean;
      if (path.endsWith('.askill') || path.endsWith('.zip')) {
        success = await installArchive(path);
      } else if (path.endsWith('/SKILL.md')) {
        success = await installFolder(getParentDir(path));
      } else {
        success = await installFolder(path);
      }
      if (success) onClose();
    } catch (err) {
      console.error('Install skill failed:', err);
      useToastStore.getState().addToast({
        type: 'error',
        title: t.toolbox.importFailed,
        message: err instanceof Error ? err.message : String(err),
      });
      // Do NOT close on error — keep modal open so user can retry.
    } finally {
      setImportInProgress(false);
    }
  };

  // Window-level Tauri drag-drop listener. Only active while the modal is mounted.
  const { isDragging } = useFileDragDrop((paths) => {
    if (importInProgress) return;
    if (paths.length > 0) void installFromPath(paths[0]);
  });

  // Folder picker (Tauri can't offer folder + file in one dialog, hence two buttons).
  const pickFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (!picked || typeof picked !== 'string') return;
    await installFromPath(picked);
  };

  // File picker for .askill / .zip packages.
  const pickFile = async () => {
    const picked = await openDialog({
      filters: [{ name: 'Skill Package', extensions: ['askill', 'zip'] }],
      multiple: false,
    });
    if (!picked || typeof picked !== 'string') return;
    await installFromPath(picked);
  };

  // Confirm overwrite — handles both archive and folder conflicts.
  const handleImportOverwrite = async () => {
    if (!importConflict) return;
    const conflict = importConflict; // capture before clearing
    const addToast = useToastStore.getState().addToast;
    setImportConflict(null);
    setImportInProgress(true);
    try {
      let name: string;
      if (conflict.kind === 'archive') {
        const result = await unpackSkill(conflict.bytes, conflict.baseDir, { overwrite: true });
        name = result.name;
        addToast({ type: 'success', title: t.toolbox.importSuccess, message: `"${name}"` });
      } else {
        const result = await installSkillFromFolder(conflict.folderPath, { overwrite: true });
        if (!result.ok) {
          addToast({ type: 'error', title: t.toolbox.importFailed, message: result.message });
          return;
        }
        name = result.name;
        const skippedNote = result.skipped.length > 0
          ? ` · ${format(t.toolbox.importSkippedFiles, { n: String(result.skipped.length), names: result.skipped.join('、') })}`
          : '';
        addToast({ type: 'success', title: t.toolbox.importSuccess, message: `"${name}"${skippedNote}` });
      }
      await useDiscoveryStore.getState().refresh();
      onInstalled(name);
      onClose(); // close only after confirmed successful overwrite
    } catch (err) {
      addToast({
        type: 'error',
        title: t.toolbox.importFailed,
        message: err instanceof Error ? err.message : String(err),
      });
      // Keep modal open on error so user can try again.
    } finally {
      setImportInProgress(false);
    }
  };

  return (
    <>
      {/* Modal backdrop + container */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        onClick={() => { if (!importInProgress) onClose(); }}
      >
        <div
          className="w-[420px] bg-[var(--abu-bg-base)] rounded-xl shadow-xl border border-[var(--abu-border)] overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--abu-border)]">
            <div className="flex items-center gap-2">
              <Upload className="h-4 w-4 text-[var(--abu-clay)]" />
              <h2 className="text-sm font-semibold text-[var(--abu-text-primary)]">{t.toolbox.importEntry}</h2>
            </div>
            <button
              onClick={onClose}
              disabled={importInProgress}
              className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Body */}
          <div className="px-5 py-4 space-y-3">
            {/* Clickable + droppable zone. Click → folder picker (skills are
                folders); drag accepts a folder OR a .askill/.zip. Tauri can't
                offer folder+file in one native picker, so archives get the link below. */}
            <button
              type="button"
              onClick={pickFolder}
              disabled={importInProgress}
              className={`w-full flex flex-col items-center justify-center gap-2 py-8 px-4 rounded-lg border-2 border-dashed transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isDragging
                  ? 'border-[var(--abu-clay)] bg-[var(--abu-clay-tint)]'
                  : 'border-[var(--abu-border)] hover:border-[var(--abu-clay)] hover:bg-[var(--abu-bg-hover)]'
              }`}
            >
              {importInProgress ? (
                <Loader2 className="h-6 w-6 text-[var(--abu-clay)] animate-spin" />
              ) : (
                <Upload className="h-6 w-6 text-[var(--abu-text-muted)]" />
              )}
              <span className="text-xs text-[var(--abu-text-muted)] text-center">{t.toolbox.dropZoneHint}</span>
            </button>

            {/* Secondary: import a packaged skill (.askill / .zip). */}
            <div className="text-center">
              <button
                type="button"
                onClick={pickFile}
                disabled={importInProgress}
                className="inline-flex items-center gap-1 text-xs text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <FileArchive className="h-3 w-3" />
                {t.toolbox.pickFile}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Import conflict confirm — pops when an existing skill name is found.
          Handles both archive and folder installs via the discriminated union. */}
      <ConfirmDialog
        open={!!importConflict}
        title={t.toolbox.importConflictTitle}
        message={importConflict
          ? format(t.toolbox.importConflictMessage, { name: importConflict.skillName })
          : ''}
        confirmText={t.toolbox.importConflictOverwrite}
        cancelText={t.common.cancel}
        variant="danger"
        onConfirm={handleImportOverwrite}
        onCancel={() => setImportConflict(null)}
      />
    </>
  );
}
