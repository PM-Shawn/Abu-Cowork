import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { LABS_EXPERIMENTS, LABS_PET } from '@/core/labs/registry';
import { resolveLabsFlag } from '@/core/labs/resolve';
import { hidePet } from '@/core/pet/petVisibility';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { Switch } from '@/components/ds/switch';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';

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
    return <EmptyState icon={AppIcons.labs} title={t.settings.labsEmpty} description={t.settings.labsEmptyHint} />;
  }

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t.settings.labs} description={t.settings.labsDescription} />

      <SettingGroup>
        {LABS_EXPERIMENTS.map((exp) => {
          const enabled = resolveLabsFlag(exp.id, labs);
          return (
            <SettingRow
              key={exp.id}
              title={exp.title()}
              htmlFor={`lab-${exp.id}`}
              description={(
                <>
                  {exp.description()}
                  <span className="mt-1 block text-caption text-label-tertiary">{exp.locationHint()}</span>
                </>
              )}
            >
              <Switch id={`lab-${exp.id}`} checked={enabled} onCheckedChange={(next) => handleToggle(exp.id, next)} />
            </SettingRow>
          );
        })}
      </SettingGroup>
    </div>
  );
}
