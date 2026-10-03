import { useId } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Select } from '@/components/ds/select';
import { TextField } from '@/components/ds/text-field';
import SecretField from '@/components/settings/SecretField';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import { open } from '@tauri-apps/plugin-shell';
import type { WebSearchProviderType } from '@/core/search/providers';

const SEARCH_PROVIDERS: { id: WebSearchProviderType; labelKey: 'webSearchProviderBing' | 'webSearchProviderBrave' | 'webSearchProviderTavily' | 'webSearchProviderSearXNG'; signupUrl?: string }[] = [
  { id: 'tavily', labelKey: 'webSearchProviderTavily', signupUrl: 'https://tavily.com/' },
  { id: 'brave', labelKey: 'webSearchProviderBrave', signupUrl: 'https://brave.com/search/api/' },
  { id: 'searxng', labelKey: 'webSearchProviderSearXNG', signupUrl: 'https://docs.searxng.org/' },
  { id: 'bing', labelKey: 'webSearchProviderBing', signupUrl: 'https://www.microsoft.com/en-us/bing/apis/bing-web-search-api' },
];

const FIELD_LABEL = 'block text-ui font-medium text-label';
const FIELD_HINT = 'text-ui-sm text-label-secondary';

/** Inline mode: renders only the form fields without section header */
export function WebSearchForm() {
  const auxiliaryServices = useSettingsStore((s) => s.auxiliaryServices);
  const setAuxiliaryWebSearch = useSettingsStore((s) => s.setAuxiliaryWebSearch);
  const { t } = useI18n();
  const keyId = useId();
  const addressId = useId();

  const webSearch = auxiliaryServices.webSearch ?? { provider: 'tavily' as WebSearchProviderType, apiKey: '', baseUrl: '' };
  const webSearchProvider = webSearch.provider;
  const webSearchApiKey = webSearch.apiKey;
  const webSearchBaseUrl = webSearch.baseUrl;

  const setWebSearchProvider = (provider: WebSearchProviderType) => {
    setAuxiliaryWebSearch({ ...webSearch, provider });
  };
  const setWebSearchApiKey = (apiKey: string) => {
    setAuxiliaryWebSearch({ ...webSearch, apiKey });
  };
  const setWebSearchBaseUrl = (baseUrl: string) => {
    setAuxiliaryWebSearch({ ...webSearch, baseUrl });
  };

  const isSearXNG = webSearchProvider === 'searxng';
  const currentProvider = SEARCH_PROVIDERS.find((p) => p.id === webSearchProvider);

  return (
    <div className="space-y-4">
      {/* Provider selection */}
      <div className="space-y-2">
        <label className={FIELD_LABEL}>{t.settings.webSearchProvider}</label>
        <Select
          fullWidth
          label={t.settings.webSearchProvider}
          value={webSearchProvider}
          onValueChange={(value) => setWebSearchProvider(value as WebSearchProviderType)}
          options={SEARCH_PROVIDERS.map((p) => ({ value: p.id, label: t.settings[p.labelKey] }))}
        />
        {currentProvider?.signupUrl && (
          <Pressable
            className="inline-flex items-center gap-1 rounded-control text-ui-sm text-link hover:underline"
            onClick={() => {
              open(currentProvider.signupUrl!);
            }}
          >
            <Icon icon={AppIcons.openExternal} size="sm" />
            {isSearXNG ? 'SearXNG Docs' : 'Get API Key'}
          </Pressable>
        )}
      </div>

      {/* API Key - hidden for SearXNG */}
      {!isSearXNG && (
        <div className="space-y-2">
          <label htmlFor={keyId} className={FIELD_LABEL}>{t.settings.webSearchApiKey}</label>
          <SecretField
            id={keyId}
            value={webSearchApiKey}
            onChange={setWebSearchApiKey}
            placeholder={t.settings.webSearchApiKeyPlaceholder}
          />
          <p className={FIELD_HINT}>{t.settings.webSearchApiKeyDesc}</p>
        </div>
      )}

      {/* Base URL - only for SearXNG */}
      {isSearXNG && (
        <div className="space-y-2">
          <label htmlFor={addressId} className={FIELD_LABEL}>{t.settings.webSearchBaseUrl}</label>
          <TextField
            id={addressId}
            type="text"
            value={webSearchBaseUrl}
            onChange={(e) => setWebSearchBaseUrl(e.target.value)}
            placeholder={t.settings.webSearchBaseUrlPlaceholder}
          />
          <p className={FIELD_HINT}>{t.settings.webSearchBaseUrlDesc}</p>
        </div>
      )}
    </div>
  );
}

export default function WebSearchSection() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t.settings.webSearch} description={t.settings.webSearchDescription} />
      <WebSearchForm />
    </div>
  );
}
