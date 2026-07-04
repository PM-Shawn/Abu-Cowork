import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Toggle } from '@/components/ui/toggle';
import { setPetVisible } from '@/core/pet/petVisibility';

export default function PetSection() {
  const petOpen = useSettingsStore((s) => s.petOpen);
  const setPetOpen = useSettingsStore((s) => s.setPetOpen);
  const { t } = useI18n();

  const handleTogglePet = async () => {
    const next = !petOpen;
    // Persist the intent only if the window actually toggled, so a failed
    // pet_show/pet_hide doesn't leave the switch out of sync with reality.
    if (await setPetVisible(next)) {
      setPetOpen(next);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <div className="flex-1 mr-4">
          <p className="text-sm text-[var(--abu-text-primary)]">{t.settings.petEnable}</p>
          <p className="text-xs text-[var(--abu-text-muted)] mt-0.5">{t.settings.petEnableDesc}</p>
        </div>
        <Toggle checked={petOpen} onChange={handleTogglePet} size="lg" />
      </div>
    </div>
  );
}
