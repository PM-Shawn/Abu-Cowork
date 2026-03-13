import { useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { providerSupportsWebSearch, providerSupportsImageGen } from '@/core/capabilities';
import { CircleCheck, CircleAlert, ChevronDown, Globe, ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Toggle } from '@/components/ui/toggle';
import ModelConfigSection from './ModelConfigSection';
import { WebSearchForm } from './WebSearchSection';
import { ImageGenForm } from './ImageGenSection';

export default function AIServicesSection() {
  const {
    provider,
    useBuiltinWebSearch,
    setUseBuiltinWebSearch,
  } = useSettingsStore();
  const { t } = useI18n();

  const hasBuiltinSearch = providerSupportsWebSearch(provider);
  const hasBuiltinImageGen = providerSupportsImageGen(provider);

  // Show custom search config when: provider doesn't support builtin OR user turned off builtin
  const showCustomSearch = !hasBuiltinSearch || !useBuiltinWebSearch;
  // Show custom image gen config when: provider doesn't support builtin
  const showCustomImageGen = !hasBuiltinImageGen;

  const [searchExpanded, setSearchExpanded] = useState(false);
  const [imageGenExpanded, setImageGenExpanded] = useState(false);

  return (
    <div className="space-y-6">
      {/* Model Configuration */}
      <ModelConfigSection />

      {/* Capabilities Section */}
      <div className="border border-[#e8e4dd] rounded-xl">
        <div className="px-4 py-3 bg-[#f5f3ee] rounded-t-xl">
          <h4 className="text-xs font-medium text-[#656358] uppercase tracking-wider">
            {t.settings.capabilities}
          </h4>
        </div>

        <div className="divide-y divide-[#e8e4dd]">
          {/* Chat - always supported */}
          <div className="px-4 py-3 flex items-center gap-3">
            <CircleCheck className="h-4 w-4 text-green-600 shrink-0" />
            <span className="text-sm text-[#29261b]">{t.settings.capabilityChat}</span>
          </div>

          {/* Web Search */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {hasBuiltinSearch ? (
                  <CircleCheck className="h-4 w-4 text-green-600 shrink-0" />
                ) : (
                  <CircleAlert className="h-4 w-4 text-amber-500 shrink-0" />
                )}
                <div className="flex items-center gap-2">
                  <Globe className="h-3.5 w-3.5 text-[#888579]" />
                  <span className="text-sm text-[#29261b]">{t.settings.capabilityWebSearch}</span>
                </div>
                {showCustomSearch ? (
                  <button
                    type="button"
                    onClick={() => setSearchExpanded(!searchExpanded)}
                    className={cn(
                      'text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors',
                      'bg-amber-50 text-amber-700 hover:bg-amber-100'
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {t.settings.builtinNotSupported}
                      <ChevronDown className={cn('h-3 w-3 transition-transform', searchExpanded && 'rotate-180')} />
                    </span>
                  </button>
                ) : (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                    {t.settings.builtinSupported}
                  </span>
                )}
              </div>

              {/* Builtin search toggle (only when provider supports it) */}
              {hasBuiltinSearch && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[#888579]">{t.settings.useBuiltinSearch}</span>
                  <Toggle
                    checked={useBuiltinWebSearch}
                    onChange={() => setUseBuiltinWebSearch(!useBuiltinWebSearch)}
                    size="md"
                  />
                </div>
              )}
            </div>

            {/* Custom search config (nested card) */}
            {showCustomSearch && searchExpanded && (
              <div className="ml-7 mt-2 rounded-lg border border-[#e8e4dd] bg-[#faf9f7]">
                <div className="p-3">
                  <WebSearchForm />
                </div>
              </div>
            )}
          </div>

          {/* Image Generation */}
          <div className="px-4 py-3">
            <div className="flex items-center gap-3">
              {hasBuiltinImageGen ? (
                <CircleCheck className="h-4 w-4 text-green-600 shrink-0" />
              ) : (
                <CircleAlert className="h-4 w-4 text-amber-500 shrink-0" />
              )}
              <div className="flex items-center gap-2">
                <ImageIcon className="h-3.5 w-3.5 text-[#888579]" />
                <span className="text-sm text-[#29261b]">{t.settings.capabilityImageGen}</span>
              </div>
              {showCustomImageGen ? (
                <button
                  type="button"
                  onClick={() => setImageGenExpanded(!imageGenExpanded)}
                  className={cn(
                    'text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors',
                    'bg-amber-50 text-amber-700 hover:bg-amber-100'
                  )}
                >
                  <span className="flex items-center gap-1">
                    {t.settings.builtinNotSupported}
                    <ChevronDown className={cn('h-3 w-3 transition-transform', imageGenExpanded && 'rotate-180')} />
                  </span>
                </button>
              ) : (
                <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                  {t.settings.builtinSupported}
                </span>
              )}
            </div>

            {/* Custom image gen config (nested card) */}
            {showCustomImageGen && imageGenExpanded && (
              <div className="ml-7 mt-2 rounded-lg border border-[#e8e4dd] bg-[#faf9f7]">
                <div className="p-3">
                  <ImageGenForm />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
