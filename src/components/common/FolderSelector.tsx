import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { getBaseName } from '@/utils/pathUtils';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator } from '@/components/ds/menu';

export interface FolderSelectorProps {
  currentPath: string | null;
  recentPaths: string[];
  onSelect: (path: string) => void;
  onClear?: () => void;
  className?: string;
  appearance?: 'chip' | 'context-bar';
}

/** Get the folder name from a full path */
function getFolderName(path: string): string {
  return getBaseName(path);
}

export default function FolderSelector({
  currentPath,
  recentPaths,
  onSelect,
  onClear,
  className,
  appearance = 'chip',
}: FolderSelectorProps) {
  const { t } = useI18n();

  const handleOpenDialog = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t.folder.selectWorkspaceFolder,
      });
      if (selected) {
        onSelect(selected as string);
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err);
    }
  };

  const trigger = (
    <Button
      variant="plain"
      size="sm"
      icon={currentPath ? AppIcons.folderOpen : AppIcons.folder}
      className={cn(
        'max-w-full',
        appearance === 'chip' && currentPath ? 'bg-fill-selected' : 'text-label-secondary',
      )}
      // First time use: nothing to list yet, so the folder dialog opens directly.
      onClick={!currentPath && recentPaths.length === 0 ? () => { void handleOpenDialog(); } : undefined}
    >
      <span className={cn('min-w-0 truncate', appearance === 'context-bar' ? 'max-w-60' : 'max-w-30')}>
        {currentPath ? getFolderName(currentPath) : t.folder.loadFolder}
      </span>
      <Icon icon={AppIcons.expand} size="sm" />
    </Button>
  );

  return (
    <div className={cn('flex min-w-0 items-center gap-1', className)}>
      {!currentPath && recentPaths.length === 0 ? trigger : (
        <Menu trigger={trigger} side="top" align="start">
          {recentPaths.length > 0 && (
            <>
              <MenuLabel>{t.folder.recentFolders}</MenuLabel>
              <MenuRadioGroup value={currentPath ?? ''} onValueChange={onSelect}>
                {recentPaths.slice(0, 5).map((path) => (
                  <MenuRadioItem key={path} value={path}>
                    <span className="block max-w-64 truncate">
                      {getFolderName(path)}
                      <span className="ml-2 text-label-tertiary">{path}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
            </>
          )}
          <MenuItem icon={AppIcons.folderOpen} onSelect={() => { void handleOpenDialog(); }}>
            {recentPaths.length > 0 ? t.folder.selectOtherFolder : `${t.folder.selectFolder}...`}
          </MenuItem>
        </Menu>
      )}

      {/* Clear button (only when folder selected) */}
      {currentPath && onClear && (
        <IconButton size="sm" icon={AppIcons.close} label={t.folder.clearWorkspace} onClick={onClear} />
      )}
    </div>
  );
}
