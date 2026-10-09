import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { unpackSkill, validateArchive, ConflictError } from '@/core/skill/packager';
import { installSkillFromFolder, type InstallResult } from '@/core/skill/installer';
import { SkillPolicyDeniedError } from '@/core/skill/skillPolicy';
import { useFileDragDrop } from '@/hooks/useFileDragDrop';
import { useToastStore } from '@/stores/toastStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n } from '@/i18n';
import { format } from '@/i18n';
import { getParentDir, normalizeSeparators } from '@/utils/pathUtils';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ds/confirm-context';
import { Dialog } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { BUSY } from '@/components/ds/styles';

/**
 * Discriminated union for the install conflict state.
 * One question handles both archive and folder conflicts;
 * the overwrite branches on `kind`.
 */
type UploadConflict =
  | { kind: 'archive'; bytes: Uint8Array; baseDir: string; skillName: string }
  | { kind: 'folder'; folderPath: string; skillName: string };

interface SkillUploadModalProps {
  /** Whether the window is open. Left out, it is open for as long as it is mounted. */
  open?: boolean;
  onClose: () => void;
  /** Called with the installed skill name on successful install / overwrite. */
  onInstalled: (skillName: string) => void;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the control that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The drop zone. Click → folder picker (skills are folders); drag accepts a
 * folder OR a .askill/.zip. It lives inside the window's content, so the
 * window-level file-drop listener of the Tauri shell runs only while the
 * window is on the page (Electron handlers are scoped to the zone itself).
 */
function DropZone({ busy, onPick, onDropPaths }: { busy: boolean; onPick: () => void; onDropPaths: (paths: string[]) => void }) {
  const { t } = useI18n();
  const { isDragging, dropTargetProps } = useFileDragDrop((paths) => onDropPaths(paths));
  return (
    <Pressable
      {...dropTargetProps}
      // Busy, not disabled: the zone was pressed to start the import and keeps the focus while it runs.
      aria-disabled={busy || undefined}
      onClick={busy ? undefined : onPick}
      className={cn(
        'flex w-full flex-col items-center gap-2 rounded-panel border-2 border-dashed px-4 py-8',
        BUSY,
        // Like a ds button, it keeps its resting look under the pointer while it is busy.
        isDragging ? 'border-control-border bg-fill-selected' : 'border-separator not-aria-disabled:hover:bg-fill-hover',
      )}
    >
      {/* One height for both states, so the window does not move when an import starts. */}
      <span className="flex h-12 flex-col items-center justify-center gap-2">
        {busy ? (
          <Spinner label={t.toolbox.dropZoneHint} />
        ) : (
          <>
            <Icon icon={AppIcons.upload} size="lg" className="text-label-tertiary" />
            <span className="text-center text-ui-sm text-label-secondary">{t.toolbox.dropZoneHint}</span>
          </>
        )}
      </span>
    </Pressable>
  );
}

/**
 * Unified skill-upload window (Fix #10 extract, Fix #1 folder conflict, Fix #3 close-on-success).
 */
export default function SkillUploadModal({ open = true, onClose, onInstalled, onCloseAutoFocus }: SkillUploadModalProps) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [importInProgress, setImportInProgress] = useState(false);
  // The authority for "an import is running": a drop or a second press can land before the next render.
  const importing = useRef(false);
  // The same-name skill the user is being asked about. The answer overwrites this one only.
  const pendingConflict = useRef<UploadConflict | null>(null);
  // The window stays on the page while it fades out; its handlers read whether it is still open.
  const openRef = useRef(open);
  useLayoutEffect(() => { openRef.current = open; });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const setImporting = (running: boolean) => {
    importing.current = running;
    setImportInProgress(running);
  };

  // ── Install helpers ────────────────────────────────────────────────

