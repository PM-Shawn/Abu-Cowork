import { memo, useCallback, useState } from 'react';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkProviderHealth } from '@/core/llm/healthCheck';
import { refreshManagedProvider } from '@/core/llm/managedProviderRefresh';
import type { ProviderInstance } from '@/types/provider';
import { SECRET_KEYS } from '@/utils/secretStore';

interface ProviderCardProps {
  provider: ProviderInstance;
  isActive: boolean;
  /** Bubbles up to AIServicesSection, which opens AddProviderModal in edit
   *  mode for this provider. The card itself no longer owns an inline edit
   *  form — editing is unified into the same modal used for "add" (see
   *  docs/2026-07-11-modal-unify-design.md). */
  onEdit: (provider: ProviderInstance) => void;
}

const CARD = 'group rounded-panel border border-separator px-4 py-3';

function StatusBadge({ provider, t }: { provider: ProviderInstance; t: ReturnType<typeof useI18n>['t'] }) {
  switch (provider.status) {
    case 'verified':
      return <Tag tone="success">{provider.statusLatency ? `${provider.statusLatency}ms` : t.settings.statusConnected}</Tag>;
    case 'failed':
      return (
        <span className="inline-flex" title={provider.statusMessage}>
          <Tag tone="danger">{t.settings.statusFailed}</Tag>
        </span>
      );
    case 'checking':
      return <Spinner size="sm" label={t.settings.validating} />;
    default:
      return <Tag tone="warning">{t.settings.statusUnchecked}</Tag>;
  }
}

function UserProviderCard({ provider, isActive, onEdit }: ProviderCardProps) {
  const { t } = useI18n();
  const confirm = useConfirm();
  // One selector per action: the card re-renders when its own provider changes, never because
  // another setting did (each of its buttons mounts a tooltip).
  const removeProvider = useSettingsStore((s) => s.removeProvider);
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const toggleProvider = useSettingsStore((s) => s.toggleProvider);
  const setProviderStatus = useSettingsStore((s) => s.setProviderStatus);
  // True when bootstrapSecrets detected a prior ciphertext for this
  // provider but couldn't decrypt it (typical cause: hardware/UUID change).
  const keyDecryptFailed = useSettingsStore((s) =>
    s.failedSecretKeys.includes(SECRET_KEYS.provider(provider.id)),
  );
  // True when the most recent secret write for this provider failed (broken
  // OS keychain). The key still works via the plaintext fallback, but the
  // user should know it isn't stored securely.
  const keySaveFailed = useSettingsStore((s) =>
    s.secretWriteFailedKeys.includes(SECRET_KEYS.provider(provider.id)),
  );

  const [showStatus, setShowStatus] = useState(false);

  const selectModel = useSettingsStore((s) => s.selectModel);

  const handleDelete = useCallback(async () => {
    const confirmed = await confirm({
      title: t.settings.deleteProviderConfirm,
      message: provider.name,
      confirmLabel: t.common.confirm,
      tone: 'danger',
    });
    if (!confirmed) return;
    // The answer is about the provider as it is now: it may have gone, or become the one in
    // use, while the question was open.
    const answered = useSettingsStore.getState();
    const current = answered.providers.find((p) => p.id === provider.id);
    if (!current) return;
    const wasActive = answered.activeModel.providerId === current.id;

    if (current.source === 'custom') {
      removeProvider(current.id);
    } else {
      // Builtin providers can't be removed from the array (they're seeded
      // by createDefaultProviders); we hide them by clearing userAdded so
      // visibleProviders' filter drops them. Keep also clearing
      // enabled/apiKey for backward compat with the legacy fallback.
      updateProvider(current.id, { enabled: false, apiKey: '', status: 'unchecked', userAdded: false });
    }

    // If we deleted the active provider, switch to next enabled one
    if (wasActive) {
      const state = useSettingsStore.getState();
      const next = state.providers.find(p => p.enabled && p.id !== current.id);
      if (next && next.models.length > 0) {
        selectModel(next.id, next.models[0].id);
      }
    }
  }, [provider, confirm, t, removeProvider, updateProvider, selectModel]);

  const handleRevalidate = useCallback(async () => {
    setShowStatus(true);
    setProviderStatus(provider.id, 'checking');
    const result = await checkProviderHealth(provider);
    if (result.success) {
      setProviderStatus(provider.id, 'verified', undefined, result.latencyMs);
    } else {
      setProviderStatus(provider.id, 'failed', result.error);
    }
    // Hide status after 5 seconds
    setTimeout(() => setShowStatus(false), 5000);
  }, [provider, setProviderStatus]);

  // Build compact model summary: "Model1, Model2 +3"
  const modelsSummary = (() => {
    const models = provider.models;
    if (models.length === 0) return '';
    const show = models.slice(0, 2).map(m => m.label || m.id);
    const rest = models.length - 2;
    return rest > 0 ? `${show.join(', ')} +${rest}` : show.join(', ');
  })();

  // Capability tags
  const caps: string[] = [];
  if (provider.capabilities?.webSearch) caps.push(t.settings.capabilityWebSearch);
  if (provider.capabilities?.imageGen) caps.push(t.settings.capabilityImageGen);

  return (
    <div
      className={cn(
        CARD,
        isActive && 'bg-fill-selected',
        !provider.enabled && !keyDecryptFailed && 'opacity-50',
      )}
    >
      {keyDecryptFailed && (
        <div className="mb-2">
          <InlineMessage tone="danger">{t.settings.apiKeyDecryptFailed}</InlineMessage>
        </div>
      )}
      {!keyDecryptFailed && keySaveFailed && (
        <div className="mb-2">
          <InlineMessage tone="warning">{t.settings.apiKeySaveFailed}</InlineMessage>
        </div>
      )}
      {/* Row 1: Name + status + toggle */}
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-ui font-medium text-label">
          {provider.name}
        </span>
        {(showStatus || provider.status === 'checking') && <StatusBadge provider={provider} t={t} />}
        <Switch checked={provider.enabled} onCheckedChange={() => toggleProvider(provider.id)} aria-label={provider.name} />
      </div>

      {/* Row 2: Models + caps + actions */}
      <div className="mt-1 flex items-center gap-2">
        {/* Info */}
        <div className="flex min-w-0 flex-1 items-center gap-2 truncate text-caption text-label-tertiary">
          {modelsSummary && <span className="truncate">{modelsSummary}</span>}
          {caps.length > 0 && (
            <>
              <span>·</span>
              <span className="shrink-0">{caps.join(', ')}</span>
            </>
          )}
        </div>

        {/* Actions: under the pointer, and when the keyboard reaches the card */}
        <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
          <IconButton size="sm" icon={AppIcons.rename} label={t.settings.editProvider} onClick={() => onEdit(provider)} />
          {/* The card's one spinner is the status next to the name; this icon stays still. */}
          <IconButton
            size="sm"
            icon={AppIcons.retry}
            label={t.settings.revalidate}
            disabled={provider.status === 'checking'}
            onClick={handleRevalidate}
          />
          <IconButton size="sm" icon={AppIcons.delete} label={t.settings.deleteProvider} onClick={() => { void handleDelete(); }} />
        </div>
      </div>
    </div>
  );
}

