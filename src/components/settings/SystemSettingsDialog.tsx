import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { isMacOS } from '@/utils/platform';
import SystemSettingsView from '@/components/settings/SystemSettingsModal';

/**
 * System settings as a centered overlay dialog (like TRAE / WorkBuddy), instead
 * of a full-view swap. Shown when `systemSettingsOpen` is set; the underlying
 * view stays mounted behind the scrim. Close via X, backdrop click, or Esc.
 */
export default function SystemSettingsDialog() {
  const open = useSettingsStore((s) => s.systemSettingsOpen);
  const closeSystemSettings = useSettingsStore((s) => s.closeSystemSettings);
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSystemSettings();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, closeSystemSettings]);

  if (!open) return null;

  // macOS paints the traffic lights natively over the top 44px band (see
  // `trafficLightPosition` in electron/windowChrome.cjs and the `h-11` chrome
  // overlay in WindowTitleBar). A card centred on the whole viewport starts at
  // 5vh ≈ 40px on the default window and its corner lands under the green
  // light, so the scrim keeps covering the viewport but the card is laid out
  // below that band. Windows keeps its chrome rows in normal flow and is
  // already covered by the no-drag marker, so it keeps full-viewport centring.
  const mac = isMacOS();

  return (
    <div
      data-abu-settings-dialog
      data-electron-no-drag
      className={cn(
        'fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/32 backdrop-blur-[2px]',
        mac && 'pt-12',
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSystemSettings();
      }}
    >
      <div className="relative w-[min(1180px,92vw)] h-full max-h-[840px] rounded-2xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-2xl overflow-hidden">
        <button
          data-abu-settings-close
          onClick={closeSystemSettings}
          aria-label={t.common.close}
          className="absolute top-3 right-3 z-10 w-8 h-8 flex items-center justify-center rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
        >
          <X className="h-[18px] w-[18px]" strokeWidth={1.7} />
        </button>
        <SystemSettingsView />
      </div>
    </div>
  );
}
