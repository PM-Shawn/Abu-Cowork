import { useRef } from 'react';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem } from '@/components/ds/menu';
import { useI18n } from '@/i18n';

interface ToolboxCreateMenuProps {
  /** Direct mode: clicking the "+ 添加" button fires this immediately, no dropdown
   *  (used by the MCP tab, which just opens the add-server form). Mutually exclusive
   *  with the menu-mode props below. */
  onClick?: () => void;
  items?: { label: string; disabled?: boolean; onSelect: () => void }[];
  /** Menu mode: dropdown with up to 3 entries (used by Agents/Skills tabs). */
  onAICreate?: () => void;
  onManualCreate?: () => void;
  onUploadFile?: () => void;
  /** Label for the third ("upload") menu item — Agents says "上传文件", Skills says "导入技能". */
  uploadLabel?: string;
  triggerTestId?: string;
  menuTestId?: string;
}

/**
 * Content-area header "+ 添加" control shared by the extensions and experts pages:
 * the page's primary button. In menu mode it opens a menu (create with Abu, create
 * manually, upload, or the caller's own items). The chosen entry runs once the menu
 * has gone, with the focus back on the button: a window the entry opens remembers
 * the button and returns the focus to it.
 */
export default function ToolboxCreateMenu({
  items, onClick, onAICreate, onManualCreate, onUploadFile, uploadLabel, triggerTestId, menuTestId,
}: ToolboxCreateMenuProps) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<(() => void) | null>(null);

  if (onClick) {
    return <Button variant="primary" icon={AppIcons.add} data-testid={triggerTestId} onClick={onClick}>{t.settings.add}</Button>;
  }

  return (
    <Menu
      align="end"
      contentProps={menuTestId ? { 'data-testid': menuTestId } : undefined}
      // A menu reopened during its exit animation stays mounted and its close hook never
      // ran for the earlier choice: opening forgets it.
      onOpenChange={(open) => { if (open) pendingRef.current = null; }}
      onCloseAutoFocus={(event) => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (!pending) return;
        event.preventDefault();
        triggerRef.current?.focus();
        pending();
      }}
      trigger={<Button ref={triggerRef} variant="primary" icon={AppIcons.add} data-testid={triggerTestId}>{t.settings.add}</Button>}
    >
      {items?.map((item) => (
        <MenuItem key={item.label} icon={AppIcons.add} disabled={item.disabled} onSelect={() => { pendingRef.current = item.onSelect; }}>{item.label}</MenuItem>
      ))}
      {onAICreate && <MenuItem icon={AppIcons.askAbu} onSelect={() => { pendingRef.current = onAICreate; }}>{t.toolbox.createWithAbu}</MenuItem>}
      {onManualCreate && <MenuItem icon={AppIcons.write} onSelect={() => { pendingRef.current = onManualCreate; }}>{t.toolbox.createManually}</MenuItem>}
      {onUploadFile && <MenuItem icon={AppIcons.upload} onSelect={() => { pendingRef.current = onUploadFile; }}>{uploadLabel}</MenuItem>}
    </Menu>
  );
}
