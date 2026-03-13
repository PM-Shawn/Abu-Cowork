import { useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Eye, EyeOff, ExternalLink } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { open } from '@tauri-apps/plugin-shell';
import type { WebSearchProviderType } from '@/core/search/providers';

const SEARCH_PROVIDERS: { id: WebSearchProviderType; labelKey: 'webSearchProviderBing' | 'webSearchProviderBrave' | 'webSearchProviderTavily' | 'webSearchProviderSearXNG'; signupUrl?: string }[] = [
  { id: 'tavily', labelKey: 'webSearchProviderTavily', signupUrl: 'https://tavily.com/' },
  { id: 'brave', labelKey: 'webSearchProviderBrave', signupUrl: 'https://brave.com/search/api/' },
  { id: 'searxng', labelKey: 'webSearchProviderSearXNG', signupUrl: 'https://docs.searxng.org/' },
  { id: 'bing', labelKey: 'webSearchProviderBing', signupUrl: 'https://www.microsoft.com/en-us/bing/apis/bing-web-search-api' },
];

/** Inline mode: renders only the form fields without section header */
export function WebSearchForm() {
  const {
    webSearchProvider,
    webSearchApiKey,
    webSearchBaseUrl,
    setWebSearchProvider,
    setWebSearchApiKey,
    setWebSearchBaseUrl,
  } = useSettingsStore();
  const { t } = useI18n();
  const [showKey, setShowKey] = useState(false);

  const isSearXNG = webSearchProvider === 'searxng';
  const currentProvider = SEARCH_PROVIDERS.find((p) => p.id === webSearchProvider);

  return (
    <div className="space-y-4">
      {/* Provider selection */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[#29261b]">{t.settings.webSearchProvider}</label>
        <Select
          value={webSearchProvider}
          onChange={(value) => setWebSearchProvider(value as WebSearchProviderType)}
          options={SEARCH_PROVIDERS.map((p) => ({ value: p.id, label: t.settings[p.labelKey] }))}
        />
        {currentProvider?.signupUrl && (
          <a
            href={currentProvider.signupUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-[#d97757] hover:underline mt-1"
            onClick={(e) => {
              e.preventDefault();
              open(currentProvider.signupUrl!);
            }}
          >
            <ExternalLink className="h-3 w-3" />
            {isSearXNG ? 'SearXNG Docs' : 'Get API Key'}
          </a>
        )}
      </div>

      {/* API Key - hidden for SearXNG */}
      {!isSearXNG && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-[#29261b]">{t.settings.webSearchApiKey}</label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={webSearchApiKey}
              onChange={(e) => setWebSearchApiKey(e.target.value)}
              placeholder={t.settings.webSearchApiKeyPlaceholder}
              className="w-full px-3 py-2 pr-10 text-sm border border-[#e8e4dd] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] text-[#29261b]"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[#888579] hover:text-[#29261b] rounded"
            >
              {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-[#888579]">{t.settings.webSearchApiKeyDesc}</p>
        </div>
      )}

      {/* Base URL - only for SearXNG */}
      {isSearXNG && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-[#29261b]">{t.settings.webSearchBaseUrl}</label>
          <input
            type="text"
            value={webSearchBaseUrl}
            onChange={(e) => setWebSearchBaseUrl(e.target.value)}
            placeholder={t.settings.webSearchBaseUrlPlaceholder}
            className="w-full px-3 py-2 text-sm border border-[#e8e4dd] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] text-[#29261b]"
          />
          <p className="text-xs text-[#888579]">{t.settings.webSearchBaseUrlDesc}</p>
        </div>
      )}
    </div>
  );
}

export default function WebSearchSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold text-[#29261b]">{t.settings.webSearch}</h3>
        <p className="text-sm text-[#888579] mt-1">{t.settings.webSearchDescription}</p>
      </div>
      <WebSearchForm />
    </div>
  );
}
