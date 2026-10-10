import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '@/stores/settingsStore';
import { type LanguageSetting, format, useI18n } from '@/i18n';
import type { ComposerEnterBehavior } from '@/components/chat/composerKeys';
import { isMacOS } from '@/utils/platform';
import { clearBehaviorData, testWindowPermission } from '@/core/agent/behaviorSensor';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { Select } from '@/components/ds/select';
import { SettingGroup, SettingRow } from '@/components/ds/setting-row';
import { Switch } from '@/components/ds/switch';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { SETTING_CONTROL_WIDTH } from '@/components/settings/settingsLayout';
import { buildAgentMaxTurnsOptions } from '@/core/agent/maxTurnsNotice';
import { DEFAULT_MAX_TURNS } from '@/core/agent/loopGuards';

export default function GeneralSection() {
  const closeAction = useSettingsStore(s => s.closeAction);
  const setCloseAction = useSettingsStore(s => s.setCloseAction);
  const { language, setLanguage } = useSettingsStore();
  const behaviorSensorEnabled = useSettingsStore(s => s.behaviorSensorEnabled);
  const setBehaviorSensorEnabled = useSettingsStore(s => s.setBehaviorSensorEnabled);
  const preventSleep = useSettingsStore(s => s.preventSleep);
  const setPreventSleep = useSettingsStore(s => s.setPreventSleep);
  const [sensorTesting, setSensorTesting] = useState(false);
  const { t } = useI18n();
  const composerEnterBehavior = useSettingsStore(s => s.composerEnterBehavior);
  const setComposerEnterBehavior = useSettingsStore(s => s.setComposerEnterBehavior);
  const theme = useSettingsStore(s => s.theme);
  const setTheme = useSettingsStore(s => s.setTheme);
  const agentMaxTurns = useSettingsStore(s => s.agentMaxTurns);
  const setAgentMaxTurns = useSettingsStore(s => s.setAgentMaxTurns);
  const maxTurnsOptions = buildAgentMaxTurnsOptions(agentMaxTurns).map((turns) => ({
    value: String(turns),
    label: turns <= 0
      ? t.settings.agentMaxTurnsUnlimited
      : format(t.settings.agentMaxTurnsOption, { n: turns }),
  }));

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

  const handleTogglePreventSleep = async () => {
    const next = !preventSleep;
    // Best-effort: if Tauri command fails (e.g. caffeinate not available),
    // we still update UI state so the preference is persisted for the next launch.
    await invoke('set_prevent_sleep', { enabled: next }).catch((err) => {
      console.warn('[GeneralSection] set_prevent_sleep failed:', err);
    });
    setPreventSleep(next);
  };

  const closeOptions = [
    { value: 'ask', label: t.settings.closeWindowAsk },
    { value: 'minimize', label: t.settings.closeWindowMinimize },
    { value: 'quit', label: t.settings.closeWindowQuit },
  ];

  // Spelled out per platform: the send modifier is ⌘ on macOS, Ctrl elsewhere,
  // and the whole point of this setting is knowing which key does what.
  const enterBehaviorOptions = [
    { value: 'enter', label: t.settings.composerEnterSends },
    {
      value: 'newline',
      label: format(t.settings.composerEnterNewline, { modifier: isMacOS() ? '⌘' : 'Ctrl' }),
    },
  ];

  // 「跟随系统」排第一，和下面的语言一行读法一致：默认在最前，具体选项在后。
  const themeOptions = [
    { value: 'system', label: t.settings.appearanceSystem },
    { value: 'light', label: t.settings.appearanceLight },
    { value: 'dark', label: t.settings.appearanceDark },
  ];

  const languageOptions = [
    { value: 'system', label: t.settings.followSystem },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ];

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t.settings.general} description={t.settings.generalDescription} />

      <SettingGroup>
        <SettingRow title={t.settings.appearance}>
          <SegmentedControl
            label={t.settings.appearance}
            value={theme}
            options={themeOptions}
            onValueChange={(v) => setTheme(v as 'light' | 'system' | 'dark')}
          />
        </SettingRow>

        <SettingRow title={t.settings.language}>
          <div className={SETTING_CONTROL_WIDTH.general}>
            <Select
              fullWidth
              label={t.settings.language}
              value={language}
              options={languageOptions}
              onValueChange={(v) => setLanguage(v as LanguageSetting)}
            />
          </div>
        </SettingRow>

        <SettingRow title={t.settings.agentMaxTurns} description={t.settings.agentMaxTurnsDesc}>
          <div className={SETTING_CONTROL_WIDTH.general}>
            <Select
              fullWidth
              label={t.settings.agentMaxTurns}
              value={String(agentMaxTurns ?? DEFAULT_MAX_TURNS)}
              options={maxTurnsOptions}
              onValueChange={(v) => setAgentMaxTurns(Number(v))}
            />
          </div>
        </SettingRow>

        <SettingRow title={t.settings.closeWindowBehavior}>
          <div className={SETTING_CONTROL_WIDTH.general}>
            <Select
              fullWidth
              label={t.settings.closeWindowBehavior}
              value={closeAction}
              options={closeOptions}
              onValueChange={(v) => setCloseAction(v as 'ask' | 'minimize' | 'quit')}
            />
          </div>
        </SettingRow>

        <SettingRow title={t.settings.composerEnterBehavior} description={t.settings.composerEnterBehaviorDesc}>
          <div className={SETTING_CONTROL_WIDTH.general}>
            <Select
              fullWidth
              label={t.settings.composerEnterBehavior}
              value={composerEnterBehavior}
              options={enterBehaviorOptions}
              onValueChange={(v) => setComposerEnterBehavior(v as ComposerEnterBehavior)}
            />
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup>
        <SettingRow title={t.settings.behaviorSensor} description={t.settings.behaviorSensorDesc} htmlFor="setting-behavior-sensor">
          <Switch
            id="setting-behavior-sensor"
            checked={behaviorSensorEnabled}
            onCheckedChange={handleToggleSensor}
            disabled={sensorTesting}
          />
        </SettingRow>
        {behaviorSensorEnabled && (
          <div className="py-3">
            <Button
              variant="danger"
              size="sm"
              icon={AppIcons.delete}
              onClick={async () => {
                await clearBehaviorData();
                useToastStore.getState().addToast({
                  type: 'success',
                  title: t.settings.behaviorSensorCleared,
                });
              }}
            >
              {t.settings.behaviorSensorClearData}
            </Button>
          </div>
        )}

        <SettingRow title={t.settings.preventSleep} description={t.settings.preventSleepDesc} htmlFor="setting-prevent-sleep">
          <Switch
            id="setting-prevent-sleep"
            checked={preventSleep}
            onCheckedChange={handleTogglePreventSleep}
          />
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
