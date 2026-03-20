import { useSettingsStore, getEffectiveModel, PROVIDER_CONFIGS, getAvailableProviders } from '@/stores/settingsStore';
import type { LLMProvider } from '@/types';
import type { SelectOptionGroup } from '@/components/ui/select';
import { Eye, EyeOff, CircleCheck, CircleAlert, Thermometer, ChevronDown, Save, Pencil, Trash2 } from 'lucide-react';
import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';

// Custom service IDs use a prefix to distinguish from built-in provider IDs
const CUSTOM_SERVICE_PREFIX = 'cs:';

export default function ModelConfigSection() {
  const store = useSettingsStore();
  const {
    provider, apiFormat, model, customModel, apiKey, baseUrl,
    temperature, customServices, activeCustomServiceId,
    setApiFormat, setModel, setCustomModel, setApiKey, setBaseUrl,
    setTemperature,
    switchProvider, saveCustomService, updateCustomService, deleteCustomService, switchToCustomService,
  } = store;

  const { t } = useI18n();
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveName, setSaveName] = useState('');

  const effectiveModel = getEffectiveModel(store);
  const hasApiKey = apiKey.trim().length > 0;

  const currentProviderConfig = PROVIDER_CONFIGS[provider] ?? PROVIDER_CONFIGS.anthropic;
  const isCustomProvider = provider === 'custom';
  const hasBaseUrl = !isCustomProvider || baseUrl.trim().length > 0;
  const hasModel = !!effectiveModel;

  // Build grouped provider options
  const providerOptions = useMemo(() => {
    const allProviders = getAvailableProviders();
    const builtinIds = allProviders.filter((id) => id !== 'custom' && id !== 'local');
    const otherIds = allProviders.filter((id) => id === 'custom' || id === 'local');

    const groups: SelectOptionGroup[] = [
      {
        label: t.settings.builtinProviders,
        options: builtinIds.map((id) => ({ value: id, label: PROVIDER_CONFIGS[id].name })),
      },
    ];

    if (customServices.length > 0) {
      groups.push({
        label: t.settings.myCustomServices,
        options: customServices.map((svc) => ({
          value: CUSTOM_SERVICE_PREFIX + svc.id,
          label: svc.name,
        })),
      });
    }

    groups.push({
      label: t.settings.otherProviders,
      options: otherIds.map((id) => ({ value: id, label: PROVIDER_CONFIGS[id].name })),
    });

    return groups;
  }, [customServices, t]);

  // Current selected value in the dropdown (may be a custom service ID)
  const selectedDropdownValue = activeCustomServiceId
    ? CUSTOM_SERVICE_PREFIX + activeCustomServiceId
    : provider;

  const handleProviderChange = (value: string) => {
    if (value.startsWith(CUSTOM_SERVICE_PREFIX)) {
      const serviceId = value.slice(CUSTOM_SERVICE_PREFIX.length);
      switchToCustomService(serviceId);
    } else {
      switchProvider(value as LLMProvider);
    }
  };

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) return;
    saveCustomService(name);
    setSaveName('');
    setShowSaveDialog(false);
  };

  const handleDelete = () => {
    if (!activeCustomServiceId) return;
    if (!confirm(t.settings.deleteServiceConfirm)) return;
    deleteCustomService(activeCustomServiceId);
    // After deletion, stay on custom provider with cleared fields
    switchProvider('custom');
  };

  // Available model list (map to SelectOption format)
  const availableModels = (isCustomProvider
    ? (customModel ? [{ id: customModel, label: customModel }] : [])
    : currentProviderConfig.models
  ).map(m => ({ value: m.id, label: m.label }));

  return (
    <div className="space-y-5">
      {/* Current config status */}
      <div className="p-4 bg-[#f5f3ee] rounded-xl space-y-3">
        <h4 className="text-xs font-medium text-[#656358] uppercase tracking-wider">{t.settings.currentConfig}</h4>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            {hasApiKey ? (
              <CircleCheck className="h-4 w-4 text-green-600 flex-none" />
            ) : (
              <CircleAlert className="h-4 w-4 text-amber-500 flex-none" />
            )}
            <span className="text-[#656358]">{t.settings.apiKey}:</span>
            <span className={cn(hasApiKey ? 'text-green-600' : 'text-amber-600', 'font-medium')}>
              {hasApiKey ? t.settings.configured : t.settings.notConfigured}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {hasBaseUrl ? (
              <CircleCheck className="h-4 w-4 text-green-600 flex-none" />
            ) : (
              <CircleAlert className="h-4 w-4 text-amber-500 flex-none" />
            )}
            <span className="text-[#656358]">{t.settings.provider}:</span>
            <span className={cn(hasBaseUrl ? 'text-[#29261b]' : 'text-amber-600', 'font-medium')}>
              {activeCustomServiceId
                ? customServices.find((s) => s.id === activeCustomServiceId)?.name ?? currentProviderConfig.name
                : currentProviderConfig.name}
              {!hasBaseUrl && ` (${t.settings.notConfigured})`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {hasModel ? (
              <CircleCheck className="h-4 w-4 text-green-600 flex-none" />
            ) : (
              <CircleAlert className="h-4 w-4 text-amber-500 flex-none" />
            )}
            <span className="text-[#656358]">{t.settings.model}:</span>
            <span className={cn(hasModel ? 'text-[#29261b]' : 'text-amber-600', 'font-medium truncate')}>
              {effectiveModel || t.settings.notSet}
            </span>
          </div>
        </div>
      </div>

      {/* Provider selector (grouped) */}
      <div className="space-y-2">
        <label className="text-xs text-[#656358] font-medium">{t.settings.provider}</label>
        <Select
          value={selectedDropdownValue}
          options={providerOptions}
          onChange={handleProviderChange}
          placeholder={t.settings.selectProvider}
        />
      </div>

      {/* Custom API URL (custom provider only) */}
      {isCustomProvider && (
        <div className="space-y-2">
          <label className="text-xs text-[#656358] font-medium">{t.settings.apiUrl} <span className="text-red-400">*</span></label>
          <Input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-api.com"
          />
          <p className="text-xs text-[#888579]">{t.settings.apiUrlDesc}</p>
        </div>
      )}

      {/* Custom model name (custom provider only) */}
      {isCustomProvider && (
        <div className="space-y-2">
          <label className="text-xs text-[#656358] font-medium">{t.settings.customModelName} <span className="text-red-400">*</span></label>
          <Input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder={t.settings.customModelPlaceholder}
          />
        </div>
      )}

      {/* API format selector — only for custom/local where we can't auto-detect */}
      {(isCustomProvider || provider === 'local') && (
        <div className="space-y-2">
          <label className="text-xs text-[#656358] font-medium">{t.settings.apiFormat}</label>
          <div className="flex gap-2">
            <button
              onClick={() => setApiFormat('openai-compatible')}
              className={cn(
                'flex-1 h-9 px-3 rounded-lg text-sm font-medium transition-all',
                apiFormat === 'openai-compatible'
                  ? 'bg-[#d97757] text-white'
                  : 'bg-[#f5f3ee] text-[#656358] hover:bg-[#e8e5de]'
              )}
            >
              {t.settings.openaiCompatible}
            </button>
            <button
              onClick={() => setApiFormat('anthropic')}
              className={cn(
                'flex-1 h-9 px-3 rounded-lg text-sm font-medium transition-all',
                apiFormat === 'anthropic'
                  ? 'bg-[#d97757] text-white'
                  : 'bg-[#f5f3ee] text-[#656358] hover:bg-[#e8e5de]'
              )}
            >
              {t.settings.anthropicCompatible}
            </button>
          </div>
        </div>
      )}

      {/* Model selector (built-in providers) */}
      {!isCustomProvider && availableModels.length > 0 && (
        <div className="space-y-2">
          <label className="text-xs text-[#656358] font-medium">{t.settings.model}</label>
          <Select
            value={model}
            options={availableModels}
            onChange={(v) => setModel(v)}
            placeholder={t.settings.selectModel}
          />
        </div>
      )}

      {/* API Key */}
      <div className="space-y-2">
        <label className="text-xs text-[#656358] font-medium">{t.settings.apiKey} <span className="text-red-400">*</span></label>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[#888579] hover:text-[#656358] transition-colors"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className="text-xs text-[#888579]">{t.settings.apiKeyDesc}</p>
      </div>

      {/* Save / Update / Delete custom service (custom provider only) */}
      {isCustomProvider && (
        <div className="space-y-3">
          {showSaveDialog ? (
            <div className="p-3 bg-[#f5f3ee] rounded-xl space-y-3">
              <label className="text-xs text-[#656358] font-medium">{t.settings.saveServiceName}</label>
              <Input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={t.settings.saveServicePlaceholder}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setShowSaveDialog(false); }}
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={!saveName.trim()}
                  className={cn(
                    'flex-1 h-8 px-3 rounded-lg text-sm font-medium transition-all',
                    saveName.trim()
                      ? 'bg-[#d97757] text-white hover:bg-[#c4684a]'
                      : 'bg-[#e8e4dd] text-[#b8b5ab] cursor-not-allowed'
                  )}
                >
                  {t.settings.saveServiceConfirm}
                </button>
                <button
                  onClick={() => { setShowSaveDialog(false); setSaveName(''); }}
                  className="flex-1 h-8 px-3 rounded-lg text-sm font-medium bg-[#f5f3ee] text-[#656358] hover:bg-[#e8e5de] transition-all"
                >
                  {t.settings.saveServiceCancel}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              {activeCustomServiceId ? (
                <>
                  <button
                    onClick={() => updateCustomService(activeCustomServiceId)}
                    className="flex-1 flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-sm font-medium bg-[#f5f3ee] text-[#656358] hover:bg-[#e8e5de] transition-all"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    {t.settings.updateConfig}
                  </button>
                  <button
                    onClick={handleDelete}
                    className="flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-sm font-medium bg-[#f5f3ee] text-red-500 hover:bg-red-50 transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {t.settings.deleteConfig}
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowSaveDialog(true)}
                  disabled={!baseUrl.trim() || !customModel.trim()}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg text-sm font-medium transition-all',
                    baseUrl.trim() && customModel.trim()
                      ? 'bg-[#d97757] text-white hover:bg-[#c4684a]'
                      : 'bg-[#e8e4dd] text-[#b8b5ab] cursor-not-allowed'
                  )}
                >
                  <Save className="h-3.5 w-3.5" />
                  {t.settings.saveCurrentConfig}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Advanced parameters */}
      <div className="border border-[#e8e4dd] rounded-xl overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between px-4 py-3 bg-white hover:bg-[#f5f3ee] transition-colors"
        >
          <span className="text-sm font-medium text-[#29261b]">{t.settings.advanced}</span>
          <ChevronDown className={cn('h-4 w-4 text-[#888579] transition-transform', showAdvanced && 'rotate-180')} />
        </button>

        {showAdvanced && (
          <div className="px-4 pb-4 space-y-4 bg-white border-t border-[#e8e4dd]">
            {/* Temperature */}
            <div className="space-y-2 pt-4">
              <div className="flex items-center justify-between">
                <label className="text-xs text-[#656358] font-medium flex items-center gap-1.5">
                  <Thermometer className="h-3.5 w-3.5" />
                  {t.settings.temperature}
                </label>
                <span className="text-xs font-mono text-[#29261b]">{temperature.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value))}
                className="w-full slider-filled"
                style={{ '--slider-progress': `${temperature * 100}%` } as React.CSSProperties}
              />
              <div className="flex justify-between text-[10px] text-[#888579]">
                <span>{t.settings.temperaturePrecise}</span>
                <span>{t.settings.temperatureCreative}</span>
              </div>
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
