import { useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { type LanguageSetting, useI18n } from '@/i18n';
import { Trash2 } from 'lucide-react';
import { clearBehaviorData, testWindowPermission } from '@/core/agent/behaviorSensor';
import { testScreenshotPermission } from '@/core/agent/computerUsePermission';
import { useToastStore } from '@/stores/toastStore';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';

export default function GeneralSection() {
  const closeAction = useSettingsStore(s => s.closeAction);
  const setCloseAction = useSettingsStore(s => s.setCloseAction);
  const { language, setLanguage } = useSettingsStore();
  const behaviorSensorEnabled = useSettingsStore(s => s.behaviorSensorEnabled);
  const setBehaviorSensorEnabled = useSettingsStore(s => s.setBehaviorSensorEnabled);
  const computerUseEnabled = useSettingsStore(s => s.computerUseEnabled);
  const setComputerUseEnabled = useSettingsStore(s => s.setComputerUseEnabled);
  const [sensorTesting, setSensorTesting] = useState(false);
  const [computerUseTesting, setComputerUseTesting] = useState(false);
  const { t } = useI18n();

  const handleToggleSensor = async () => {
    if (behaviorSensorEnabled) {
      setBehaviorSensorEnabled(false);
      return;
    }
    setSensorTesting(true);
    const hasPermission = await testWindowPermission();
    setSensorTesting(false);
    if (hasPermission) {
      setBehaviorSensorEnabled(true);
    } else {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.settings.behaviorSensorPermissionDenied,
        message: t.settings.behaviorSensorPermissionGuide,
      });
    }
  };

  const handleToggleComputerUse = async () => {
    if (computerUseEnabled) {
      setComputerUseEnabled(false);
      return;
    }
    setComputerUseTesting(true);
    const hasPermission = await testScreenshotPermission();
    setComputerUseTesting(false);
    if (hasPermission) {
      setComputerUseEnabled(true);
    } else {
      useToastStore.getState().addToast({
        type: 'error',
        title: t.settings.computerUsePermissionDenied,
        message: t.settings.computerUsePermissionGuide,
      });
    }
  };

  const closeOptions = [
    { value: 'ask', label: t.settings.closeWindowAsk },
    { value: 'minimize', label: t.settings.closeWindowMinimize },
    { value: 'quit', label: t.settings.closeWindowQuit },
  ];

  const languageOptions = [
    { value: 'system', label: t.settings.followSystem },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ];

  return (
    <div className="space-y-8">
      {/* Language */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <p className="text-sm text-[var(--abu-text-primary)]">{t.settings.language}</p>
        <Select
          variant="inline"
          value={language}
          options={languageOptions}
          onChange={(v) => setLanguage(v as LanguageSetting)}
        />
      </div>

      {/* Close window behavior */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <p className="text-sm text-[var(--abu-text-primary)]">{t.settings.closeWindowBehavior}</p>
        <Select
          variant="inline"
          value={closeAction}
          options={closeOptions}
          onChange={(v) => setCloseAction(v as 'ask' | 'minimize' | 'quit')}
        />
      </div>

      {/* Behavior sensor */}
      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
          <div className="flex-1 mr-4">
            <p className="text-sm text-[var(--abu-text-primary)]">{t.settings.behaviorSensor}</p>
            <p className="text-xs text-[var(--abu-text-muted)] mt-0.5">{t.settings.behaviorSensorDesc}</p>
          </div>
          <Toggle
            checked={behaviorSensorEnabled}
            onChange={handleToggleSensor}
            size="lg"
            disabled={sensorTesting}
          />
        </div>
        {behaviorSensorEnabled && (
          <button
            onClick={async () => {
              await clearBehaviorData();
              useToastStore.getState().addToast({
                type: 'success',
                title: t.settings.behaviorSensorCleared,
              });
            }}
            className="flex items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.settings.behaviorSensorClearData}
          </button>
        )}
      </div>

      {/* Computer Use */}
      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
          <div className="flex-1 mr-4">
            <p className="text-sm text-[var(--abu-text-primary)]">{t.settings.computerUse}</p>
            <p className="text-xs text-[var(--abu-text-muted)] mt-0.5">{t.settings.computerUseDesc}</p>
          </div>
          <Toggle
            checked={computerUseEnabled}
            onChange={handleToggleComputerUse}
            size="lg"
            disabled={computerUseTesting}
          />
        </div>
      </div>
    </div>
  );
}
