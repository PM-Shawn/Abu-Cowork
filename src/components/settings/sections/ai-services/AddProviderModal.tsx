import { useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Search, ExternalLink, Eye, EyeOff, Check, Plus, Loader2,
  CircleCheck, CircleX, RefreshCw, ChevronDown,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { checkProviderHealth } from '@/core/llm/healthCheck';
import { buildFullChatUrl } from '@/core/llm/urlUtils';
import { useSettingsStore, PROVIDER_CONFIGS } from '@/stores/settingsStore';
import { PROVIDER_GUIDES } from './providerGuides';
import type { LLMProvider, ApiFormat } from '@/types';
import type { ModelInfo, ProviderSource } from '@/types/provider';
import {
  checkOllamaHealth,
  fetchOllamaModels,
  formatOllamaModelLabel,
} from '@/core/llm/ollama';
import { fetchProviderModels } from '@/core/llm/modelFetcher';

// ── Types ────────────────────────────────────────────────────────

interface AddProviderModalProps {
  open: boolean;
  onClose: () => void;
}

type ProviderOption = {
  id: string;
  label: string;
  provider: LLMProvider;
  source: ProviderSource;
  format: ApiFormat;
};

type ProviderGroup = {
  label: string;
  key: string;
  options: ProviderOption[];
};

type OllamaConnectionStatus = 'idle' | 'checking' | 'online' | 'offline';
type FetchModelsStatus = 'idle' | 'fetching' | 'success' | 'error';

// ── Constants ────────────────────────────────────────────────────

const CLOUD_PROVIDERS: { id: LLMProvider; label: string }[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'moonshot', label: 'Moonshot' },
  { id: 'zhipu', label: 'Zhipu AI' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'volcengine', label: 'Volcengine' },
  { id: 'bailian', label: 'Bailian' },
  { id: 'siliconflow', label: 'SiliconFlow' },
  { id: 'qiniu', label: 'Qiniu' },
  { id: 'openrouter', label: 'OpenRouter' },
];

const CUSTOM_OPENAI_ID = '__custom_openai__';
const CUSTOM_ANTHROPIC_ID = '__custom_anthropic__';

// ── Helpers ──────────────────────────────────────────────────────

function buildProviderGroups(t: ReturnType<typeof useI18n>['t']): ProviderGroup[] {
  return [
    {
      label: t.settings.cloudProviders,
      key: 'cloud',
      options: CLOUD_PROVIDERS.map((p) => ({
        id: p.id,
        label: PROVIDER_CONFIGS[p.id].name,
        provider: p.id,
        source: 'builtin' as ProviderSource,
        format: PROVIDER_CONFIGS[p.id].format,
      })),
    },
    {
      label: t.settings.localProviders,
      key: 'local',
      options: [
        {
          id: 'ollama',
          label: PROVIDER_CONFIGS.ollama.name,
          provider: 'ollama' as LLMProvider,
          source: 'builtin' as ProviderSource,
          format: 'openai-compatible' as ApiFormat,
        },
      ],
    },
    {
      label: t.settings.customProviders,
      key: 'custom',
      options: [
        {
          id: CUSTOM_OPENAI_ID,
          label: t.settings.customApiOpenai,
          provider: 'custom' as LLMProvider,
          source: 'custom' as ProviderSource,
          format: 'openai-compatible' as ApiFormat,
        },
        {
          id: CUSTOM_ANTHROPIC_ID,
          label: t.settings.customApiAnthropic,
          provider: 'custom' as LLMProvider,
          source: 'custom' as ProviderSource,
          format: 'anthropic' as ApiFormat,
        },
      ],
    },
  ];
}

function isCustomId(id: string): boolean {
  return id === CUSTOM_OPENAI_ID || id === CUSTOM_ANTHROPIC_ID;
}

// ── Component ────────────────────────────────────────────────────

