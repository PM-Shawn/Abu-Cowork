/**
 * PromoteToProjectHint — a light one-line hint rendered under the welcome
 * ChatInput when the user has bound a workspace that isn't yet part of
 * any project. Offers a low-friction "升格为项目" shortcut that opens
 * CreateProjectDialog pre-filled with the current folder, or a "忽略"
 * that persists a per-workspace dismissal (see projectHintStore).
 *
 * Visibility gates (all must hold):
 *   - workspacePath is non-empty
 *   - no existing project binds this workspacePath
 *   - user hasn't dismissed this workspacePath before
 *
 * Not shown in chat variant or when a workspace is missing.
 */

import { useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { useProjectStore } from '@/stores/projectStore';
import { useProjectHintStore } from '@/stores/projectHintStore';
import { getBaseName } from '@/utils/pathUtils';
import { useI18n, format } from '@/i18n';
import CreateProjectDialog from '@/components/common/CreateProjectDialog';

interface PromoteToProjectHintProps {
  workspacePath: string | null;
}

export default function PromoteToProjectHint({ workspacePath }: PromoteToProjectHintProps) {
  const { t } = useI18n();
  const [dialogOpen, setDialogOpen] = useState(false);

  const existingProject = useProjectStore((s) =>
    workspacePath ? s.getProjectByWorkspace(workspacePath) : undefined,
  );
  const isDismissed = useProjectHintStore((s) =>
    workspacePath ? s.dismissedWorkspaces.includes(workspacePath) : false,
  );
  const dismiss = useProjectHintStore((s) => s.dismiss);

  if (!workspacePath) return null;
  if (existingProject) return null;
  if (isDismissed) return null;

  const folderName = getBaseName(workspacePath);

  return (
    <>
      <div className="mx-1 mt-2 flex items-center gap-2 rounded-panel border border-separator bg-surface px-3 py-2 text-ui">
        <Icon icon={AppIcons.hint} size="sm" className="text-label-secondary" />
        <span className="flex-1 truncate text-label-secondary">
          {format(t.project.hintPromote, { name: folderName })}
        </span>
        <Button variant="secondary" size="sm" onClick={() => setDialogOpen(true)}>
          {t.project.hintPromoteAction}
        </Button>
        <IconButton size="sm" icon={AppIcons.close} label={t.project.hintPromoteDismiss} onClick={() => dismiss(workspacePath)} />
      </div>

      <CreateProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        presetMode="existing-folder"
        presetFolder={workspacePath}
        presetName={folderName}
      />
    </>
  );
}
