import { memo } from 'react';
import { Dialog } from '@/components/ds/dialog';
import SystemSettingsView from '@/components/settings/SystemSettingsModal';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * System settings as the app's settings-size dialog. The view behind it stays mounted.
 * Escape, the scrim and the close button close it; a menu, select or dialog opened inside
 * it closes first.
 *
 * An approval of a task takes its place: the layer registry closes the window for one, turns
 * it away while one is on screen, asks first when a form inside it holds unsaved input, and has
 * it step aside and return when a form inside it has work in flight. The window watches no
 * approval queue itself.
 *
 * `memo`, with no props: the app around it renders again for every piece of a streamed reply,
 * and the page of settings on screen must not render with it.
 */
export default memo(function SystemSettingsDialog() {
  const open = useSettingsStore((s) => s.systemSettingsOpen);
  const closeSystemSettings = useSettingsStore((s) => s.closeSystemSettings);
  const { t } = useI18n();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) closeSystemSettings(); }}
      title={t.settings.title}
      titleHidden
      size="page"
      closeButton={{ 'data-abu-settings-close': '' }}
      contentProps={{ 'data-abu-settings-dialog': '' }}
      // The window opens on the navigation row of the page in view.
      initialFocus={(content) => content.querySelector<HTMLElement>('nav [aria-current="page"]')}
    >
      <SystemSettingsView />
    </Dialog>
  );
});
