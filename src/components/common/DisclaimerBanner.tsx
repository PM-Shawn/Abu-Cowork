/**
 * DisclaimerBanner — one-shot first-launch notice.
 *
 * Shows a concise 3-point disclaimer in the bottom-right corner the first
 * time the user opens Abu (or after a version upgrade that resets the flag).
 * Dismissing it flips `hasAcknowledgedDisclaimer` to true so it never
 * appears again. "查看完整说明" navigates directly to Settings → About.
 */

import { useI18n } from '@/i18n';
import { Button, IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Tag } from '@/components/ds/tag';
import { useSettingsStore } from '@/stores/settingsStore';

export default function DisclaimerBanner() {
  const { t } = useI18n();
  const acknowledged = useSettingsStore((s) => s.hasAcknowledgedDisclaimer);
  const setAcknowledged = useSettingsStore((s) => s.setHasAcknowledgedDisclaimer);
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);

  if (acknowledged) return null;

  function handleViewFull() {
    setAcknowledged(true);
    openSystemSettings('about');
  }

  function handleDismiss() {
    setAcknowledged(true);
  }

  return (
    // On the fullscreen level and after the page in the document: over a preview that covers the
    // window, under every floating layer.
    <div
      data-electron-no-drag
      className="fixed bottom-6 right-6 z-fullscreen w-80 space-y-3 rounded-panel border border-separator bg-raised p-4 shadow-float"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <Tag tone="warning">{t.about.disclaimerTitle}</Tag>
        <IconButton icon={AppIcons.close} label={t.common.close} size="sm" onClick={handleDismiss} className="-mr-1 -mt-1" />
      </div>

      {/* 3-point list */}
      <ul className="list-disc space-y-1 pl-4 text-ui-sm text-label-secondary marker:text-label-tertiary">
        {[t.disclaimerBanner.line1, t.disclaimerBanner.line2, t.disclaimerBanner.line3].map(
          (line, i) => <li key={i}>{line}</li>,
        )}
      </ul>

      {/* Footer actions. The negative margin puts the words of the two buttons on the edges of the text above. */}
      <div className="-mx-2 flex items-center justify-between pt-1">
        <Button variant="plain" size="sm" onClick={handleDismiss}>
          {t.disclaimerBanner.dismiss}
        </Button>
        <Button variant="plain" size="sm" onClick={handleViewFull}>
          {t.disclaimerBanner.viewFull}
        </Button>
      </div>
    </div>
  );
}
