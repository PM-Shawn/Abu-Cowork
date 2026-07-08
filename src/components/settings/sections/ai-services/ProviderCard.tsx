import { useState, useCallback } from 'react';
import { Check, X, AlertTriangle, Loader2, Eye, EyeOff, Pencil, RefreshCw, Trash2, Plus, CircleCheck, CircleX } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkProviderHealth } from '@/core/llm/healthCheck';
import { buildFullChatUrl } from '@/core/llm/urlUtils';
import { fetchProviderModels } from '@/core/llm/modelFetcher';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import type { ProviderInstance, ModelInfo } from '@/types/provider';
import { SECRET_KEYS } from '@/utils/secretStore';

interface ProviderCardProps {
  provider: ProviderInstance;
  isActive: boolean;
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

const isOllamaProvider = (p: ProviderInstance): boolean =>
  p.id === 'ollama' || p.baseUrl.includes('localhost:11434');

const isLMStudioProvider = (p: ProviderInstance): boolean =>
  p.id === 'lmstudio' || p.baseUrl.includes('localhost:1234');

export default function ProviderCard({ provider, isActive }: ProviderCardProps) {
  const { t } = useI18n();
  const { updateProvider, removeProvider, toggleProvider, setProviderStatus } = useSettingsStore();
  // True when bootstrapSecrets detected a prior ciphertext for this
  // provider but couldn't decrypt it (typical cause: hardware/UUID change).
  const keyDecryptFailed = useSettingsStore((s) =>
    s.failedSecretKeys.includes(SECRET_KEYS.provider(provider.id)),
  );

  const [editing, setEditing] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);

  // Local form state
  const [formName, setFormName] = useState(provider.name);
  const [formApiKey, setFormApiKey] = useState(provider.apiKey);
  const [formBaseUrl, setFormBaseUrl] = useState(provider.baseUrl);
  const [formModels, setFormModels] = useState<ModelInfo[]>(provider.models);
  const [newModelId, setNewModelId] = useState('');
  const [showStatus, setShowStatus] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchModelsMsg, setFetchModelsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [modelsExpanded, setModelsExpanded] = useState(false);
  const isOllama = isOllamaProvider(provider);
  const isLMStudio = isLMStudioProvider(provider);
  const isBuiltin = provider.source === 'builtin';

  const MODELS_COLLAPSED_COUNT = 5;

  const handleEditStart = useCallback(() => {
    setFormName(provider.name);
    setFormApiKey(provider.apiKey);
    setFormBaseUrl(provider.baseUrl);
    setFormModels([...provider.models]);
    setNewModelId('');
    setShowApiKey(false);
    setModelsExpanded(false);
    setFetchModelsMsg(null);
    setEditing(true);
  }, [provider]);

  const handleSave = useCallback(() => {
    updateProvider(provider.id, {
      name: formName,
      apiKey: formApiKey,
      baseUrl: formBaseUrl,
      models: formModels,
    });
    setEditing(false);
  }, [provider.id, formName, formApiKey, formBaseUrl, formModels, updateProvider]);

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

  const handleAddModel = useCallback(() => {
    const trimmed = newModelId.trim();
    if (!trimmed || formModels.some((m) => m.id === trimmed)) return;
    setFormModels((prev) => [...prev, { id: trimmed, label: trimmed, isCustom: true }]);
    setNewModelId('');
  }, [newModelId, formModels]);

  const handleFetchModels = useCallback(async () => {
    if (!formBaseUrl.trim()) return;
    setFetchingModels(true);
    setFetchModelsMsg(null);
    const result = await fetchProviderModels(formBaseUrl, formApiKey, provider.apiFormat);
    setFetchingModels(false);
    if (result.success && result.models.length > 0) {
      setFormModels((prev) => {
        const customModels = prev.filter((m) => m.isCustom);
        const fetchedIds = new Set(result.models.map((m) => m.id));
        const preserved = customModels.filter((m) => !fetchedIds.has(m.id));
        return [...result.models, ...preserved];
      });
      setFetchModelsMsg({ ok: true, text: `获取到 ${result.models.length} 个模型` });
    } else {
      setFetchModelsMsg({ ok: false, text: result.error ?? '获取失败，请手动添加' });
    }
  }, [formBaseUrl, formApiKey, provider.apiFormat]);


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

