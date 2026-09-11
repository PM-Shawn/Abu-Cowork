import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useSettingsStore } from '@/stores/settingsStore';
import { type LanguageSetting, format, useI18n } from '@/i18n';
import type { ComposerEnterBehavior } from '@/components/chat/composerKeys';
import { isMacOS } from '@/utils/platform';
import { Trash2 } from 'lucide-react';
import { clearBehaviorData, testWindowPermission } from '@/core/agent/behaviorSensor';
import { useToastStore } from '@/stores/toastStore';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { buildAgentMaxTurnsOptions } from '@/core/agent/maxTurnsNotice';
import { DEFAULT_MAX_TURNS } from '@/core/agent/loopGuards';

/**
 * One width for every control on the right of a settings row.
 *
 * `Select variant="inline"` is `w-full`, so without a sized wrapper each row's
 * control is as wide as the option it happens to be showing and the column
 * comes out ragged. Sized here rather than inside `Select` because the width
 * belongs to this page's layout, not to the control.
 */
const SETTINGS_CONTROL_WIDTH = 'w-40 shrink-0';

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
    // 0 only appears when it is already in force (see buildAgentMaxTurnsOptions)
    // — it is shown so the menu doesn't misreport the cap, not offered as new.
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

  const themeOptions = [
    { value: 'light', label: t.settings.appearanceLight },
    { value: 'system', label: t.settings.appearanceSystem },
    { value: 'dark', label: t.settings.appearanceDark },
  ];

  const languageOptions = [
    { value: 'system', label: t.settings.followSystem },
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en-US', label: 'English' },
  ];

  return (
    <div className="space-y-8">
      <SettingsSectionHeader title={t.settings.general} description={t.settings.generalDescription} />

      {/* Appearance */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <p className="text-body text-[var(--abu-text-primary)]">{t.settings.appearance}</p>
        <div className={SETTINGS_CONTROL_WIDTH}>
          <Select
            variant="inline"
            value={theme}
            options={themeOptions}
            onChange={(v) => setTheme(v as 'light' | 'system' | 'dark')}
          />
        </div>
      </div>

      {/* Language */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <p className="text-body text-[var(--abu-text-primary)]">{t.settings.language}</p>
        <div className={SETTINGS_CONTROL_WIDTH}>
          <Select
            variant="inline"
            value={language}
            options={languageOptions}
            onChange={(v) => setLanguage(v as LanguageSetting)}
          />
        </div>
      </div>

      {/* Agent max turns */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <div className="flex-1 mr-4">
          <p className="text-body text-[var(--abu-text-primary)]">{t.settings.agentMaxTurns}</p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{t.settings.agentMaxTurnsDesc}</p>
        </div>
        <div className={SETTINGS_CONTROL_WIDTH}>
          <Select
            variant="inline"
            value={String(agentMaxTurns ?? DEFAULT_MAX_TURNS)}
            options={maxTurnsOptions}
            onChange={(v) => setAgentMaxTurns(Number(v))}
          />
        </div>
      </div>

      {/* Close window behavior */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <p className="text-body text-[var(--abu-text-primary)]">{t.settings.closeWindowBehavior}</p>
        <div className={SETTINGS_CONTROL_WIDTH}>
          <Select
            variant="inline"
            value={closeAction}
            options={closeOptions}
            onChange={(v) => setCloseAction(v as 'ask' | 'minimize' | 'quit')}
          />
        </div>
      </div>

      {/* Composer send shortcut */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <div className="flex-1 mr-4">
          <p className="text-body text-[var(--abu-text-primary)]">{t.settings.composerEnterBehavior}</p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{t.settings.composerEnterBehaviorDesc}</p>
        </div>
        <div className={SETTINGS_CONTROL_WIDTH}>
          <Select
            variant="inline"
            value={composerEnterBehavior}
            options={enterBehaviorOptions}
            onChange={(v) => setComposerEnterBehavior(v as ComposerEnterBehavior)}
          />
        </div>
      </div>

      {/* Behavior sensor */}
      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
          <div className="flex-1 mr-4">
            <p className="text-body text-[var(--abu-text-primary)]">{t.settings.behaviorSensor}</p>
            <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{t.settings.behaviorSensorDesc}</p>
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
            className="flex items-center gap-2 px-3 py-2 text-minor text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] rounded-lg transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.settings.behaviorSensorClearData}
          </button>
        )}
      </div>

      {/* Prevent sleep */}
      <div className="flex items-center justify-between p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
        <div className="flex-1 mr-4">
          <p className="text-body text-[var(--abu-text-primary)]">{t.settings.preventSleep}</p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{t.settings.preventSleepDesc}</p>
        </div>
        <Toggle
          checked={preventSleep}
          onChange={handleTogglePreventSleep}
          size="lg"
        />
      </div>
    </div>
  );
}
