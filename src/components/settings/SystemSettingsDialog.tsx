import { useLayoutEffect, useRef } from 'react';
import { Dialog } from '@/components/ds/dialog';
import SystemSettingsView from '@/components/settings/SystemSettingsModal';
import { useBlockingApprovalVisible } from '@/hooks/useBlockingApprovalVisible';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * System settings as the app's settings-size dialog. The view behind it stays mounted.
 * Escape, the scrim and the close button close it; a menu, select or dialog opened inside
 * it closes first.
 */
export default function SystemSettingsDialog() {
  const open = useSettingsStore((s) => s.systemSettingsOpen);
  const closeSystemSettings = useSettingsStore((s) => s.closeSystemSettings);
  const { t } = useI18n();
  const blocked = useBlockingApprovalVisible();

  // One dialog at a time (spec flow 2): an approval or the close-window question takes over.
  useLayoutEffect(() => {
    if (open && blocked) closeSystemSettings();
  }, [blocked, closeSystemSettings, open]);

  // After a yield the prompt that took over is a legacy modal that takes no focus. Focus stays
  // off the opener underneath it: Enter there would open the opener's menu over the prompt,
  // and the Escape that closes the menu would answer the prompt.
  const blockedRef = useRef(blocked);
  useLayoutEffect(() => { blockedRef.current = blocked; });

  return (
    <Dialog
      open={open && !blocked}
      onOpenChange={(next) => { if (!next) closeSystemSettings(); }}
      title={t.settings.title}
      titleHidden
      size="page"
      closeButton={{ 'data-abu-settings-close': '' }}
      contentProps={{ 'data-abu-settings-dialog': '' }}
      onCloseAutoFocus={(event) => { if (blockedRef.current) event.preventDefault(); }}
    >
      <SystemSettingsView />
    </Dialog>
  );
}
