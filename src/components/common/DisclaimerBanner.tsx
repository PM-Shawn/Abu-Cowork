/**
 * DisclaimerBanner — one-shot first-launch notice.
 *
 * Shows a concise 3-point disclaimer in the bottom-right corner the first
 * time the user opens Abu (or after a version upgrade that resets the flag).
 * Dismissing it flips `hasAcknowledgedDisclaimer` to true so it never
 * appears again. "查看完整说明" navigates directly to Settings → About.
 */

import { X, TriangleAlert } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
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
    <div
      className={cn(
        'fixed bottom-6 right-6 z-50 w-80 rounded-xl border',
        'border-[var(--abu-warning)] bg-[var(--abu-bg-muted)] shadow-xl',
      )}
    >
      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <TriangleAlert className="h-3.5 w-3.5 text-[var(--abu-warning)] shrink-0" />
            <span className="text-minor font-semibold text-[var(--abu-warning)]">
              {t.about.disclaimerTitle}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={handleDismiss}
            className="text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] shrink-0 -mt-0.5 -mr-1"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* 3-point list */}
        <ul className="space-y-1.5">
          {[t.disclaimerBanner.line1, t.disclaimerBanner.line2, t.disclaimerBanner.line3].map(
            (line, i) => (
              <li key={i} className="flex items-start gap-2 text-minor text-[var(--abu-text-secondary)]">
                <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-[var(--abu-warning-solid)] shrink-0" />
                {line}
              </li>
            ),
          )}
        </ul>

        {/* Footer actions */}
        <div className="flex items-center justify-between pt-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={handleDismiss}
            className="text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] px-0"
          >
            {t.disclaimerBanner.dismiss}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleViewFull}
            className="text-[var(--abu-clay)] hover:underline px-0"
          >
            {t.disclaimerBanner.viewFull}
          </Button>
        </div>
      </div>
    </div>
  );
}
