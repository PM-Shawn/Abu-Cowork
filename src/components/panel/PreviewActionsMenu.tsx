import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuSeparator } from '@/components/ds/menu';

interface PreviewActionsMenuProps {
  label: string;
  revealLabel: string;
  copyPathLabel: string;
  saveAsLabel: string;
  onReveal: () => void;
  onCopyPath: () => void;
  onSaveAs: () => void;
}

/**
 * File action menu used by the preview header. Common reading actions stay
 * visible in the toolbar; filesystem actions live here so the document title
 * keeps enough room in narrow panel layouts. Each action opens a system dialog
 * or writes the clipboard, so focus goes back to the button when the menu closes.
 */
export default function PreviewActionsMenu({
  label,
  revealLabel,
  copyPathLabel,
  saveAsLabel,
  onReveal,
  onCopyPath,
  onSaveAs,
}: PreviewActionsMenuProps) {
  return (
    <Menu align="end" trigger={<IconButton size="sm" icon={AppIcons.more} label={label} />}>
      <MenuItem icon={AppIcons.folderOpen} onSelect={onReveal}>{revealLabel}</MenuItem>
      <MenuItem icon={AppIcons.copy} onSelect={onCopyPath}>{copyPathLabel}</MenuItem>
      <MenuSeparator />
      <MenuItem icon={AppIcons.saveAs} onSelect={onSaveAs}>{saveAsLabel}</MenuItem>
    </Menu>
  );
}
