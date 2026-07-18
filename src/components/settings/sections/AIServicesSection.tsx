import { useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useI18n } from '@/i18n';
import { Plus, CircleCheck, CircleAlert, ChevronDown, Globe, ImageIcon, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import ProviderCard from './ai-services/ProviderCard';
import AddProviderModal from './ai-services/AddProviderModal';
import { WebSearchForm } from './WebSearchSection';
import { ImageGenBackendsPanel, ImageGenBackendModal } from './ImageGenSection';
import EnterpriseLlmBadge from '@/components/enterprise/EnterpriseLlmBadge';
import type { ProviderInstance, ImageGenBackend } from '@/types/provider';

export default function AIServicesSection() {
  const { t } = useI18n();
  const isEnterprise = useEnterpriseStore(s => s.mode.kind !== 'personal');
  const providers = useSettingsStore((s) => s.providers);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const clearAllStoredKeys = useSettingsStore((s) => s.clearAllStoredKeys);
  // Hooks must run unconditionally before the isEnterprise early return below.
  const imageGenBackends = useSettingsStore((s) => s.imageGeneration.backends);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderInstance | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [imageGenExpanded, setImageGenExpanded] = useState(false);
  const [showAddImageGenModal, setShowAddImageGenModal] = useState(false);
  const [editingImageGenBackend, setEditingImageGenBackend] = useState<ImageGenBackend | null>(null);

  // In enterprise mode, show the gateway badge and hide personal provider config.
  if (isEnterprise) {
    return (
      <div className="space-y-4">
        <h3 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
          {t.settings.aiServices}
        </h3>
        <EnterpriseLlmBadge />
      </div>
    );
  }

  // Check if any enabled provider has builtin capabilities
  const enabledProviders = providers.filter(p => p.enabled);
  const hasBuiltinSearch = enabledProviders.some(p => !!p.capabilities?.webSearch);
  const searchProviderName = enabledProviders.find(p => !!p.capabilities?.webSearch)?.name;
  // Image generation is an independent config (design doc §3.1, "C-a") — no
  // longer derived from chat providers, so no "builtin via provider X" case.

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
      return b.sortOrder - a.sortOrder;
    });

  return (
    <div className="space-y-6">
      {/* Header — shared component; add button in the action slot (clears the modal X). */}
      <SettingsSectionHeader
        title={t.settings.aiServices}
        description={enabledCount > 0 ? t.settings.enabledCount.replace('{count}', String(enabledCount)) : undefined}
        action={(
          <Button
            variant="default"
            size="sm"
            onClick={() => setShowAddModal(true)}
            className="gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            {t.settings.add}
          </Button>
        )}
      />

      {/* Provider List */}
      {visibleProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-body text-[var(--abu-text-muted)]">{t.settings.noProviders}</p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-1">{t.settings.noProvidersHint}</p>
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
              onEdit={(p) => setEditingProvider(p)}
            />
          ))}
        </div>
      )}

      {/* Auxiliary Capabilities */}
      <div className="border border-[var(--abu-border)] rounded-xl">
        <div className="px-4 py-3 bg-[var(--abu-bg-muted)] rounded-t-xl">
          <h4 className="text-minor font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">
            {t.settings.auxiliary}
          </h4>
        </div>

        <div className="divide-y divide-[var(--abu-border)]">
          {/* Web Search */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {hasBuiltinSearch ? (
                  <CircleCheck className="h-4 w-4 text-[var(--abu-success)] shrink-0" />
                ) : (
                  <CircleAlert className="h-4 w-4 text-[var(--abu-warning)] shrink-0" />
                )}
                <div className="flex items-center gap-2">
                  <Globe className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                  <span className="text-body text-[var(--abu-text-primary)]">{t.settings.auxiliarySearch}</span>
                </div>
                {hasBuiltinSearch ? (
                  <span className="text-minor px-1.5 py-0.5 rounded bg-[var(--abu-success-bg)] text-[var(--abu-success)]">
                    {t.settings.builtinVia.replace('{name}', searchProviderName ?? '')}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSearchExpanded(!searchExpanded)}
                    className={cn(
                      'text-minor px-1.5 py-0.5 rounded cursor-pointer transition-colors',
                      'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)] hover:bg-[var(--abu-warning-bg)]'
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

          {/* Image Generation — independent config (design doc §3.1, "C-a"):
              a user-managed list of backends, decoupled from chat providers.
              The "add backend" trigger lives here (header row, right-aligned)
              rather than inside the collapsible panel, mirroring the AI
              Services section header's own add button above — see P2 design
              note: it must stay visible even while the panel is collapsed. */}
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                {imageGenBackends.length > 0 ? (
                  <CircleCheck className="h-4 w-4 text-[var(--abu-success)] shrink-0" />
                ) : (
                  <CircleAlert className="h-4 w-4 text-[var(--abu-warning)] shrink-0" />
                )}
                <div className="flex items-center gap-2">
                  <ImageIcon className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                  <span className="text-body text-[var(--abu-text-primary)]">{t.settings.auxiliaryImageGen}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setImageGenExpanded(!imageGenExpanded)}
                  className={cn(
                    'text-minor px-1.5 py-0.5 rounded cursor-pointer transition-colors',
                    imageGenBackends.length > 0
                      ? 'bg-[var(--abu-success-bg)] text-[var(--abu-success)] hover:bg-[var(--abu-success-bg)]'
                      : 'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)] hover:bg-[var(--abu-warning-bg)]'
                  )}
                >
                  <span className="flex items-center gap-1">
                    {imageGenBackends.length > 0
                      ? t.settings.imageGenBackendsCount.replace('{count}', String(imageGenBackends.length))
                      : t.settings.imageGenNotConfigured}
                    <ChevronDown className={cn('h-3 w-3 transition-transform', imageGenExpanded && 'rotate-180')} />
                  </span>
                </button>
              </div>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setShowAddImageGenModal(true)}
                className="gap-1 shrink-0 text-[var(--abu-text-secondary)]"
              >
                <Plus className="h-3 w-3" />
                {t.settings.add}
              </Button>
            </div>

            {imageGenExpanded && (
              <div className="ml-7 mt-2 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)]">
                <div className="p-3">
                  <ImageGenBackendsPanel onEdit={setEditingImageGenBackend} />
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
            className="gap-1.5 text-[var(--abu-danger)] hover:text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.settings.clearAllKeys}
          </Button>
        </div>
      )}

      {/* Add / Edit Provider Modal — unified: opens for either "add" (no
          editProvider) or "edit" (editingProvider set from a card's pencil
          button). Closing clears both so the next open always starts fresh. */}
      <AddProviderModal
        open={showAddModal || !!editingProvider}
        editProvider={editingProvider ?? undefined}
        onClose={() => { setShowAddModal(false); setEditingProvider(null); }}
      />

      {/* Add / Edit Image-Gen Backend Modal — same "add"/"edit" unification
          as AddProviderModal above. */}
      <ImageGenBackendModal
        open={showAddImageGenModal || !!editingImageGenBackend}
        editBackend={editingImageGenBackend ?? undefined}
        onClose={() => { setShowAddImageGenModal(false); setEditingImageGenBackend(null); }}
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
