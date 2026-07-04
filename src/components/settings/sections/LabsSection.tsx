import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { LABS_EXPERIMENTS, LABS_PET } from '@/core/labs/registry';
import { resolveLabsFlag } from '@/core/labs/resolve';
import { hidePet } from '@/core/pet/petVisibility';
import { Toggle } from '@/components/ui/toggle';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { FlaskConical } from 'lucide-react';

export default function LabsSection() {
  const { t } = useI18n();
  const labs = useSettingsStore((s) => s.labs);
  const setLabsFlag = useSettingsStore((s) => s.setLabsFlag);
  const petOpen = useSettingsStore((s) => s.petOpen);
  const setPetOpen = useSettingsStore((s) => s.setPetOpen);

  const handleToggle = async (id: string, next: boolean) => {
    // The pet unlock's OFF transition is a teardown, not just a flag flip.
    // Hide the running pet FIRST and only lock (flip the flag off) + clear
    // petOpen once the hide succeeds — otherwise a failed pet_hide would strip
    // the pet's settings tab while the pet is still visible, leaving no
    // in-session control to dismiss it. On failure, leave the flag ON to retry.
    if (id === LABS_PET && !next) {
      if (petOpen) {
        if (await hidePet()) {
          setPetOpen(false);
          setLabsFlag(id, false);
        }
        return;
      }
      setLabsFlag(id, false);
      return;
    }
    setLabsFlag(id, next);
  };

  // Empty state: the section stays in the nav (stable, discoverable), but shows
  // a friendly placeholder instead of the "turn them on" blurb, which reads oddly
  // when there is nothing to turn on.
  if (LABS_EXPERIMENTS.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-20 text-center">
        <FlaskConical className="h-8 w-8 text-[var(--abu-text-muted)] opacity-50" strokeWidth={1.5} />
        <p className="text-sm text-[var(--abu-text-tertiary)]">{t.settings.labsEmpty}</p>
        <p className="text-xs text-[var(--abu-text-muted)]">{t.settings.labsEmptyHint}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SettingsSectionHeader title={t.settings.labs} description={t.settings.labsDescription} />

      <div className="space-y-2">
        {LABS_EXPERIMENTS.map((exp) => {
          const enabled = resolveLabsFlag(exp.id, labs);
          return (
              <div
                key={exp.id}
                className="flex items-center justify-between gap-4 p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--abu-text-primary)]">
                    {exp.title()}
                  </p>
                  <p className="text-xs text-[var(--abu-text-muted)] mt-0.5">
                    {exp.description()}
                  </p>
                  <p className="text-[11px] text-[var(--abu-clay)] mt-1.5">
                    {exp.locationHint()}
                  </p>
                </div>
                <Toggle
                  checked={enabled}
                  onChange={() => handleToggle(exp.id, !enabled)}
                  size="lg"
                />
              </div>
            );
          })}
        </div>
    </div>
  );
}