  /**
   * Unpack a .askill / .zip archive into ~/.abu/skills/.
   * Returns true on success, false on conflict (the overwrite question takes over) or error.
   */
  const installArchive = async (path: string): Promise<boolean> => {
    const addToast = useToastStore.getState().addToast;
    const bytes = await readFile(path);
    const archiveBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    const validationError = validateArchive(archiveBytes);
    if (validationError) {
      addToast({
        type: 'error',
        title: t.toolbox.importFailed,
        // A traversing name is a refusal we can explain, and the remedy is the
        // user's, not a developer's. `validateArchive` has no locale of its own
        // and short-circuits before `unpackSkill`, whose UnsafeSkillNameError
        // carries the same localized sentence for the path nothing reaches — so
        // this branch is where the user meets the rule. Every other code has no
        // locale text and falls back to the developer message.
        message:
          validationError.code === 'UNSAFE_NAME'
            ? format(t.toolbox.importUnsafeName, { name: validationError.skillName ?? '' })
            : validationError.message,
      });
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
        pendingConflict.current = { kind: 'archive', bytes: archiveBytes, baseDir, skillName: err.skillName };
        return false; // the overwrite question takes over from here
      }
      throw err;
    }
  };

  /**
   * Toast suffix naming the symlinks the copy refused, or '' when there were
   * none. Both install paths append it: the user approved a folder, and the
   * skill that landed is missing exactly these entries.
   */
  const linksNote = (links: string[]): string =>
    links.length > 0
      ? ` · ${format(t.toolbox.importSkippedLinks, {
          n: String(links.length),
          names: links.join(t.toolbox.importSkippedLinksSeparator),
        })}`
      : '';

  /**
   * A failed folder install in the user's language where we have one.
   * `message` is developer-facing English; SYMLINK_ROOT is a refusal we can
   * explain, so it gets the locale's text and an actionable next step.
   */
  const installErrorMessage = (
    result: Extract<InstallResult, { ok: false }>,
    folderPath: string,
  ): string => {
    if (result.code === 'SYMLINK_ROOT') return format(t.toolbox.importSymlinkRootRefused, { path: folderPath });
    if (result.code === 'POLICY_DENIED') return format(t.toolbox.importPolicyDenied, { name: result.skillName });
    return result.message;
  };

  /** A thrown import failure in the user's language where we have one (see installErrorMessage). */
  const thrownErrorMessage = (err: unknown): string => {
    if (err instanceof SkillPolicyDeniedError) return format(t.toolbox.importPolicyDenied, { name: err.skillName });
    return err instanceof Error ? err.message : String(err);
  };

  /**
   * Install a skill from a local folder (copies into ~/.abu/skills/).
   * Calls installSkillFromFolder WITHOUT overwrite first; on ALREADY_EXISTS
   * the user is asked instead of silently clobbering.
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
        pendingConflict.current = { kind: 'folder', folderPath, skillName };
        return false; // the overwrite question takes over
      }
      addToast({ type: 'error', title: t.toolbox.importFailed, message: installErrorMessage(result, folderPath) });
      return false;
    }

    await useDiscoveryStore.getState().refresh();
    onInstalled(result.name);
    const skippedNote = result.skipped.length > 0
      ? ` · ${format(t.toolbox.importSkippedFiles, { n: String(result.skipped.length), names: result.skipped.join('、') })}`
      : '';
    addToast({
      type: 'success',
      title: t.toolbox.importSuccess,
      message: `"${result.name}"${skippedNote}${linksNote(result.skippedSymlinks)}`,
    });
    return true;
  };

  // Overwrite the skill the user was asked about — handles both archive and folder conflicts.
  const handleImportOverwrite = async (conflict: UploadConflict) => {
    const addToast = useToastStore.getState().addToast;
    setImporting(true);
    try {
      let name: string;
      if (conflict.kind === 'archive') {
        const result = await unpackSkill(conflict.bytes, conflict.baseDir, { overwrite: true });
        name = result.name;
        addToast({ type: 'success', title: t.toolbox.importSuccess, message: `"${name}"` });
      } else {
        const result = await installSkillFromFolder(conflict.folderPath, { overwrite: true });
        if (!result.ok) {
          addToast({
            type: 'error',
            title: t.toolbox.importFailed,
            message: installErrorMessage(result, conflict.folderPath),
          });
          return;
        }
        name = result.name;
        const skippedNote = result.skipped.length > 0
          ? ` · ${format(t.toolbox.importSkippedFiles, { n: String(result.skipped.length), names: result.skipped.join('、') })}`
          : '';
        addToast({
          type: 'success',
          title: t.toolbox.importSuccess,
          message: `"${name}"${skippedNote}${linksNote(result.skippedSymlinks)}`,
        });
      }
      await useDiscoveryStore.getState().refresh();
      onInstalled(name);
      onClose(); // close only after confirmed successful overwrite
    } catch (err) {
      addToast({
        type: 'error',
        title: t.toolbox.importFailed,
        message: thrownErrorMessage(err),
      });
      // Keep the window open on error so user can try again.
    } finally {
      setImporting(false);
    }
  };

  /**
   * A skill of that name is already installed: overwriting replaces it, so the
   * user is asked first, with the name. The answer acts on the import that
   * asked: nothing is overwritten when another import has asked since. The
   * question is asked over the open window and is answered "no" when the
   * window goes.
   */
  const askToOverwrite = async (conflict: UploadConflict) => {
    const confirmed = await confirm({
      title: t.toolbox.importConflictTitle,
      message: format(t.toolbox.importConflictMessage, { name: conflict.skillName }),
      confirmLabel: t.toolbox.importConflictOverwrite,
      tone: 'danger',
    });
    if (pendingConflict.current !== conflict) return;
    pendingConflict.current = null;
    // The question can reach the page in the render its window closes in; nothing then ends it,
    // so the answer checks that the window is still there.
    if (!confirmed || !mounted.current || !openRef.current || importing.current) return;
    await handleImportOverwrite(conflict);
  };

  /**
   * Unified router for the drop zone and both file pickers.
   * Calls onClose ONLY when install actually succeeded (Fix #3).
   */
  const installFromPath = async (rawPath: string) => {
    // The window stays on the page while it fades out; nothing is imported from there.
    if (!openRef.current || importing.current) return;
    const path = normalizeSeparators(rawPath);
    pendingConflict.current = null;
    setImporting(true);
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
        message: thrownErrorMessage(err),
      });
      // Do NOT close on error — keep the window open so user can retry.
    } finally {
      setImporting(false);
    }
    // The question is asked over the open window, which ends it when it closes. An import that
    // ends after the window or the page has gone asks nothing and overwrites nothing.
    const conflict = pendingConflict.current;
    if (conflict && mounted.current && openRef.current) void askToOverwrite(conflict);
    else pendingConflict.current = null;
  };

  // Folder picker (Tauri can't offer folder + file in one dialog, hence two buttons).
  const pickFolder = async () => {
    if (!openRef.current || importing.current) return;
    const picked = await openDialog({ directory: true, multiple: false });
    if (!picked || typeof picked !== 'string') return;
    await installFromPath(picked);
  };

  // File picker for .askill / .zip packages.
  const pickFile = async () => {
    if (!openRef.current || importing.current) return;
    const picked = await openDialog({
      filters: [{ name: 'Skill Package', extensions: ['askill', 'zip'] }],
      multiple: false,
    });
    if (!picked || typeof picked !== 'string') return;
    await installFromPath(picked);
  };

  return (
    <Dialog
      open={open}
      // Escape, a press outside and the close button ask to close; while an import runs the window stays.
      onOpenChange={(next) => { if (!next && !importing.current) onClose(); }}
      // For an approval the window steps aside while it imports, and comes back.
      busy={importInProgress}
      title={t.toolbox.importEntry}
      size="md"
      closeButton
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div className="space-y-3">
        {/* Clickable + droppable zone. Tauri can't offer folder+file in one
            native picker, so archives get the link below. */}
        <DropZone
          busy={importInProgress}
          onPick={() => { void pickFolder(); }}
          onDropPaths={(paths) => { if (paths.length > 0) void installFromPath(paths[0]); }}
        />

        {/* Secondary: import a packaged skill (.askill / .zip). */}
        <div className="text-center">
          <Pressable
            aria-disabled={importInProgress || undefined}
            onClick={importInProgress ? undefined : () => { void pickFile(); }}
            className={cn('inline-flex items-center gap-1 rounded-control text-ui-sm text-link not-aria-disabled:hover:underline', BUSY)}
          >
            <Icon icon={AppIcons.fileArchive} size="sm" />
            {t.toolbox.pickFile}
          </Pressable>
        </div>
      </div>
    </Dialog>
  );
}
