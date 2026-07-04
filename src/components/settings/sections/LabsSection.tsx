import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { LABS_EXPERIMENTS, LABS_PET } from '@/core/labs/registry';
import { resolveLabsFlag } from '@/core/labs/resolve';
import { Toggle } from '@/components/ui/toggle';
import { FlaskConical } from 'lucide-react';

export default function LabsSection() {
  // Subscribe to the whole labs slice via useI18n's sibling store so the list
  // re-renders on toggle; resolveLabsFlag reads the current stored map.
  const { t } = useI18n();
  const labs = useSettingsStore((s) => s.labs);
  const setLabsFlag = useSettingsStore((s) => s.setLabsFlag);
  // Pet is a Labs experiment too, but its on/off drives a native Tauri window
  // and lives in `petOpen` (not the generic labs map) — so LABS_PET is bound to
  // petOpen + pet_show/pet_hide here rather than setLabsFlag.
  const petOpen = useSettingsStore((s) => s.petOpen);
  const setPetOpen = useSettingsStore((s) => s.setPetOpen);
  const togglePet = async (next: boolean) => {
    await invoke(next ? 'pet_show' : 'pet_hide').catch((err) => {
      console.warn('[LabsSection] pet_show/pet_hide failed:', err);
    });
    setPetOpen(next);
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
      <p className="text-sm text-[var(--abu-text-tertiary)]">
        {t.settings.labsDescription}
      </p>

      <div className="space-y-2">
        {LABS_EXPERIMENTS.map((exp) => {
          const isPet = exp.id === LABS_PET;
          const enabled = isPet ? petOpen : resolveLabsFlag(exp.id, labs);
          const onToggle = isPet
            ? () => togglePet(!petOpen)
            : () => setLabsFlag(exp.id, !enabled);
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
                  <p className="text-[11px] text-[var(--abu-text-muted)] mt-1 opacity-70">
                    {t.settings.labsChangeHint}
                  </p>
                </div>
                <Toggle
                  checked={enabled}
                  onChange={onToggle}
                  size="lg"
                />
              </div>
            );
          })}
        </div>
    </div>
  );
}
