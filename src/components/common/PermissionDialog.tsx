import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { useI18n } from '@/i18n';
import type { PermissionDuration } from '@/stores/permissionStore';

export interface PermissionRequest {
  type: 'workspace' | 'shell' | 'file-write' | 'file-read' | 'folder-select';
  path?: string;
  details?: string;
  reason?: string;  // For folder-select: why the workspace is needed
}

export type { PermissionDuration };

interface PermissionDialogProps {
  request: PermissionRequest;
  onAllow: (duration: PermissionDuration) => void;
  onDeny: () => void;
  onChooseFolder?: () => void;  // For folder-select type
  onAuthorize?: () => void;     // For folder-select: directly authorize suggestedPath
  // Where the focus goes once the window has left, when the control that had it is gone.
  onFocusUnplaced?: () => void;
}

// The kind of grant shows as an icon; the title says it in words.
const iconMap = {
  workspace: AppIcons.folderOpen,
  shell: AppIcons.terminal,
  'file-write': AppIcons.fileEdit,
  'file-read': AppIcons.folderOpen,
  'folder-select': AppIcons.folderOpen,
};

/**
 * The window that asks for access to a path or a folder: a file read or write, a shell or a
 * workspace grant with a duration, or a workspace request of a task.
 *
 * An approval layer: no other window closes it or covers it, and one approval is on the page at
 * a time. It opens with the focus on Deny, so Enter and Space pressed as it appears deny.
 * Escape and the corner button deny as well; a press outside does nothing. Only a press on the
 * allowing button allows.
 *
 * A grant is remembered by default: the folder is asked about once, and the answer holds after
 * a restart. The one other choice keeps it until the app is quit. (Before 2026-11 the default
 * lasted until a restart, so the same folder was asked about again every day, and remembering
 * took a second press.)
 *
 * Another path or another kind of grant is another window: it starts from the default
 * duration, with the focus on Deny. An owner that shows one request after another for the
 * same path gives each a `key` of its own.
 */
export default function PermissionDialog(props: PermissionDialogProps) {
  return <PermissionWindow key={`${props.request.type}\n${props.request.path ?? ''}`} {...props} />;
}

