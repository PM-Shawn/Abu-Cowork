import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { Switch } from '@/components/ds/switch';
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
    <SettingGroup>
      <SettingRow title={t.settings.petEnable} description={t.settings.petEnableDesc} htmlFor="setting-pet-enable">
        <Switch id="setting-pet-enable" checked={petOpen} onCheckedChange={handleTogglePet} />
      </SettingRow>
    </SettingGroup>
  );
}
