import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
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

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/32 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSystemSettings();
      }}
    >
      <div className="relative w-[min(1180px,92vw)] h-[min(840px,90vh)] rounded-2xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-2xl overflow-hidden">
        <button
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