function managedStatusText(provider: ProviderInstance, t: ReturnType<typeof useI18n>['t']): string {
  if (provider.status === 'failed') return t.settings.managedStatusOffline;
  if (provider.status !== 'verified') return t.settings.managedStatusSyncing;
  return provider.models.length === 0
    ? t.settings.managedStatusEmpty
    : format(t.settings.managedStatusConnected, { count: provider.models.length });
}

function ManagedStatus({ provider, t }: { provider: ProviderInstance; t: ReturnType<typeof useI18n>['t'] }) {
  const text = managedStatusText(provider, t);
  // Only a sync that is running spins; before the first one the words stand still.
  if (provider.status === 'checking') return <Spinner size="sm" label={text} />;
  if (provider.status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 text-caption text-warning">
        <StatusIcon tone="warning" size="sm" />
        {text}
      </span>
    );
  }
  return <span className="text-caption text-label-tertiary">{text}</span>;
}

/**
 * Read-only card for a provider an external system registered. The user can
 * neither edit, switch off nor delete it; the only action asks the owning
 * system for a fresh model list. Endpoint and credential are never rendered.
 */
function ManagedProviderCard({ provider, isActive }: Pick<ProviderCardProps, 'provider' | 'isActive'>) {
  const { t } = useI18n();
  const syncing = provider.status === 'checking';
  const modelNames = provider.models.map(m => m.label || m.id);
  const modelsSummary = modelNames.length > 2
    ? `${modelNames.slice(0, 2).join(', ')} +${modelNames.length - 2}`
    : modelNames.join(', ');

  return (
    <div className={cn(CARD, isActive && 'bg-fill-selected')}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-ui font-medium text-label">
          {provider.name}
        </span>
        <span className="inline-flex shrink-0">
          <Tag>{format(t.settings.managedProviderBadge, { org: provider.name })}</Tag>
        </span>
        <span className="ml-auto inline-flex shrink-0">
          <ManagedStatus provider={provider} t={t} />
        </span>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-caption text-label-tertiary" title={modelNames.join('\n')}>
          {modelsSummary}
        </div>
        {/* The card's one spinner is the status above; this icon stays still. */}
        <IconButton
          size="sm"
          icon={AppIcons.retry}
          label={t.settings.managedResync}
          disabled={syncing}
          onClick={() => { void refreshManagedProvider(provider.id); }}
        />
      </div>
    </div>
  );
}

const ProviderCard = memo(function ProviderCard(props: ProviderCardProps) {
  return props.provider.source === 'managed'
    ? <ManagedProviderCard provider={props.provider} isActive={props.isActive} />
    : <UserProviderCard {...props} />;
});

export default ProviderCard;
