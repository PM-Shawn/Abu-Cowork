import { useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useI18n } from '@/i18n';
import { Plus, CircleCheck, CircleAlert, ChevronDown, Globe, ImageIcon, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import ProviderCard from './ai-services/ProviderCard';
import AddProviderModal from './ai-services/AddProviderModal';
import { WebSearchForm } from './WebSearchSection';
import { ImageGenForm } from './ImageGenSection';
import EnterpriseLlmBadge from '@/components/enterprise/EnterpriseLlmBadge';

export default function AIServicesSection() {
  const { t } = useI18n();
  const isEnterprise = useEnterpriseStore(s => s.mode.kind !== 'personal');

  // In enterprise mode, show the gateway badge and hide personal provider config.
  if (isEnterprise) {
    return (
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-[var(--abu-text-primary)]">
          {t.settings.aiServices}
        </h3>
        <EnterpriseLlmBadge />
      </div>
    );
  }
  const providers = useSettingsStore((s) => s.providers);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const clearAllStoredKeys = useSettingsStore((s) => s.clearAllStoredKeys);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  // Check if any enabled provider has builtin capabilities
  const enabledProviders = providers.filter(p => p.enabled);
  const hasBuiltinSearch = enabledProviders.some(p => !!p.capabilities?.webSearch);
  const hasBuiltinImageGen = enabledProviders.some(p => !!p.capabilities?.imageGen);
  const searchProviderName = enabledProviders.find(p => !!p.capabilities?.webSearch)?.name;
  const imageGenProviderName = enabledProviders.find(p => !!p.capabilities?.imageGen)?.name;

  const enabledCount = enabledProviders.length;

  // Only show providers the user has actually configured.
  // `userAdded` is the authoritative flag (set by AddProviderModal); the
  // `enabled || apiKey` fallback covers legacy data not yet migrated.
  // Toggling off or clearing the key MUST NOT remove the card — the user
  // reads disappearance as accidental deletion. Only the trash-can action
  // (handleDeleteConfirm) hides a builtin provider, by clearing userAdded.
  const visibleProviders = providers
    .filter(p => p.userAdded || p.enabled || p.apiKey.trim().length > 0)
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.sortOrder - b.sortOrder;
    });

  const [searchExpanded, setSearchExpanded] = useState(false);
  const [imageGenExpanded, setImageGenExpanded] = useState(false);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-[var(--abu-text-primary)]">
            {t.settings.aiServices}
          </h3>
          {enabledCount > 0 && (
            <p className="text-xs text-[var(--abu-text-muted)] mt-0.5">
              {t.settings.enabledCount.replace('{count}', String(enabledCount))}
            </p>
          )}
        </div>
        <Button
          variant="default"
          size="sm"
          onClick={() => setShowAddModal(true)}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          {t.settings.addService}
        </Button>
      </div>

      {/* Provider List */}
      {visibleProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-[var(--abu-text-muted)]">{t.settings.noProviders}</p>
          <p className="text-xs text-[var(--abu-text-muted)] mt-1">{t.settings.noProvidersHint}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAddModal(true)}
            className="mt-4 gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            {t.settings.addService}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleProviders.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isActive={activeModel.providerId === provider.id}
            />
          ))}
        </div>
      )}

      {/* Auxiliary Capabilities */}
      <div className="border border-[var(--abu-border)] rounded-xl">
        <div className="px-4 py-3 bg-[var(--abu-bg-muted)] rounded-t-xl">
          <h4 className="text-xs font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">
            {t.settings.auxiliary}
          </h4>
        </div>

        <div className="divide-y divide-[var(--abu-border)]">
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
                  <Globe className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                  <span className="text-sm text-[var(--abu-text-primary)]">{t.settings.auxiliarySearch}</span>
                </div>
                {hasBuiltinSearch ? (
                  <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                    {t.settings.builtinVia.replace('{name}', searchProviderName ?? '')}
                  </span>
                ) : (
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
                )}
              </div>
            </div>

            {!hasBuiltinSearch && searchExpanded && (
              <div className="ml-7 mt-2 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
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
                <ImageIcon className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                <span className="text-sm text-[var(--abu-text-primary)]">{t.settings.auxiliaryImageGen}</span>
              </div>
              {hasBuiltinImageGen ? (
                <span className="text-xs px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                  {t.settings.builtinVia.replace('{name}', imageGenProviderName ?? '')}
                </span>
              ) : (
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
              )}
            </div>

            {!hasBuiltinImageGen && imageGenExpanded && (
              <div className="ml-7 mt-2 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
                <div className="p-3">
                  <ImageGenForm />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Danger zone: hard-reset escape hatch for stuck / migrated / compromised keys */}
      {providers.some((p) => p.apiKey.trim().length > 0) && (
        <div className="pt-2 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowClearConfirm(true)}
            className="gap-1.5 text-red-600 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.settings.clearAllKeys}
          </Button>
        </div>
      )}

      {/* Add Provider Modal */}
      <AddProviderModal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
      />

      <ConfirmDialog
        open={showClearConfirm}
        title={t.settings.clearAllKeys}
        message={t.settings.clearAllKeysConfirm}
        confirmText={t.common.confirm}
        cancelText={t.common.cancel}
        variant="danger"
        onConfirm={async () => {
          setShowClearConfirm(false);
          await clearAllStoredKeys();
        }}
        onCancel={() => setShowClearConfirm(false)}
      />
    </div>
  );
}
