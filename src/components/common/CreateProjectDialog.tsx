import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { exists, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { focusComposer } from '@/components/chat/composerFocus';
import { Button, IconButton } from '@/components/ds/button';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { Pressable } from '@/components/ds/pressable';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { getBaseName, joinPath } from '@/utils/pathUtils';

type CreateMode = 'scratch' | 'existing-folder';
// A place the focus goes to after the window has changed what it shows.
type FocusTarget = CreateMode | 'name' | 'folder';

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Skip the mode-picker step and go straight into a pre-filled form.
   * Used by the "promote to project" hint on the welcome screen — user
   * already picked a folder via FolderSelector, so there's nothing to
   * choose; we want them landing on the name field.
   */
  presetMode?: CreateMode;
  presetFolder?: string;
  presetName?: string;
}

const FIELD_LABEL = 'mb-1 block text-ui-sm font-medium text-label-secondary';
const MODE_CARD = 'flex w-full items-center gap-3 rounded-panel border border-separator p-4 text-left hover:bg-fill-hover';

export default function CreateProjectDialog({
  open,
  onClose,
  presetMode,
  presetFolder,
  presetName,
}: CreateProjectDialogProps) {
  const { t } = useI18n();
  const createProject = useProjectStore((s) => s.createProject);
  const getProjectByWorkspace = useProjectStore((s) => s.getProjectByWorkspace);
  const setConversationProject = useChatStore((s) => s.setConversationProject);
  const conversationIndex = useChatStore((s) => s.conversationIndex);

  // Which step: pick mode, or fill form
  const [mode, setMode] = useState<CreateMode | null>(null);

  // Form fields
  const [projectName, setProjectName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [defaultProjectsDir, setDefaultProjectsDir] = useState('');
  // The project that already uses the chosen folder, as found when the folder was chosen. It is
  // not looked up again: once this window has created the project, the folder is its own.
  const [conflictProject, setConflictProject] = useState<string | null>(null);
  // The folder that was found to hold a project configuration.
  const [folderWithConfig, setFolderWithConfig] = useState<string | null>(null);
  // From the press on Create until the project exists or the attempt has failed.
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  // This opening ended with a project: the page has moved to it, and the control that opened
  // the window may be gone, so the focus goes to the message field.
  const created = useRef(false);
  useLayoutEffect(() => {
    if (open) created.current = false;
  }, [open]);

  // Waits for the layers that are on the page to leave it, then puts the focus in the message
  // field unless a control has it. The layer that leaves last would return the focus to the
  // control that opened this window, which the new project has taken off the page.
  const pageWatch = useRef<MutationObserver | null>(null);
  const focusComposerOncePageIsFree = () => {
    pageWatch.current?.disconnect();
    pageWatch.current = null;
    // True once no layer is on the page; the focus is then placed and the watch ends.
    const settle = () => {
      if (document.querySelector('[data-ds-layer]:not([hidden])')) return false;
      if (focusIsOnWindow()) focusComposer();
      return true;
    };
    if (settle()) return;
    const watch = new MutationObserver(() => {
      if (!settle()) return;
      watch.disconnect();
      pageWatch.current = null;
    });
    watch.observe(document.body, { childList: true, subtree: true });
    pageWatch.current = watch;
  };
  useEffect(() => () => pageWatch.current?.disconnect(), []);

  const nameId = useId();
  const instructionsId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLButtonElement>(null);
  const scratchRef = useRef<HTMLButtonElement>(null);
  const existingRef = useRef<HTMLButtonElement>(null);

  // Get default projects directory
  useEffect(() => {
    homeDir().then((home) => {
      setDefaultProjectsDir(joinPath(home, 'Documents', 'Abu', 'Projects'));
    }).catch(() => {});
  }, []);

  // The form starts over each time the window opens, and keeps what it showed while it fades
  // out. When preset values are supplied (promote-to-project hint path), it skips the mode
  // selection and is prefilled, so the user only has to confirm the name.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setMode(presetMode ?? null);
      setProjectName(presetName ?? '');
      setInstructions('');
      setSelectedFolder(presetFolder ?? null);
      setConflictProject(presetFolder ? getProjectByWorkspace(presetFolder)?.name ?? null : null);
      setFolderWithConfig(null);
    }
  }

  // Check the folder for a project configuration
  useEffect(() => {
    if (!selectedFolder) return;
    let current = true;
    exists(joinPath(selectedFolder, '.abu', 'ABU.md'))
      .then((found) => { if (current) setFolderWithConfig(found ? selectedFolder : null); })
      .catch(() => { if (current) setFolderWithConfig(null); });
    return () => { current = false; };
  }, [selectedFolder]);
  const hasAbuConfig = selectedFolder !== null && folderWithConfig === selectedFolder;

  // A step replaces the control that had the focus: the focus goes to the first control of the
  // new step, and on the way back to the way that was chosen.
  const focusNext = useRef<FocusTarget | null>(null);
  useLayoutEffect(() => {
    const next = focusNext.current;
    if (!next) return;
    focusNext.current = null;
    const target = { name: nameRef, folder: folderRef, scratch: scratchRef, 'existing-folder': existingRef }[next].current;
    target?.focus({ preventScroll: true, ...(lastInputWasPointer() ? { focusVisible: false } : {}) });
  });

  // Handle folder selection for "existing-folder" mode
  const handleSelectFolder = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t.project.selectFolder,
      });
      if (selected) {
        const folderPath = selected as string;
        setSelectedFolder(folderPath);
        setConflictProject(getProjectByWorkspace(folderPath)?.name ?? null);
        if (!projectName) setProjectName(getBaseName(folderPath));
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err);
    }
  };

  const chooseScratch = () => {
    focusNext.current = 'name';
    setMode('scratch');
  };
  const chooseExistingFolder = () => {
    focusNext.current = 'folder';
    setMode('existing-folder');
    handleSelectFolder();
  };
  const backToModes = () => {
    focusNext.current = mode;
    setMode(null);
  };

  // Create project
  const handleCreate = async () => {
    // The window keeps rendering while it fades out: nothing is created then. One press creates once.
    if (!open || creatingRef.current) return;
    if (!projectName.trim()) return;

    creatingRef.current = true;
    setCreating(true);
    try {
      let finalFolder = selectedFolder;

      // For "scratch" mode: create new folder
      if (mode === 'scratch') {
        const dir = defaultProjectsDir;
        finalFolder = joinPath(dir, projectName.trim());
        try {
          await mkdir(finalFolder, { recursive: true });
          // Create .abu/ dir with instructions if provided
          if (instructions.trim()) {
            const abuDir = joinPath(finalFolder, '.abu');
            await mkdir(abuDir, { recursive: true });
            const { writeTextFile } = await import('@tauri-apps/plugin-fs');
            await writeTextFile(joinPath(abuDir, 'ABU.md'), instructions.trim());
          }
        } catch (err) {
          console.error('Failed to create project folder:', err);
          return;
        }
      }

      if (!finalFolder) return;

      // The folder is there (made above, or chosen): the project is created even when the window
      // was closed meanwhile. A folder that was made stays on disk without a project only when
      // its instructions could not be written (the return above).
      const projectId = createProject({
        name: projectName.trim(),
        workspacePath: finalFolder,
      });

      // Auto-assign existing conversations with the same workspace
      const matchingConvs = Object.values(conversationIndex).filter(
        (c) => c.workspacePath === finalFolder && !c.projectId
      );
      for (const conv of matchingConvs) {
        setConversationProject(conv.id, projectId);
      }

      // Switch to new project context: clear active conversation → welcome screen with workspace set
      useChatStore.getState().startNewConversation();
      useWorkspaceStore.getState().setWorkspace(finalFolder);
      useSettingsStore.getState().setViewMode('chat');
      usePreviewStore.getState().setFileTreeMode(true);
      created.current = true;
      onClose();
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  // Whether form is valid for creation
  const canCreate = mode === 'scratch'
    ? !!projectName.trim()
    : !!projectName.trim() && !!selectedFolder && !conflictProject;

  const dirty = projectName !== (presetName ?? '') || instructions !== '' || selectedFolder !== (presetFolder ?? null);

  const nameField = (
    <div>
      <label htmlFor={nameId} className={FIELD_LABEL}>{t.project.nameLabel} *</label>
      <TextField
        id={nameId}
        ref={nameRef}
        data-project-name
        className="w-full"
        value={projectName}
        onChange={(e) => setProjectName(e.target.value)}
        placeholder={t.project.namePlaceholder}
      />
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={t.project.createTitle}
      description={mode === null ? t.project.createDesc : undefined}
      size="md"
      closeButton
      dirty={dirty}
      // Closing the window would not stop the create: it stays with it until the project exists.
      busy={creating}
      // Opened with the folder already chosen, it starts on the name.
      initialFocus={(content) => content.querySelector<HTMLElement>('[data-project-name]')}
      onCloseAutoFocus={(event) => {
        const wasCreated = created.current;
        created.current = false;
        if (!wasCreated) return;
        // Another layer has the focus (an approval the window stood aside for): the message
        // field gets it once that layer has left.
        if (event.defaultPrevented) focusComposerOncePageIsFree();
        else if (focusComposer()) event.preventDefault();
      }}
      header={mode !== null && !presetMode ? (
        <IconButton icon={AppIcons.back} label={t.schedule.backToList} onClick={backToModes} />
      ) : undefined}
      footer={mode !== null ? (
        <>
          <DialogClose asChild><Button variant="plain">{t.project.cancel}</Button></DialogClose>
          <Button variant="primary" disabled={!canCreate} busy={creating} onClick={handleCreate}>{t.project.create}</Button>
        </>
      ) : undefined}
    >
      {/* ========== Mode Selection ========== */}
      {mode === null && (
        <div className="flex flex-col gap-2">
          <Pressable ref={scratchRef} onClick={chooseScratch} className={MODE_CARD}>
            <Icon icon={AppIcons.newFolder} size="lg" className="text-label-tertiary" />
            <span className="min-w-0">
              <span className="block text-ui font-medium text-label">{t.project.modeFromScratch}</span>
              <span className="mt-1 block text-ui-sm text-label-tertiary">{t.project.modeFromScratchDesc}</span>
            </span>
          </Pressable>
          <Pressable ref={existingRef} onClick={chooseExistingFolder} className={MODE_CARD}>
            <Icon icon={AppIcons.folderOpen} size="lg" className="text-label-tertiary" />
            <span className="min-w-0">
              <span className="block text-ui font-medium text-label">{t.project.modeExistingFolder}</span>
              <span className="mt-1 block text-ui-sm text-label-tertiary">{t.project.modeExistingFolderDesc}</span>
            </span>
          </Pressable>
        </div>
      )}

      {/* ========== Mode: From Scratch ========== */}
      {mode === 'scratch' && (
        <div className="flex flex-col gap-4">
          {nameField}

          <div>
            <label htmlFor={instructionsId} className={FIELD_LABEL}>Instructions</label>
            <TextArea
              id={instructionsId}
              className="min-h-20 w-full"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Tell Abu how to work in this project (optional)"
            />
          </div>

          {/* Project location (read-only) */}
          <div className="flex items-center gap-2 rounded-control bg-fill px-3 py-2 text-ui-sm text-label-tertiary">
            <Icon icon={AppIcons.folderOpen} size="sm" />
            <span className="truncate">
              {projectName.trim()
                ? joinPath(defaultProjectsDir, projectName.trim())
                : defaultProjectsDir}
            </span>
          </div>
        </div>
      )}

      {/* ========== Mode: Existing Folder ========== */}
      {mode === 'existing-folder' && (
        <div className="flex flex-col gap-4">
          <div>
            <div className={FIELD_LABEL}>{t.project.selectFolder}</div>
            <Pressable
              ref={folderRef}
              onClick={handleSelectFolder}
              className="flex w-full items-center gap-2 rounded-control border border-control-border bg-field px-3 py-2 text-left hover:bg-fill-hover"
            >
              <Icon icon={AppIcons.folderOpen} size="sm" className="text-label-secondary" />
              <span className="min-w-0 flex-1 truncate text-ui text-label">
                {selectedFolder || t.project.selectFolder}
              </span>
            </Pressable>
          </div>

          {(hasAbuConfig || conflictProject) && (
            <div className="flex flex-col gap-2">
              {hasAbuConfig && <InlineMessage tone="success">{t.project.detectedConfig}</InlineMessage>}
              {conflictProject && (
                <InlineMessage tone="danger">{t.project.folderConflict.replace('{name}', conflictProject)}</InlineMessage>
              )}
            </div>
          )}

          {nameField}
        </div>
      )}
    </Dialog>
  );
}
