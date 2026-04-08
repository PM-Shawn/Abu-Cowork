import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n, type LanguageSetting } from '@/i18n';
import { Brain, Thermometer, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Toggle } from '@/components/ui/toggle';

const languageOptions: { value: LanguageSetting; label: string; nativeLabel?: string }[] = [
  { value: 'system', label: 'Follow System', nativeLabel: '跟随系统' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
];

export default function AdvancedSection() {
  const { t } = useI18n();
  const {
    temperature, enableThinking, thinkingBudget, language,
    setTemperature, setEnableThinking, setThinkingBudget, setLanguage,
  } = useSettingsStore();

  return (
    <div className="space-y-6">
      {/* Temperature slider */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-[var(--abu-text-primary)] flex items-center gap-2">
            <Thermometer className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
            {t.settings.temperature}
          </label>
          <span className="text-sm font-mono text-[var(--abu-text-primary)] bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] px-2 py-0.5 rounded">
            {temperature.toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={temperature}
          onChange={(e) => setTemperature(parseFloat(e.target.value))}
          className="w-full h-2 bg-[var(--abu-bg-hover)] rounded-lg appearance-none cursor-pointer accent-[var(--abu-clay)]"
        />
        <div className="flex justify-between text-xs text-[var(--abu-text-tertiary)]">
          <span>{t.settings.temperaturePrecise}</span>
          <span>{t.settings.temperatureCreative}</span>
        </div>
        <p className="text-xs text-[var(--abu-text-tertiary)] leading-relaxed">
          {t.settings.temperatureDescription}
        </p>
      </div>

      {/* Extended Thinking toggle */}
      <div className="p-4 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-[var(--abu-text-primary)] flex items-center gap-2">
            <Brain className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
            {t.settings.extendedThinking}
          </label>
          <Toggle
            checked={enableThinking}
            onChange={() => setEnableThinking(!enableThinking)}
            size="lg"
          />
        </div>
        <p className="text-xs text-[var(--abu-text-tertiary)]">
          {t.settings.extendedThinkingDescription}
        </p>

        {/* Thinking Budget */}
        {enableThinking && (
          <div className="pt-3 border-t border-[var(--abu-border)] space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm text-[var(--abu-text-tertiary)]">{t.settings.thinkingBudget}</label>
              <span className="text-sm font-mono text-[var(--abu-text-primary)]">
                {thinkingBudget.toLocaleString()}
              </span>
            </div>
            <input
              type="range"
              min="1000"
              max="50000"
              step="1000"
              value={thinkingBudget}
              onChange={(e) => setThinkingBudget(parseInt(e.target.value))}
              className="w-full h-2 bg-[var(--abu-bg-hover)] rounded-lg appearance-none cursor-pointer accent-[var(--abu-clay)]"
            />
            <div className="flex justify-between text-xs text-[var(--abu-text-tertiary)]">
              <span>{t.settings.thinkingBudgetFast}</span>
              <span>{t.settings.thinkingBudgetDeep}</span>
            </div>
          </div>
        )}
      </div>

      {/* Language selector */}
      <div className="p-4 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-[var(--abu-text-primary)] flex items-center gap-2">
            <Globe className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
            {t.settings.language}
          </label>
        </div>
        <p className="text-xs text-[var(--abu-text-tertiary)]">
          {t.settings.languageDescription}
        </p>
        <div className="flex gap-2 pt-1">
          {languageOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setLanguage(option.value)}
              className={cn(
                'px-3 py-1.5 text-sm rounded-lg border transition-colors',
                language === option.value
                  ? 'bg-[var(--abu-text-primary)] text-white border-[var(--abu-text-primary)]'
                  : 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-tertiary)] border-[var(--abu-border)] hover:border-[var(--abu-border-hover)] hover:text-[var(--abu-text-primary)]'
              )}
            >
              {option.value === 'system'
                ? t.settings.followSystem
                : option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
