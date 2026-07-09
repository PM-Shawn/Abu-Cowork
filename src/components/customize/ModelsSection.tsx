import { useSettingsStore, getEffectiveModel, getActiveProvider, getActiveApiKey } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { modelPresets } from '@/data/marketplace/mcp';
import type { ModelPreset } from '@/types/marketplace';
import { Cpu, Check, ExternalLink, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

// Static — modelPresets never changes at runtime
const presetsByProvider = modelPresets.reduce<Record<string, ModelPreset[]>>((acc, p) => {
  (acc[p.provider] ??= []).push(p);
  return acc;
}, {});

// Ordered preset groups with labels (label resolved at render time via key)
const PRESET_GROUP_KEYS = [
  { key: 'volcengine', labelKey: 'volcengine' as const },
  { key: 'bailian', labelKey: 'bailian' as const },
  { key: 'deepseek', labelKey: 'deepseek' as const },
  { key: 'anthropic', labelKey: 'anthropic' as const },
  { key: 'openai', labelKey: 'openaiCompatible' as const },
  { key: 'qiniu', labelKey: 'qiniuCloud' as const },
  { key: 'openrouter', labelKey: 'openrouter' as const },
  { key: 'local', labelKey: 'localModels' as const },
] as const;

export default function ModelsSection() {
  const {
    activeModel,
    providers,
    selectModel,
    openSystemSettings,
  } = useSettingsStore();
  const { t, locale } = useI18n();
  const pick = (zh: string, en?: string) => (locale.startsWith('zh') ? zh : (en ?? zh));

  const effectiveModel = getEffectiveModel(useSettingsStore.getState());
  const activeProvider = getActiveProvider(useSettingsStore.getState());
  const hasApiKey = !!getActiveApiKey(useSettingsStore.getState());

  // Check if a preset matches current config
  const isPresetActive = (preset: ModelPreset) => {
    return (
      preset.provider === activeModel.providerId &&
      preset.model === activeModel.modelId
    );
  };

  // Apply preset: find the matching provider and select the model
  const handleApplyPreset = (preset: ModelPreset) => {
    // Find a matching enabled provider
    const matchingProvider = providers.find(p => p.id === preset.provider && p.enabled);
    if (matchingProvider) {
      // Check if the model exists in the provider
      const modelExists = matchingProvider.models.some(m => m.id === preset.model);
      if (modelExists) {
        selectModel(matchingProvider.id, preset.model);
      }
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-1 overflow-y-auto px-4">
        {/* Current Configuration */}
        <div className="py-4">
          <div className="flex items-center gap-2 mb-3">
            <Cpu className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
            <h3 className="text-sm font-medium text-[var(--abu-text-secondary)]">{t.toolbox.currentConfig}</h3>
          </div>

          <div className="p-4 rounded-lg bg-[var(--abu-bg-muted)] border border-[var(--abu-border)]/60">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--abu-text-tertiary)]">{t.settings.model}</span>
                <span className="text-sm font-medium text-[var(--abu-text-primary)] font-mono">
                  {effectiveModel || t.settings.notSet}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--abu-text-tertiary)]">{t.settings.provider}</span>
                <span className="text-sm text-[var(--abu-text-secondary)]">{activeProvider?.name ?? '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--abu-text-tertiary)]">{t.settings.apiFormat}</span>
                <span className="text-sm text-[var(--abu-text-secondary)]">{activeProvider?.apiFormat ?? '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--abu-text-tertiary)]">{t.settings.apiKey}</span>
                <span className="text-sm text-[var(--abu-text-secondary)]">
                  {hasApiKey ? (
                    <span className="flex items-center gap-1 text-green-600">
                      <Check className="h-3.5 w-3.5" />
                      {t.toolbox.configured}
                    </span>
                  ) : (
                    <span className="text-amber-600">{t.toolbox.notConfigured}</span>
                  )}
                </span>
              </div>
              {activeProvider?.baseUrl && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-[var(--abu-text-tertiary)]">Base URL</span>
                  <span className="text-sm text-[var(--abu-text-secondary)] font-mono text-right max-w-[200px] truncate">
                    {activeProvider.baseUrl}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-[var(--abu-border)] my-2" />

        {/* Model Presets */}
        <div className="py-4">
          <div className="flex items-center gap-2 mb-3">
            <Zap className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
            <h3 className="text-sm font-medium text-[var(--abu-text-secondary)]">{t.toolbox.quickSwitch}</h3>
          </div>

          {PRESET_GROUP_KEYS.map(({ key, labelKey }) => {
            const presets = presetsByProvider[key];
            if (!presets || presets.length === 0) return null;
            return (
              <div key={key} className="mb-4">
                <div className="text-xs font-medium text-[var(--abu-text-muted)] mb-2 uppercase tracking-wide">
                  {t.toolbox[labelKey]}
                </div>
                <div className="space-y-2">
                  {presets.map((preset) => {
                    const isActive = isPresetActive(preset);
                    return (
                      <button
                        key={preset.id}
                        onClick={() => handleApplyPreset(preset)}
                        className={cn(
                          'w-full flex items-center gap-3 p-3 rounded-lg border transition-colors text-left',
                          isActive
                            ? 'bg-[var(--abu-clay-bg)] border-[var(--abu-clay-ring)]'
                            : 'bg-[var(--abu-bg-muted)] border-[var(--abu-border)]/60 hover:border-[var(--abu-border-hover)]'
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-[var(--abu-text-primary)]">{pick(preset.name, preset.nameEn)}</span>
                            {isActive && (
                              <span className="text-[10px] px-1.5 py-0.5 bg-[var(--abu-clay-20)] text-[var(--abu-clay)] rounded">
                                {t.toolbox.current}
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[var(--abu-text-tertiary)] mt-0.5">{pick(preset.description, preset.descriptionEn)}</p>
                        </div>
                        {isActive && <Check className="h-4 w-4 text-[var(--abu-clay)] shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Divider */}
        <div className="border-t border-[var(--abu-border)] my-2" />

        {/* Advanced Settings Link */}
        <div className="py-4 pb-6">
          <button
            onClick={() => openSystemSettings('ai-services')}
            className="w-full flex items-center justify-between p-3 rounded-lg border border-[var(--abu-border)]/60 hover:border-[var(--abu-border-hover)] hover:bg-[var(--abu-bg-muted)]/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-[var(--abu-bg-active)] flex items-center justify-center">
                <ExternalLink className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
              </div>
              <div className="text-left">
                <div className="text-sm font-medium text-[var(--abu-text-primary)]">{t.toolbox.advancedSettings}</div>
                <div className="text-xs text-[var(--abu-text-tertiary)]">{t.toolbox.advancedSettingsDesc}</div>
              </div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