  if (editing) {
    return (
      <div className={cn(
        'rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4 space-y-3',
        isActive && 'ring-2 ring-[var(--abu-clay-ring)]',
      )}>
        {keyDecryptFailed && (
          <div className="flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-[11px] text-red-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{t.settings.apiKeyDecryptFailed}</span>
          </div>
        )}
        {/* Edit: Name */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--abu-text-tertiary)]">{t.settings.serviceName}</label>
          <Input value={formName} onChange={(e) => setFormName(e.target.value)} />
        </div>

        {/* Edit: API Key */}
        {!isOllama && !isLMStudio && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--abu-text-tertiary)]">{t.settings.apiKey}</label>
            <div className="relative">
              <Input
                type={showApiKey ? 'text' : 'password'}
                value={formApiKey}
                onChange={(e) => setFormApiKey(e.target.value)}
                placeholder="sk-..."
                className="pr-9"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)]"
              >
                {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        )}

        {/* Edit: Base URL — read-only for builtin providers */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-[var(--abu-text-tertiary)]">{t.settings.apiUrl}</label>
          {isBuiltin ? (
            <p className="text-xs text-[var(--abu-text-secondary)] font-mono bg-[var(--abu-bg-hover)] rounded-lg px-3 py-2 break-all select-all">
              {formBaseUrl}
            </p>
          ) : (
            <Input value={formBaseUrl} onChange={(e) => setFormBaseUrl(e.target.value)} />
          )}
          {!isOllama && formBaseUrl.trim() && (
            <p className="text-[11px] font-mono text-[var(--abu-text-muted)] break-all">
              ↳ POST {buildFullChatUrl(formBaseUrl, provider.apiFormat, { useRawUrl: provider.declaredCapabilities?.useRawUrl })}
            </p>
          )}
        </div>

        {/* Edit: Models */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-[var(--abu-text-tertiary)]">{t.settings.models}</label>
            {!isOllama && provider.apiFormat !== 'anthropic' && formBaseUrl.trim() && (
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={fetchingModels}
                className="flex items-center gap-1 text-[11px] text-[var(--abu-clay)] hover:underline disabled:opacity-40 disabled:no-underline"
              >
                {fetchingModels
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <RefreshCw className="h-3 w-3" />}
                {fetchingModels ? t.settings.fetchingModels : t.settings.fetchModels}
              </button>
            )}
          </div>
          {/* Fetch status */}
          {fetchModelsMsg && (
            <p className={`flex items-center gap-1 text-[11px] ${fetchModelsMsg.ok ? 'text-green-600' : 'text-red-500'}`}>
              {fetchModelsMsg.ok
                ? <CircleCheck className="h-3 w-3 shrink-0" />
                : <CircleX className="h-3 w-3 shrink-0" />}
              {fetchModelsMsg.text}
            </p>
          )}
          {/* Model chips — collapsed by default, expand to see all */}
          {formModels.length > 0 && (() => {
            const visible = modelsExpanded ? formModels : formModels.slice(0, MODELS_COLLAPSED_COUNT);
            const hidden = formModels.length - MODELS_COLLAPSED_COUNT;
            return (
              <div className="flex flex-wrap items-center gap-1.5">
                {visible.map((model) => (
                  <span
                    key={model.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] border border-[var(--abu-border)]"
                  >
                    {model.label || model.id}
                    <button
                      type="button"
                      onClick={() => setFormModels(prev => prev.filter(m => m.id !== model.id))}
                      className="text-[var(--abu-text-muted)] hover:text-red-400"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </span>
                ))}
                {/* Collapse / expand toggle */}
                {!modelsExpanded && hidden > 0 && (
                  <button
                    type="button"
                    onClick={() => setModelsExpanded(true)}
                    className="px-2 py-0.5 rounded text-[11px] text-[var(--abu-clay)] border border-dashed border-[var(--abu-clay)]/50 hover:border-[var(--abu-clay)] transition-colors"
                  >
                    +{hidden} 展开全部
                  </button>
                )}
                {modelsExpanded && formModels.length > MODELS_COLLAPSED_COUNT && (
                  <button
                    type="button"
                    onClick={() => setModelsExpanded(false)}
                    className="px-2 py-0.5 rounded text-[11px] text-[var(--abu-clay)] border border-dashed border-[var(--abu-clay)]/50 hover:border-[var(--abu-clay)] transition-colors"
                  >
                    收起
                  </button>
                )}
              </div>
            );
          })()}
          {/* Inline add input */}
          <div className="inline-flex items-center gap-1">
            <input
              type="text"
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder={t.settings.addModelPlaceholder}
              className="h-6 w-28 px-2 text-[11px] rounded border border-[var(--abu-border)] bg-transparent text-[var(--abu-text-primary)] placeholder:text-[var(--abu-text-placeholder)] outline-none focus:border-[var(--abu-clay)]"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddModel(); } }}
            />
            <button
              type="button"
              onClick={handleAddModel}
              disabled={!newModelId.trim()}
              className="h-6 w-6 flex items-center justify-center rounded border border-[var(--abu-border)] text-[var(--abu-text-muted)] hover:border-[var(--abu-clay)] hover:text-[var(--abu-clay)] disabled:opacity-30 transition-colors"
            >
              <Plus className="h-3 w-3" />
            </button>
          </div>
        </div>

        {/* Edit: Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t border-[var(--abu-border)]">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{t.settings.cancelEdit}</Button>
          <Button size="sm" onClick={handleSave}>{t.settings.saveChanges}</Button>
        </div>
      </div>
    );
  }

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
            onClick={handleEditStart}
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