function PermissionWindow({ request, onAllow, onDeny, onChooseFolder, onAuthorize, onFocusUnplaced }: PermissionDialogProps) {
  const [selectedDuration, setSelectedDuration] = useState<PermissionDuration>('always');
  const { t } = useI18n();

  // Get the appropriate permission config from translations
  const getPermissionConfig = () => {
    switch (request.type) {
      case 'workspace':
        return t.permission.workspace;
      case 'shell':
        return t.permission.shell;
      case 'file-write':
        return t.permission.fileWrite;
      case 'file-read':
        return t.permission.fileRead!;
      default:
        return t.permission.workspace;
    }
  };

  const config = getPermissionConfig();

  // Two durations that differ: for good, and until the app is quit. ('once' lasted until a
  // restart as well, and nobody chose '24h'; grants stored with either still load.)
  const durationOptions: Array<{ value: PermissionDuration; label: string }> = [
    { value: 'always', label: t.permission.durationAlways },
    { value: 'session', label: t.permission.durationSession },
  ];

  const allowButtonText = selectedDuration === 'always'
    ? t.permission.allowAlwaysButton
    : t.permission.allowSessionButton;

  // A workspace request of a task has two forms: one that names a folder to authorize, and one
  // that only asks the user to pick a folder.
  const folderSelectT = t.permission.folderSelect;
  const isFolderSelect = request.type === 'folder-select';
  const asksToPick = isFolderSelect && !request.path;

  const pathBlock = request.path && (
    // The path, verbatim and whole: a long one wraps.
    <div className="break-all rounded-control bg-code px-3 py-2 font-code text-ui-sm text-label">{request.path}</div>
  );
  const capabilityList = (capabilities: string[]) => (
    <div>
      <p className="mb-2 text-ui font-medium text-label">{t.permission.abuCanDo}</p>
      <ul className="space-y-1">
        {capabilities.map((cap, i) => (
          <li key={i} className="flex items-center gap-2 text-ui text-label-secondary">
            <Icon icon={AppIcons.done} size="sm" className="text-success" />
            {cap}
          </li>
        ))}
      </ul>
    </div>
  );

  let title: string;
  let description: string | undefined;
  let body: ReactNode;
  let footer: ReactNode;
  if (asksToPick) {
    title = folderSelectT?.title ?? '';
    // The explanation is the window's description, as in every other form of it.
    description = folderSelectT?.description ?? '';
    body = (
      <div className="flex flex-col items-center gap-3 text-center">
        {/* Pressing it only opens the system folder picker; the owner authorizes the folder
            that picker returns. */}
        <Button variant="primary" icon={AppIcons.folderOpen} onClick={onChooseFolder}>
          {folderSelectT?.selectButton ?? ''}
        </Button>
        <p className="text-caption text-label-tertiary">{folderSelectT?.hint ?? ''}</p>
      </div>
    );
  } else if (isFolderSelect) {
    title = folderSelectT?.authorizeTitle ?? '';
    description = folderSelectT?.authorizeDescription ?? '';
    body = (
      <div className="space-y-3">
        {pathBlock}
        {capabilityList(folderSelectT?.authorizeCapabilities ?? [])}
        <InlineMessage tone="warning">{folderSelectT?.authorizeWarning ?? ''}</InlineMessage>
      </div>
    );
    footer = (
      <div className="flex w-full flex-col gap-2">
        <div className="flex justify-end gap-2">
          <Button variant="secondary" data-approval-cancel="" onClick={onDeny}>
            {t.permission.deny}
          </Button>
          <Button variant="primary" onClick={onAuthorize}>
            {folderSelectT?.authorizeButton ?? ''}
          </Button>
        </div>
        <Pressable
          className="w-full text-center text-ui-sm text-label-tertiary underline underline-offset-2 hover:text-label"
          onClick={onChooseFolder}
        >
          {folderSelectT?.chooseDifferent ?? ''}
        </Pressable>
      </div>
    );
  } else {
    title = config.title;
    description = config.description;
    body = (
      <div className="space-y-3">
        {pathBlock}
        {capabilityList(config.capabilities)}
        <InlineMessage tone="warning">{config.warning}</InlineMessage>
        <div>
          <p className="mb-2 text-ui-sm text-label-secondary">{t.permission.durationLabel}</p>
          {/* Arrow keys move the focus between the two; Enter, Space or a press chooses one. */}
          <SegmentedControl
            fullWidth
            label={t.permission.durationLabel}
            value={selectedDuration}
            onValueChange={(value) => {
              const chosen = durationOptions.find((option) => option.value === value);
              if (chosen) setSelectedDuration(chosen.value);
            }}
            options={durationOptions}
          />
        </div>
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" data-approval-cancel="" onClick={onDeny}>
          {t.permission.deny}
        </Button>
        <Button variant="primary" onClick={() => onAllow(selectedDuration)}>
          {allowButtonText}
        </Button>
      </>
    );
  }

  return (
    <Dialog
      open
      layer="approval"
      role="alertdialog"
      size="md"
      closeButton
      outsidePress="ignore"
      // A workspace request answers itself 60 seconds after it was asked: among the approvals
      // that wait their turn it goes first.
      urgent={isFolderSelect}
      // Escape and the corner button. The layer registry never closes an approval.
      onOpenChange={(next) => { if (!next) onDeny(); }}
      title={title}
      description={description}
      // The form that only asks for a folder has no Deny: it opens on its one button.
      initialFocus={(content) => content.querySelector<HTMLElement>('[data-approval-cancel]')}
      onFocusUnplaced={onFocusUnplaced}
      header={(
        <div className={asksToPick ? 'flex justify-center' : 'flex items-start gap-3'}>
          <Icon icon={iconMap[request.type]} size="lg" className="text-label-secondary" />
        </div>
      )}
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