export default function AddProviderModal({ open: isOpen, onClose }: AddProviderModalProps) {
  const { t } = useI18n();
  const providers = useSettingsStore((s) => s.providers);
  const addProvider = useSettingsStore((s) => s.addProvider);
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const selectModel = useSettingsStore((s) => s.selectModel);

  // ── Form state ──
  const [selectedId, setSelectedId] = useState<string>('');
  const [serviceName, setServiceName] = useState('');
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [manualModelInput, setManualModelInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Ollama-specific state ──
  const [ollamaStatus, setOllamaStatus] = useState<OllamaConnectionStatus>('idle');
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);

  // ── Fetch-models state (cloud providers) ──
  const [fetchModelsStatus, setFetchModelsStatus] = useState<FetchModelsStatus>('idle');
  const [fetchedModels, setFetchedModels] = useState<ModelInfo[]>([]);
  const [fetchModelsError, setFetchModelsError] = useState('');

  // ── Validate state ──
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<{ success: boolean; message: string } | null>(null);

  // ── Derived ──
  // Only providers that are visible in the list (enabled or has key) count as "added"
  const existingProviderIds = useMemo(
    () => new Set(providers.filter(p => p.enabled || p.apiKey.trim().length > 0).map((p) => p.name)),
    [providers]
  );

  const groups = useMemo(() => buildProviderGroups(t), [t]);

  const selectedOption = useMemo(() => {
    for (const g of groups) {
      const found = g.options.find((o) => o.id === selectedId);
      if (found) return found;
    }
    return null;
  }, [groups, selectedId]);

  const isOllama = selectedOption?.provider === 'ollama';
  const isCustom = selectedId ? isCustomId(selectedId) : false;
  const guide = selectedOption && !isCustom ? PROVIDER_GUIDES[selectedOption.provider] : null;

  // knownModels removed — models are fetched from API or added manually

  // ── Filtered dropdown options ──
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groups;
    const q = searchQuery.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        options: g.options.filter((o) => o.label.toLowerCase().includes(q)),
      }))
      .filter((g) => g.options.length > 0);
  }, [groups, searchQuery]);

  // ── Handlers ──

  const handleSelectProvider = useCallback(
    (option: ProviderOption) => {
      setSelectedId(option.id);
      setDropdownOpen(false);
      setSearchQuery('');

      // Auto-fill name if user hasn't manually edited
      if (!nameManuallyEdited) {
        setServiceName(option.label);
      }

      // Auto-fill base URL for known providers
      if (!isCustomId(option.id)) {
        const config = PROVIDER_CONFIGS[option.provider];
        setBaseUrl(config.baseUrl);

        // Don't pre-select models — user fetches from API or adds manually
        setSelectedModels(new Set());
      } else {
        setBaseUrl('');
        setSelectedModels(new Set());
      }

      // Reset Ollama state
      setOllamaStatus('idle');
      setOllamaModels([]);

      // Reset fetch-models state
      setFetchModelsStatus('idle');
      setFetchedModels([]);
      setFetchModelsError('');
      setApiKey('');
      setShowApiKey(false);
      // (fetch removed)
      // (fetch removed)
      setManualModelInput('');
    },
    [nameManuallyEdited]
  );

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setServiceName(e.target.value);
    setNameManuallyEdited(true);
  }, []);

  const handleToggleModel = useCallback((modelId: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }, []);

  const handleAddManualModel = useCallback(() => {
    const id = manualModelInput.trim();
    if (!id) return;
    setSelectedModels((prev) => new Set(prev).add(id));
    setManualModelInput('');
  }, [manualModelInput]);

  // ── Fetch models handler (cloud providers) ──

  const handleFetchModels = useCallback(async () => {
    if (!baseUrl.trim()) return;
    setFetchModelsStatus('fetching');
    setFetchedModels([]);
    setFetchModelsError('');

    const result = await fetchProviderModels(
      baseUrl,
      apiKey,
      selectedOption?.format ?? 'openai-compatible',
    );

    if (result.success && result.models.length > 0) {
      setFetchedModels(result.models);
      setSelectedModels(new Set(result.models.map((m) => m.id)));
      setFetchModelsStatus('success');
    } else if (result.success) {
      setFetchModelsStatus('error');
      setFetchModelsError('未获取到模型，请手动添加');
    } else {
      setFetchModelsStatus('error');
      setFetchModelsError(result.error ?? '获取失败');
    }
  }, [baseUrl, apiKey, selectedOption?.format]);

  // ── Ollama handlers ──

  const handleCheckOllama = useCallback(async () => {
    const url = baseUrl || 'http://localhost:11434';
    setOllamaStatus('checking');
    setOllamaModels([]);
    // (fetch removed)

    const isHealthy = await checkOllamaHealth(url);
    if (!isHealthy) {
      setOllamaStatus('offline');
      return;
    }

    setOllamaStatus('online');
    try {
      const models = await fetchOllamaModels(url);
      const modelInfos: ModelInfo[] = models.map((m) => ({
        id: m.name,
        label: formatOllamaModelLabel(m),
        isCustom: false,
      }));
      setOllamaModels(modelInfos);

      // Auto-select all fetched models
      setSelectedModels(new Set(modelInfos.map((m) => m.id)));

      // Store raw sizes for display (attach to label)
      // Size info is already in the label via formatOllamaModelLabel
    } catch {
      // Ollama fetch failed silently
    }
  }, [baseUrl]);

  // ── Validate connection ──
  const handleValidate = useCallback(async () => {
    if (!baseUrl.trim() || !apiKey.trim()) return;
    setValidating(true);
    setValidateResult(null);
    try {
      // Build a temporary provider for health check
      const models = Array.from(selectedModels).map(id => ({ id, label: id }));
      const testModel = models[0]?.id ?? '';
      const result = await checkProviderHealth({
        id: '_test',
        source: 'custom',
        name: '',
        enabled: true,
        apiFormat: selectedOption?.format ?? 'openai-compatible',
        baseUrl,
        apiKey,
        models: testModel ? [{ id: testModel, label: testModel }] : [],
        status: 'unchecked',
        sortOrder: 0,
      });
      setValidateResult({
        success: result.success,
        message: result.success
          ? t.settings.validationSuccess.replace('{latency}', String(result.latencyMs))
          : (result.error ?? t.settings.validationFailed),
      });
    } catch {
      setValidateResult({ success: false, message: t.settings.validationFailed });
    } finally {
      setValidating(false);
    }
  }, [baseUrl, apiKey, selectedModels, selectedOption, t]);

  // ── Save ──

  const handleSave = useCallback(() => {
    if (!serviceName.trim()) return;
    if (selectedModels.size === 0) return;

    const modelInfos: ModelInfo[] = Array.from(selectedModels).map((id) => {
      const ollamaModel = ollamaModels.find((m) => m.id === id);
      if (ollamaModel) return { id, label: ollamaModel.label };
      return { id, label: id };
    });

    const apiFormat: ApiFormat = selectedOption
      ? selectedOption.format
      : 'openai-compatible';

    const resolvedBaseUrl = baseUrl || (selectedOption && !isCustom
      ? PROVIDER_CONFIGS[selectedOption.provider].baseUrl
      : '');
    const capabilities = selectedOption && !isCustom
      ? PROVIDER_CONFIGS[selectedOption.provider].capabilities
      : undefined;

    // For builtin providers: update the existing entry instead of creating a duplicate
    const existingBuiltin = !isCustom && selectedOption
      ? providers.find(p => p.id === selectedOption.provider)
      : null;

    let providerId: string;
    if (existingBuiltin) {
      updateProvider(existingBuiltin.id, {
        name: serviceName.trim(),
        enabled: true,
        apiKey,
        baseUrl: resolvedBaseUrl,
        models: modelInfos,
        capabilities,
      });
      providerId = existingBuiltin.id;
    } else {
      providerId = addProvider({
        source: isCustom ? 'custom' : 'builtin',
        name: serviceName.trim(),
        enabled: true,
        apiFormat,
        baseUrl: resolvedBaseUrl,
        apiKey,
        models: modelInfos,
        capabilities,
      });
    }

    // Auto-select first model if this is the first enabled provider
    const hasOtherEnabled = providers.some(p => p.enabled && p.id !== providerId);
    if (!hasOtherEnabled && modelInfos.length > 0) {
      selectModel(providerId, modelInfos[0].id);
    }

    onClose();
  }, [
    serviceName, selectedModels, ollamaModels, selectedOption,
    isCustom, baseUrl, apiKey, providers, addProvider, updateProvider,
    selectModel, onClose,
  ]);

  // ── Reset on close ──
  const handleClose = useCallback(() => {
    setSelectedId('');
    setServiceName('');
    setNameManuallyEdited(false);
    setApiKey('');
    setShowApiKey(false);
    setBaseUrl('');
    setSelectedModels(new Set());
    setManualModelInput('');
    setSearchQuery('');
    setDropdownOpen(false);
    setOllamaStatus('idle');
    setOllamaModels([]);
    setFetchModelsStatus('idle');
    setFetchedModels([]);
    setFetchModelsError('');
    onClose();
  }, [onClose]);

  if (!isOpen) return null;

  // ── Render helpers ──

  const isAlreadyAdded = (option: ProviderOption) => {
    if (isCustomId(option.id)) return false;
    const config = PROVIDER_CONFIGS[option.provider];
    return existingProviderIds.has(config.name);
  };

  const canSave = serviceName.trim() && selectedModels.size > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[var(--abu-border)]">
          <h2 className="text-lg font-semibold text-[var(--abu-text-primary)]">
            {t.settings.addService}
          </h2>
          <Button variant="ghost" size="icon-sm" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Fixed top area: name + provider selector (not scrollable, so dropdown won't clip) */}
        <div className="shrink-0 px-6 pt-5 pb-3 space-y-5">
          {/* 1. Service Name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--abu-text-primary)]">
              {t.settings.serviceName}
            </label>
            <Input
              value={serviceName}
              onChange={handleNameChange}
              placeholder={t.settings.serviceNameAuto}
            />
          </div>

          {/* 2. Provider Dropdown */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-[var(--abu-text-primary)]">
              {t.settings.selectProviderType}
            </label>
            <div className="relative" ref={dropdownRef}>
              <button
                type="button"
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className={cn(
                  'w-full h-9 px-3 flex items-center justify-between',
                  'bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] rounded-lg',
                  'text-sm text-[var(--abu-text-primary)]',
                  'hover:border-[var(--abu-clay)] transition-colors',
                )}
              >
                <span className={selectedOption ? '' : 'text-[var(--abu-text-placeholder)]'}>
                  {selectedOption ? selectedOption.label : t.settings.selectProviderType}
                </span>
                <ChevronDown className={cn('h-4 w-4 text-[var(--abu-text-secondary)] transition-transform', dropdownOpen && 'rotate-180')} />
              </button>

              {dropdownOpen && (
                <div className="absolute z-20 mt-1 w-full rounded-lg border border-[var(--abu-border)] bg-white shadow-lg overflow-hidden">
                  {/* Search */}
                  <div className="p-2 border-b border-[var(--abu-border)]">
                    <div className="relative">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-placeholder)]" />
                      <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={t.settings.searchProvider}
                        className="pl-8 h-8 text-xs"
                        autoFocus
                      />
                    </div>
                  </div>

                  {/* Options */}
                  <div className="max-h-60 overflow-y-auto py-1">
                    {filteredGroups.map((group) => (
                      <div key={group.key}>
                        <div className="px-3 py-1.5 text-xs font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">
                          {group.label}
                        </div>
                        {group.options.map((option) => {
                          const added = isAlreadyAdded(option);
                          return (
                            <button
                              key={option.id}
                              type="button"
                              disabled={added}
                              onClick={() => handleSelectProvider(option)}
                              className={cn(
                                'w-full px-3 py-2 flex items-center justify-between text-sm',
                                'hover:bg-[var(--abu-bg-hover)] transition-colors',
                                added && 'opacity-50 cursor-not-allowed',
                                selectedId === option.id && 'bg-[var(--abu-bg-hover)]',
                              )}
                            >
                              <span className="text-[var(--abu-text-primary)]">{option.label}</span>
                              {added && (
                                <span className="text-xs text-[var(--abu-text-tertiary)]">
                                  {t.settings.alreadyAdded}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Scrollable content area: guide, API key, models, etc. */}
        <div className="flex-1 overflow-y-auto px-6 pb-5 space-y-5">
          {/* 3. Usage Guide Card */}
          {guide && (
            <p className="text-xs text-[var(--abu-text-muted)]">
              {guide.hint}
              <button
                type="button"
                onClick={() => open(guide.url)}
                className="inline-flex items-center gap-1 ml-1.5 text-[var(--abu-clay)] hover:underline"
              >
                {guide.urlLabel}
                <ExternalLink className="h-3 w-3" />
              </button>
            </p>
          )}

          {/* 4. API Key (hidden for Ollama) */}
          {selectedId && !isOllama && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-[var(--abu-text-primary)]">
                  {t.settings.apiKey}
                </label>
                <span className="text-xs text-[var(--abu-text-tertiary)]">
                  {isCustom ? t.settings.apiKeyOptional : t.settings.apiKeyRequired}
                </span>
              </div>
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-secondary)]"
                >
                  {showApiKey
                    ? <EyeOff className="h-4 w-4" />
                    : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {/* Inline validate */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleValidate}
                  disabled={validating || !apiKey.trim() || !baseUrl.trim()}
                  className="text-xs text-[var(--abu-clay)] hover:underline disabled:opacity-40 disabled:no-underline flex items-center gap-1"
                >
                  {validating && <Loader2 className="h-3 w-3 animate-spin" />}
                  {validating ? t.settings.validating : t.settings.validateConnection}
                </button>
                {validateResult && (
                  <span className={cn('text-xs', validateResult.success ? 'text-green-600' : 'text-red-500')}>
                    {validateResult.message}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* 5. API Address */}
          {selectedId && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-[var(--abu-text-primary)]">
                {isOllama ? t.settings.ollamaUrlLabel : t.settings.apiUrl}
              </label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={isOllama ? 'http://localhost:11434' : 'https://...'}
                onBlur={isOllama ? handleCheckOllama : undefined}
              />
              <p className="text-xs text-[var(--abu-text-tertiary)]">
                {isOllama ? t.settings.ollamaUrlHint : t.settings.apiUrlNoChange}
              </p>

              {/* Final request URL preview — helps users spot malformed URLs
                  (stray whitespace, wrong path, missing /v1) before hitting the
                  validate button. Hidden for Ollama which has its own status UI. */}
              {!isOllama && baseUrl.trim() && selectedOption && (
                <p className="text-[11px] font-mono text-[var(--abu-text-muted)] break-all">
                  ↳ {t.settings.apiUrlPreview}: POST {buildFullChatUrl(baseUrl, selectedOption.format)}
                </p>
              )}

              {/* Ollama connection status */}
              {isOllama && ollamaStatus !== 'idle' && ollamaStatus !== 'checking' && (
                <div className={cn(
                  'flex items-center gap-1.5 text-xs mt-1',
                  ollamaStatus === 'online' ? 'text-green-500' : 'text-red-400',
                )}>
                  {ollamaStatus === 'online'
                    ? <><CircleCheck className="h-3.5 w-3.5" /> {t.settings.ollamaOnline}</>
                    : <><CircleX className="h-3.5 w-3.5" /> {t.settings.ollamaOffline}</>}
                </div>
              )}
            </div>
          )}

          {/* 6. Model Selection */}
          {selectedId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-[var(--abu-text-primary)]">
                  {t.settings.models}
                </label>
                {/* Fetch/refresh models button */}
                {!isOllama && selectedOption?.format !== 'anthropic' && (
                  <button
                    type="button"
                    onClick={handleFetchModels}
                    disabled={fetchModelsStatus === 'fetching' || !baseUrl.trim()}
                    className="flex items-center gap-1 text-xs text-[var(--abu-clay)] hover:underline disabled:opacity-40 disabled:no-underline"
                  >
                    {fetchModelsStatus === 'fetching'
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />}
                    {fetchModelsStatus === 'fetching' ? t.settings.fetchingModels : t.settings.fetchModels}
                  </button>
                )}
                {isOllama && (
                  <button
                    type="button"
                    onClick={handleCheckOllama}
                    disabled={ollamaStatus === 'checking'}
                    className="flex items-center gap-1 text-xs text-[var(--abu-clay)] hover:underline disabled:opacity-40 disabled:no-underline"
                  >
                    {ollamaStatus === 'checking'
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />}
                    {ollamaStatus === 'checking' ? t.settings.fetchingModels : t.settings.fetchModels}
                  </button>
                )}
              </div>

              {/* Fetch status messages */}
              {fetchModelsStatus === 'success' && (
                <p className="text-xs text-green-600">
                  {t.settings.fetchModelsSuccess.replace('{count}', String(fetchedModels.length))}
                </p>
              )}
              {fetchModelsStatus === 'error' && (
                <p className="text-xs text-red-500">
                  {fetchModelsError || t.settings.fetchModelsError}
                </p>
              )}

              {/* Fetched models — selectable checklist (cloud providers after fetch) */}
              {!isOllama && fetchedModels.length > 0 && (() => {
                // Merge: fetched models first, then any manually-added IDs not in the list
                const extraIds = [...selectedModels].filter(
                  (id) => !fetchedModels.some((m) => m.id === id)
                );
                const displayList: ModelInfo[] = [
                  ...fetchedModels,
                  ...extraIds.map((id) => ({ id, label: id })),
                ];
                return (
                  <div className="space-y-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--abu-border)] p-2">
                    {displayList.map((model) => (
                      <label
                        key={model.id}
                        className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-[var(--abu-bg-hover)] cursor-pointer"
                        onClick={() => handleToggleModel(model.id)}
                      >
                        <div className={cn(
                          'flex items-center justify-center h-4 w-4 rounded border transition-colors shrink-0',
                          selectedModels.has(model.id)
                            ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)]'
                            : 'border-[var(--abu-border)]',
                        )}>
                          {selectedModels.has(model.id) && <Check className="h-3 w-3 text-white" />}
                        </div>
                        <span className="text-sm text-[var(--abu-text-primary)] flex-1 truncate">{model.label}</span>
                      </label>
                    ))}
                  </div>
                );
              })()}

              {/* No fetch yet — show manually selected models with remove buttons */}
              {!isOllama && fetchedModels.length === 0 && selectedModels.size > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--abu-border)] p-2">
                  {[...selectedModels].map((modelId) => (
                    <div
                      key={modelId}
                      className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-[var(--abu-bg-hover)]"
                    >
                      <div className="flex items-center justify-center h-4 w-4 rounded border bg-[var(--abu-clay)] border-[var(--abu-clay)] shrink-0">
                        <Check className="h-3 w-3 text-white" />
                      </div>
                      <span className="text-sm text-[var(--abu-text-primary)] flex-1 truncate">{modelId}</span>
                      <button
                        type="button"
                        onClick={() => handleToggleModel(modelId)}
                        className="text-[var(--abu-text-muted)] hover:text-red-400 shrink-0"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Ollama models — checkbox list with size */}
              {isOllama && ollamaStatus === 'online' && ollamaModels.length > 0 && (
                <div className="space-y-1 max-h-48 overflow-y-auto rounded-lg border border-[var(--abu-border)] p-2">
                  {ollamaModels.map((model) => (
                    <label
                      key={model.id}
                      className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-[var(--abu-bg-hover)] cursor-pointer"
                    >
                      <div className={cn(
                        'flex items-center justify-center h-4 w-4 rounded border transition-colors',
                        selectedModels.has(model.id)
                          ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)]'
                          : 'border-[var(--abu-border)]',
                      )}>
                        {selectedModels.has(model.id) && <Check className="h-3 w-3 text-white" />}
                      </div>
                      <span className="text-sm text-[var(--abu-text-primary)] flex-1">{model.label}</span>
                    </label>
                  ))}
                </div>
              )}

              {/* Ollama — no models detected */}
              {isOllama && ollamaStatus === 'online' && ollamaModels.length === 0 && (
                <div className="text-sm text-[var(--abu-text-tertiary)] px-1">
                  <p>{t.settings.ollamaNoModels}</p>
                  <p className="text-xs mt-1">{t.settings.ollamaNoModelsHint}</p>
                </div>
              )}

              {/* Manual model add (all non-Ollama providers) */}
              {!isOllama && (
                <div className="flex gap-2">
                  <Input
                    value={manualModelInput}
                    onChange={(e) => setManualModelInput(e.target.value)}
                    placeholder={t.settings.addModelPlaceholder}
                    className="flex-1"
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddManualModel(); }}
                  />
                  <Button
                    variant="outline"
                    size="default"
                    onClick={handleAddManualModel}
                    disabled={!manualModelInput.trim()}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-4 border-t border-[var(--abu-border)] flex justify-end gap-3">
          <Button variant="ghost" onClick={handleClose}>
            {t.common.cancel}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave}
          >
            {t.settings.save}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
