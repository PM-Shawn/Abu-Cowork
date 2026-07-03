import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { LABS_EXPERIMENTS } from '@/core/labs/registry';
import { resolveLabsFlag } from '@/core/labs/resolve';
import { Toggle } from '@/components/ui/toggle';

export default function LabsSection() {
  // Subscribe to the whole labs slice via useI18n's sibling store so the list
  // re-renders on toggle; resolveLabsFlag reads the current stored map.
  const { t } = useI18n();
  const labs = useSettingsStore((s) => s.labs);
  const setLabsFlag = useSettingsStore((s) => s.setLabsFlag);

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--abu-text-tertiary)]">
        {t.settings.labsDescription}
      </p>

      {LABS_EXPERIMENTS.length === 0 ? (
        <p className="text-xs text-[var(--abu-text-muted)] py-8 text-center">
          {t.settings.labsEmpty}
        </p>
      ) : (
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
                  <p className="text-[11px] text-[var(--abu-text-muted)] mt-1.5 opacity-70">
                    {t.settings.labsChangeHint}
                  </p>
                </div>
                <Toggle
                  checked={enabled}
                  onChange={() => setLabsFlag(exp.id, !enabled)}
                  size="lg"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
