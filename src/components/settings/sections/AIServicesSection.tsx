import { useState, type ReactNode } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons, type AppIconName } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { SettingGroup } from '@/components/ds/setting-row';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';
import ProviderCard from './ai-services/ProviderCard';
import AddProviderModal from './ai-services/AddProviderModal';
import { WebSearchForm } from './WebSearchSection';
import { ImageGenBackendsPanel, ImageGenBackendModal } from './ImageGenSection';
import type { ProviderInstance, ImageGenBackend } from '@/types/provider';

// One auxiliary ability: whether it is ready, its name, its state on the right, and the
// panel that the state button opens under the row.
function AuxiliaryRow({ ready, icon, name, status, action, children }: {
  ready: boolean;
  icon: AppIconName;
  name: string;
  status: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusIcon tone={ready ? 'success' : 'warning'} />
          <Icon icon={AppIcons[icon]} size="sm" className="text-label-secondary" />
          <span className="truncate text-ui text-label">{name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status}
          {action}
        </div>
      </div>
      {children && <div className="mb-3 rounded-control bg-code p-3">{children}</div>}
    </div>
  );
}

// The state of an ability that the user sets up here: it opens and closes the panel under its row.
function StatusToggle({ ready, expanded, onToggle, children }: {
  ready: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <Pressable aria-expanded={expanded} onClick={onToggle} className="inline-flex rounded-control">
      <Tag tone={ready ? 'success' : 'warning'}>
        {children}
        <Icon icon={AppIcons.expand} size="sm" className={cn('transition-transform duration-fast', expanded && 'rotate-180')} />
      </Tag>
    </Pressable>
  );
}

export default function AIServicesSection() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const providers = useSettingsStore((s) => s.providers);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const customWebSearch = useSettingsStore((s) => s.auxiliaryServices.webSearch);
  const clearAllStoredKeys = useSettingsStore((s) => s.clearAllStoredKeys);
  const imageGenBackends = useSettingsStore((s) => s.imageGeneration.backends);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderInstance | null>(null);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [imageGenExpanded, setImageGenExpanded] = useState(false);
  const [showAddImageGenModal, setShowAddImageGenModal] = useState(false);
  const [editingImageGenBackend, setEditingImageGenBackend] = useState<ImageGenBackend | null>(null);

  // Check if any enabled provider has builtin capabilities
  const enabledProviders = providers.filter(p => p.enabled);
  const hasBuiltinSearch = enabledProviders.some(p => !!p.capabilities?.webSearch);
  const searchProviderName = enabledProviders.find(p => !!p.capabilities?.webSearch)?.name;
  const hasCustomSearch = customWebSearch?.provider === 'searxng'
    ? (customWebSearch.baseUrl?.trim().length ?? 0) > 0
    : (customWebSearch?.apiKey?.trim().length ?? 0) > 0;
  const hasSearch = hasBuiltinSearch || hasCustomSearch;
  // Image generation is an independent config (design doc §3.1, "C-a") — no
  // longer derived from chat providers, so no "builtin via provider X" case.

  const enabledCount = enabledProviders.length;

  // Only show providers the user has actually configured.
  // `userAdded` is the authoritative flag (set by AddProviderModal); the
  // `enabled || apiKey` fallback covers legacy data not yet migrated.
  // Toggling off or clearing the key MUST NOT remove the card — the user
  // reads disappearance as accidental deletion. Only the trash-can action
  // (handleDelete in ProviderCard) hides a builtin provider, by clearing userAdded.
  const visibleProviders = providers
    .filter(p => p.userAdded || p.enabled || p.apiKey.trim().length > 0)
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return b.sortOrder - a.sortOrder;
    });

  const clearKeys = async () => {
    const confirmed = await confirm({
      title: t.settings.clearAllKeys,
      message: t.settings.clearAllKeysConfirm,
      confirmLabel: t.common.confirm,
      tone: 'danger',
    });
    if (confirmed) await clearAllStoredKeys();
  };

  return (
    <div className="space-y-6">
      {/* Header — shared component; add button in the action slot (clears the modal X). */}
      <SettingsSectionHeader
        title={t.settings.aiServices}
        description={enabledCount > 0 ? t.settings.enabledCount.replace('{count}', String(enabledCount)) : undefined}
        action={(
          <Button variant="primary" size="sm" icon={AppIcons.add} onClick={() => setShowAddModal(true)}>
            {t.settings.add}
          </Button>
        )}
      />

      {/* Provider List */}
      {visibleProviders.length === 0 ? (
        <EmptyState
          title={t.settings.noProviders}
          description={t.settings.noProvidersHint}
          action={(
            <Button variant="secondary" size="sm" icon={AppIcons.add} onClick={() => setShowAddModal(true)}>
              {t.settings.addService}
            </Button>
          )}
        />
      ) : (
        <div className="space-y-3">
          {visibleProviders.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              isActive={activeModel.providerId === provider.id}
              onEdit={setEditingProvider}
            />
          ))}
        </div>
      )}

      {/* Auxiliary Capabilities */}
      <SettingGroup title={t.settings.auxiliary}>
        {/* Web Search */}
        <AuxiliaryRow
          ready={hasSearch}
          icon="webPage"
          name={t.settings.auxiliarySearch}
          status={hasBuiltinSearch ? (
            <Tag tone="success">{t.settings.builtinVia.replace('{name}', searchProviderName ?? '')}</Tag>
          ) : (
            <StatusToggle ready={hasCustomSearch} expanded={searchExpanded} onToggle={() => setSearchExpanded(!searchExpanded)}>
              {hasCustomSearch ? t.settings.configured : t.settings.builtinNotSupported}
            </StatusToggle>
          )}
        >
          {!hasBuiltinSearch && searchExpanded && <WebSearchForm />}
        </AuxiliaryRow>

        {/* Image Generation — independent config (design doc §3.1, "C-a"):
            a user-managed list of backends, decoupled from chat providers.
            The "add backend" trigger lives here (row end) rather than inside
            the collapsible panel, mirroring the AI Services section header's
            own add button above — see P2 design note: it must stay visible
            even while the panel is collapsed. */}
        <AuxiliaryRow
          ready={imageGenBackends.length > 0}
          icon="imageGen"
          name={t.settings.auxiliaryImageGen}
          status={(
            <StatusToggle ready={imageGenBackends.length > 0} expanded={imageGenExpanded} onToggle={() => setImageGenExpanded(!imageGenExpanded)}>
              {imageGenBackends.length > 0
                ? t.settings.imageGenBackendsCount.replace('{count}', String(imageGenBackends.length))
                : t.settings.imageGenNotConfigured}
            </StatusToggle>
          )}
          action={(
            <Button variant="plain" size="sm" icon={AppIcons.add} onClick={() => setShowAddImageGenModal(true)}>
              {t.settings.add}
            </Button>
          )}
        >
          {imageGenExpanded && <ImageGenBackendsPanel onEdit={setEditingImageGenBackend} />}
        </AuxiliaryRow>
      </SettingGroup>

      {/* Danger zone: hard-reset escape hatch for stuck / migrated / compromised keys */}
      {providers.some((p) => p.apiKey.trim().length > 0) && (
        <div className="flex justify-end">
          <Button variant="danger" size="sm" icon={AppIcons.delete} onClick={() => { void clearKeys(); }}>
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
    </div>
  );
}
