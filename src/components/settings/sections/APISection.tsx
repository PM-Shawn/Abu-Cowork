import { useSettingsStore, getActiveApiKey } from '@/stores/settingsStore';
import type { LLMProvider } from '@/types';
import { useI18n } from '@/i18n';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';

export default function APISection() {
  const store = useSettingsStore();
  const {
    provider, apiFormat, baseUrl,
    setApiFormat, setApiKey, setBaseUrl, switchProvider,
  } = store;
  const apiKey = getActiveApiKey(store);
  const { t } = useI18n();

  const [showKey, setShowKey] = useState(false);

  return (
    <div className="space-y-5">
      {/* Provider */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[#29261b]">{t.settings.provider}</label>
        <Select
          value={provider}
          onChange={(value) => switchProvider(value as LLMProvider)}
          options={[
            { value: 'anthropic', label: t.settings.providerAnthropic },
            { value: 'openai', label: t.settings.providerOpenAI },
            { value: 'local', label: t.settings.providerLocal },
          ]}
        />
      </div>

      {/* API Format */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[#29261b]">{t.settings.apiProtocol}</label>
        <div className="flex gap-2">
          <button
            onClick={() => setApiFormat('openai-compatible')}
            className={cn(
              'flex-1 h-9 rounded-lg text-sm font-medium transition-colors border',
              apiFormat === 'openai-compatible'
                ? 'bg-[#29261b] text-white border-[#29261b]'
                : 'bg-white text-[#656358] border-[#e8e4dd] hover:border-[#d0cdc6]'
            )}
          >
            {t.settings.openaiCompatible}
          </button>
          <button
            onClick={() => setApiFormat('anthropic')}
            className={cn(
              'flex-1 h-9 rounded-lg text-sm font-medium transition-colors border',
              apiFormat === 'anthropic'
                ? 'bg-[#29261b] text-white border-[#29261b]'
                : 'bg-white text-[#656358] border-[#e8e4dd] hover:border-[#d0cdc6]'
            )}
          >
            {t.settings.anthropicCompatible}
          </button>
        </div>
        <p className="text-xs text-[#656358]">
          {apiFormat === 'openai-compatible'
            ? t.settings.openaiCompatibleDesc
            : t.settings.anthropicCompatibleDesc}
        </p>
      </div>

      {/* API Base URL */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[#29261b]">
          {t.settings.apiUrl}
          <span className="ml-1 text-[#656358] font-normal text-xs">({t.settings.apiUrlHint})</span>
        </label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://your-proxy.com"
          className="w-full h-10 px-3 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
        />
        <p className="text-xs text-[#656358]">
          {t.settings.apiUrlDesc}
        </p>
      </div>

      {/* API Key */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[#29261b]">{t.settings.apiKey}</label>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
            className="w-full h-10 px-3 pr-10 bg-white border border-[#e8e4dd] rounded-lg text-sm text-[#29261b] focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all"
          />
          <button
            onClick={() => setShowKey(!showKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[#656358] hover:text-[#29261b] rounded-md hover:bg-[#e8e5de] transition-colors"
          >
            {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className="text-xs text-[#656358]">
          {t.settings.apiKeyDesc}
        </p>
      </div>
    </div>
  );
}
