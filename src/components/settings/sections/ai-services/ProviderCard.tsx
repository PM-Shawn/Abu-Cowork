import { useCallback, useState } from 'react';
import { Check, X, AlertTriangle, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Toggle } from '@/components/ui/toggle';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkProviderHealth } from '@/core/llm/healthCheck';
import ConfirmDialog from '@/components/common/ConfirmDialog';
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

function StatusBadge({ provider, t }: { provider: ProviderInstance; t: ReturnType<typeof useI18n>['t'] }) {
  switch (provider.status) {
    case 'verified':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-green-600">
          <Check className="h-3 w-3" />
          {provider.statusLatency ? `${provider.statusLatency}ms` : t.settings.statusConnected}
        </span>
      );
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-red-500 max-w-[200px] truncate" title={provider.statusMessage}>
          <X className="h-3 w-3 shrink-0" />
          {t.settings.statusFailed}
        </span>
      );
    case 'checking':
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-[var(--abu-text-muted)]">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t.settings.validating}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-500">
          <AlertTriangle className="h-3 w-3" />
          {t.settings.statusUnchecked}
        </span>
      );
  }
}

export default function ProviderCard({ provider, isActive, onEdit }: ProviderCardProps) {
  const { t } = useI18n();
  const { removeProvider, updateProvider, toggleProvider, setProviderStatus } = useSettingsStore();
  // True when bootstrapSecrets detected a prior ciphertext for this
  // provider but couldn't decrypt it (typical cause: hardware/UUID change).
  const keyDecryptFailed = useSettingsStore((s) =>
    s.failedSecretKeys.includes(SECRET_KEYS.provider(provider.id)),
  );

  const [showStatus, setShowStatus] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const selectModel = useSettingsStore((s) => s.selectModel);

  const handleDeleteConfirm = useCallback(() => {
    const wasActive = isActive;

    if (provider.source === 'custom') {
      removeProvider(provider.id);
    } else {
      // Builtin providers can't be removed from the array (they're seeded
      // by createDefaultProviders); we hide them by clearing userAdded so
      // visibleProviders' filter drops them. Keep also clearing
      // enabled/apiKey for backward compat with the legacy fallback.
      updateProvider(provider.id, { enabled: false, apiKey: '', status: 'unchecked', userAdded: false });
    }

    // If we deleted the active provider, switch to next enabled one
    if (wasActive) {
      const state = useSettingsStore.getState();
      const next = state.providers.find(p => p.enabled && p.id !== provider.id);
      if (next && next.models.length > 0) {
        selectModel(next.id, next.models[0].id);
      }
    }

    setShowDeleteConfirm(false);
  }, [provider, isActive, removeProvider, updateProvider, selectModel]);

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

  // ─── Compact collapsed view ───
  return (
    <div
      className={cn(
        'group rounded-xl border px-4 py-2.5 transition-colors',
        keyDecryptFailed
          ? 'border-red-300 bg-red-50/30'
          : 'border-[var(--abu-border)] hover:border-[var(--abu-clay-ring)]',
        isActive && 'ring-1 ring-[var(--abu-clay-ring)]',
        !provider.enabled && !keyDecryptFailed && 'opacity-50',
      )}
    >
      {keyDecryptFailed && (
        <div className="flex items-start gap-1.5 text-[11px] text-red-700 mb-1.5">
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
          <span>{t.settings.apiKeyDecryptFailed}</span>
        </div>
      )}
      {/* Row 1: Name + status + toggle */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-[var(--abu-text-primary)] truncate min-w-0 flex-1">
          {provider.name}
        </span>
        {(showStatus || provider.status === 'checking') && <StatusBadge provider={provider} t={t} />}
        <Toggle checked={provider.enabled} onChange={() => toggleProvider(provider.id)} size="sm" />
      </div>

      {/* Row 2: Models + caps + actions */}
      <div className="flex items-center gap-2 mt-1.5">
        {/* Info */}
        <div className="flex items-center gap-2 text-[11px] text-[var(--abu-text-muted)] truncate min-w-0 flex-1">
          {modelsSummary && <span className="truncate">{modelsSummary}</span>}
          {caps.length > 0 && (
            <>
              <span className="text-[var(--abu-border)]">·</span>
              <span className="shrink-0">{caps.join(', ')}</span>
            </>
          )}
        </div>

        {/* Actions (show on hover or always on mobile) */}
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onEdit(provider)}
            className="p-1 rounded text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
            title={t.settings.editProvider}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleRevalidate}
            disabled={provider.status === 'checking'}
            className="p-1 rounded text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors disabled:opacity-40"
            title={t.settings.revalidate}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', provider.status === 'checking' && 'animate-spin')} />
          </button>
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-1 rounded text-[var(--abu-text-muted)] hover:text-red-500 hover:bg-red-50 transition-colors"
            title={t.settings.deleteProvider}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={showDeleteConfirm}
        title={t.settings.deleteProvider}
        message={t.settings.deleteProviderConfirm}
        confirmText={t.common.confirm}
        cancelText={t.common.cancel}
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setShowDeleteConfirm(false)}
      />
    </div>
  );
}
