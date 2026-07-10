import { useState, useCallback, useEffect, useRef, useMemo, type SetStateAction } from 'react';
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
import { Checkbox } from '@/components/ui/checkbox';
import { checkProviderHealth } from '@/core/llm/healthCheck';
import { buildFullChatUrl } from '@/core/llm/urlUtils';
import { useSettingsStore, PROVIDER_CONFIGS } from '@/stores/settingsStore';
import { PROVIDER_GUIDES } from './providerGuides';
import { computeShowAdvanced, defaultModelDeclaredCapabilities } from './providerCapabilities';
import { toModelInfo } from './modelInfoUtil';
import AdvancedCapabilitiesFields from './AdvancedCapabilitiesFields';
import type { LLMProvider, ApiFormat } from '@/types';
import type { ModelInfo, ProviderSource, ModelDeclaredCapabilities } from '@/types/provider';
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
        {
          id: 'lmstudio',
          label: PROVIDER_CONFIGS.lmstudio.name,
          provider: 'lmstudio' as LLMProvider,
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
  const { t, locale } = useI18n();
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
  const [showAddModelInput, setShowAddModelInput] = useState(false);
  const addModelInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // ── Ollama-specific state ──
  const [ollamaStatus, setOllamaStatus] = useState<OllamaConnectionStatus>('idle');
  const [ollamaError, setOllamaError] = useState<string>('');
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);

  // ── Fetch-models state (cloud providers) ──
  const [fetchModelsStatus, setFetchModelsStatus] = useState<FetchModelsStatus>('idle');
  const [fetchedModels, setFetchedModels] = useState<ModelInfo[]>([]);
  const [fetchModelsError, setFetchModelsError] = useState('');

  // ── Advanced capabilities (custom/local providers only) ──
  // Keyed by model id — populated as models are selected/added, independent of
  // which of the three model sources (ollamaModels / fetchedModels / raw
  // selectedModels) the id came from.
  const [perModelDeclared, setPerModelDeclared] = useState<Record<string, ModelDeclaredCapabilities>>({});
  const [expandedModelIds, setExpandedModelIds] = useState<Set<string>>(new Set());
  const [useRawUrl, setUseRawUrl] = useState(false);

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
  const isLMStudio = selectedOption?.provider === 'lmstudio';
  const isCustom = selectedId ? isCustomId(selectedId) : false;
  const showAdvanced = computeShowAdvanced(isCustom, selectedOption?.provider, selectedOption?.format);
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

      // Reset per-model declared capabilities. Models aren't pre-selected for an
      // existing builtin provider either (see setSelectedModels above), so there's
      // nothing to preload per-model here — only the endpoint-level useRawUrl flag
      // is worth restoring from the existing store entry.
      const existingP = providers.find(p => p.id === option.provider);
      setPerModelDeclared({});
      setExpandedModelIds(new Set());
      setUseRawUrl(existingP?.declaredCapabilities?.useRawUrl ?? false);

      // Reset Ollama state
      setOllamaStatus('idle');
      setOllamaError('');
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
      setShowAddModelInput(false);
    },
    [nameManuallyEdited, providers]
  );

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setServiceName(e.target.value);
    setNameManuallyEdited(true);
  }, []);

  // Seed default declared capabilities for newly-selected model ids that don't
  // already have an entry (never overwrites an existing/edited entry). Shared by
  // every path that can add a model to `selectedModels` — manual add, checklist
  // toggle, and the fetch-all-then-select flows (cloud fetch / Ollama fetch) —
  // so expanding a model's caps always shows meaningful defaults, not a
  // misleading all-off state.
  const seedDeclaredDefaults = useCallback((ids: string[]) => {
    setPerModelDeclared(prev => {
      const toAdd = ids.filter(id => !prev[id]);
      if (toAdd.length === 0) return prev;
      const next = { ...prev };
      for (const id of toAdd) next[id] = defaultModelDeclaredCapabilities();
      return next;
    });
  }, []);

  const handleToggleModel = useCallback((modelId: string) => {
    const isSelecting = !selectedModels.has(modelId);
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
    if (isSelecting && showAdvanced) {
      seedDeclaredDefaults([modelId]);
    }
  }, [selectedModels, showAdvanced, seedDeclaredDefaults]);

  const handleAddManualModel = useCallback(() => {
    const id = manualModelInput.trim();
    if (!id) return;
    setSelectedModels((prev) => new Set(prev).add(id));
    if (showAdvanced) {
      seedDeclaredDefaults([id]);
    }
    setManualModelInput('');
  }, [manualModelInput, showAdvanced, seedDeclaredDefaults]);

  const updateModelDeclared = useCallback((id: string, updater: SetStateAction<ModelDeclaredCapabilities>) => {
    setPerModelDeclared(prev => ({
      ...prev,
      [id]: typeof updater === 'function'
        ? (updater as (p: ModelDeclaredCapabilities) => ModelDeclaredCapabilities)(prev[id] ?? {})
        : updater,
    }));
  }, []);

  const toggleModelExpand = useCallback((id: string) => {
    setExpandedModelIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAddModelInput = useCallback(() => {
    setShowAddModelInput((v) => !v);
    setManualModelInput('');
  }, []);

  // Keep the inline add-model input focused whenever it is revealed, so the
  // user can type immediately without an extra click.
  useEffect(() => {
    if (showAddModelInput) addModelInputRef.current?.focus();
  }, [showAddModelInput]);

  // ── Fix 3 dedup: shared per-model "advanced caps" expand affordance ──
  // Used by all three model-list branches (fetched checklist / manual no-fetch
  // list / Ollama list) so the chevron toggle + expanded panel isn't
  // triplicated. Gated identically everywhere: showAdvanced && isSelected.
  const renderModelExpandToggle = (modelId: string, isSelected: boolean) => {
    if (!showAdvanced || !isSelected) return null;
    const isExpanded = expandedModelIds.has(modelId);
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); toggleModelExpand(modelId); }}
        className="text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] shrink-0"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', isExpanded && 'rotate-180')} />
      </button>
    );
  };

  const renderModelCapsPanel = (modelId: string, isSelected: boolean) => {
    if (!showAdvanced || !isSelected || !expandedModelIds.has(modelId)) return null;
    return (
      <div className="pl-2 pt-2 pb-1 border-l-2 border-[var(--abu-border)] ml-1 space-y-1.5">
        <p className="text-[11px] text-[var(--abu-text-tertiary)]">{t.settings.capPerModelHint}</p>
        <AdvancedCapabilitiesFields
          declared={perModelDeclared[modelId] ?? {}}
          setDeclared={(u) => updateModelDeclared(modelId, u)}
          apiFormat={selectedOption?.format ?? 'openai-compatible'}
        />
      </div>
    );
  };

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
      if (showAdvanced) {
        seedDeclaredDefaults(result.models.map((m) => m.id));
      }
      setFetchModelsStatus('success');
    } else if (result.success) {
      setFetchModelsStatus('error');
      setFetchModelsError(t.settings.fetchModelsEmpty);
    } else {
      setFetchModelsStatus('error');
      setFetchModelsError(result.error ?? t.settings.fetchModelsFailed);
    }
  }, [baseUrl, apiKey, selectedOption?.format, t, showAdvanced, seedDeclaredDefaults]);

  // ── Ollama handlers ──

  const handleCheckOllama = useCallback(async () => {
    const url = baseUrl || 'http://127.0.0.1:11434';
    setOllamaStatus('checking');
    setOllamaModels([]);
    setOllamaError('');

    const result = await checkOllamaHealth(url);
    if (!result.ok) {
      setOllamaStatus('offline');
      setOllamaError(result.error ?? '');
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
      if (showAdvanced) {
        seedDeclaredDefaults(modelInfos.map((m) => m.id));
      }

      // Store raw sizes for display (attach to label)
      // Size info is already in the label via formatOllamaModelLabel
    } catch {
      // Ollama fetch failed silently
    }
  }, [baseUrl, showAdvanced, seedDeclaredDefaults]);

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
      return toModelInfo(id, {
        label: ollamaModel?.label,
        declaredCapabilities: showAdvanced ? perModelDeclared[id] : undefined,
      });
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
    const declaredCapabilities = showAdvanced ? { useRawUrl } : undefined;

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
        userAdded: true,
        declaredCapabilities,
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
        userAdded: true,
        declaredCapabilities,
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
    isCustom, showAdvanced, perModelDeclared, useRawUrl, baseUrl, apiKey, providers,
    addProvider, updateProvider, selectModel, onClose,
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
    setShowAddModelInput(false);
    setSearchQuery('');
    setDropdownOpen(false);
    setOllamaStatus('idle');
    setOllamaError('');
    setOllamaModels([]);
    setFetchModelsStatus('idle');
    setFetchedModels([]);
    setFetchModelsError('');
    setPerModelDeclared({});
    setExpandedModelIds(new Set());
    setUseRawUrl(false);
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
      onMouseDown={(e) => { e.stopPropagation(); }}
    >
      <div
        className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-150"
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
        <div className="shrink-0 px-6 pt-4 pb-2 space-y-5">
          {/* 1. Service Name */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--abu-text-primary)]">
              {t.settings.serviceName}
            </label>
            <Input
              value={serviceName}
              onChange={handleNameChange}
              placeholder={t.settings.serviceNameAuto}
              className="h-8"
            />
          </div>

          {/* 2. Provider Dropdown */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--abu-text-primary)]">
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
                <div className="absolute z-20 mt-1 w-full rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-lg overflow-hidden">
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
                              onClick={() => handleSelectProvider(option)}
                              className={cn(
                                'w-full px-3 py-2 flex items-center justify-between text-sm',
                                'hover:bg-[var(--abu-bg-hover)] transition-colors',
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
        <div className="flex-1 overflow-y-auto px-6 pb-5 space-y-2.5">
          {/* 3. Usage Guide Card */}
          {guide && (
            <p className="text-xs text-[var(--abu-text-muted)]">
              {locale.startsWith('zh') ? guide.hint : guide.hintEn}
              <button
                type="button"
                onClick={() => open(guide.url)}
                className="inline-flex items-center gap-1 ml-1.5 text-[var(--abu-clay)] hover:underline"
              >
                {locale.startsWith('zh') ? guide.urlLabel : (guide.urlLabelEn ?? guide.urlLabel)}
                <ExternalLink className="h-3 w-3" />
              </button>
            </p>
          )}

          {/* 4. API Key (hidden for keyless local providers) */}
          {selectedId && !isOllama && !isLMStudio && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-[var(--abu-text-primary)]">
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
                  className="pr-9 h-8"
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
            </div>
          )}

          {/* 5. API Address */}
          {selectedId && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--abu-text-primary)]">
                {isOllama ? t.settings.ollamaUrlLabel : isLMStudio ? t.settings.lmstudioUrlLabel : t.settings.apiUrl}
              </label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={isOllama ? 'http://127.0.0.1:11434' : isLMStudio ? 'http://127.0.0.1:1234/v1' : 'https://...'}
                onBlur={isOllama ? handleCheckOllama : isLMStudio ? handleFetchModels : undefined}
                className="h-8"
              />
              {(isOllama || isLMStudio) && (
                <p className="text-xs text-[var(--abu-text-tertiary)]">
                  {isOllama ? t.settings.ollamaUrlHint : t.settings.lmstudioUrlHint}
                </p>
              )}

              {showAdvanced && selectedOption?.format !== 'anthropic' && (
                <div className="flex items-center gap-2 cursor-pointer select-none pt-1" title={t.settings.capRawUrlHint}
                  onClick={() => setUseRawUrl(v => !v)}>
                  <Checkbox checked={useRawUrl} onChange={() => setUseRawUrl(v => !v)} />
                  <span className="text-xs text-[var(--abu-text-primary)]">{t.settings.capRawUrl}</span>
                </div>
              )}

              {/* Final request URL preview — hidden for local providers which have their own status UI */}
              {!isOllama && !isLMStudio && baseUrl.trim() && selectedOption && (
                <p className="text-[11px] font-mono text-[var(--abu-text-muted)] break-all">
                  ↳ {t.settings.apiUrlPreview}: POST {buildFullChatUrl(baseUrl, selectedOption.format, { useRawUrl })}
                </p>
              )}

              {/* Ollama connection status */}
              {isOllama && ollamaStatus !== 'idle' && ollamaStatus !== 'checking' && (
                <div className="mt-1 space-y-0.5">
                  <div className={cn(
                    'flex items-center gap-1.5 text-xs',
                    ollamaStatus === 'online' ? 'text-green-500' : 'text-red-400',
                  )}>
                    {ollamaStatus === 'online'
                      ? <><CircleCheck className="h-3.5 w-3.5" /> {t.settings.ollamaOnline}</>
                      : <><CircleX className="h-3.5 w-3.5" /> {t.settings.ollamaOffline}</>}
                  </div>
                  {ollamaStatus === 'offline' && ollamaError && (
                    <p className="text-[11px] font-mono text-red-400/70 break-all pl-5">{ollamaError}</p>
                  )}
                </div>
              )}

              {/* LM Studio connection status */}
              {isLMStudio && fetchModelsStatus !== 'idle' && fetchModelsStatus !== 'fetching' && (
                <div className={cn(
                  'flex items-center gap-1.5 text-xs mt-1',
                  fetchModelsStatus === 'success' ? 'text-green-500' : 'text-red-400',
                )}>
                  {fetchModelsStatus === 'success'
                    ? <><CircleCheck className="h-3.5 w-3.5" /> {t.settings.lmstudioOnline}</>
                    : <><CircleX className="h-3.5 w-3.5" /> {t.settings.lmstudioOffline}</>}
                </div>
              )}
            </div>
          )}

          {/* 6. Model Selection */}
          {selectedId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-[var(--abu-text-primary)]">
                  {t.settings.models}
                </label>
                <div className="flex items-center gap-3">
                  {/* Fetch/refresh models button — only when baseUrl is filled */}
                  {!isOllama && selectedOption?.format !== 'anthropic' && baseUrl.trim() && (
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
                  {!isOllama && (
                    <button
                      type="button"
                      onClick={toggleAddModelInput}
                      className="flex items-center gap-1 text-xs text-[var(--abu-clay)] hover:underline"
                    >
                      <Plus className="h-3 w-3" />
                      {t.settings.addModel}
                    </button>
                  )}
                </div>
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

              {/* Non-Ollama models — fetched checklist (checkbox select/deselect) merged
                  with manually-added ids (remove via X); one card per model. */}
              {!isOllama && (() => {
                const hasFetched = fetchedModels.length > 0;
                const displayList: ModelInfo[] = hasFetched
                  ? [
                      ...fetchedModels,
                      ...[...selectedModels]
                        .filter((id) => !fetchedModels.some((m) => m.id === id))
                        .map((id) => ({ id, label: id })),
                    ]
                  : [...selectedModels].map((id) => ({ id, label: id }));

                if (!showAddModelInput && displayList.length === 0) return null;

                return (
                  <div className="max-h-48 overflow-y-auto space-y-2">
                    {/* Inline add-model input, revealed at the top of the model list */}
                    {showAddModelInput && (
                      <div className="flex items-center gap-1.5">
                        <Input
                          ref={addModelInputRef}
                          value={manualModelInput}
                          onChange={(e) => setManualModelInput(e.target.value)}
                          placeholder={t.settings.addModelPlaceholder}
                          className="h-7 px-2 text-xs flex-1"
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddManualModel(); } }}
                        />
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="outline"
                          onClick={() => { handleAddManualModel(); addModelInputRef.current?.focus(); }}
                          disabled={!manualModelInput.trim()}
                        >
                          <Plus className="h-3 w-3" />
                        </Button>
                        <Button type="button" size="icon-xs" variant="ghost" onClick={toggleAddModelInput}>
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    )}

                    {displayList.map((model) => {
                      const isSelected = hasFetched ? selectedModels.has(model.id) : true;
                      return (
                        <div key={model.id} className="rounded-lg border border-[var(--abu-border)] p-2">
                          <div
                            className={cn('flex items-center gap-2.5', hasFetched && 'cursor-pointer')}
                            onClick={hasFetched ? () => handleToggleModel(model.id) : undefined}
                          >
                            {renderModelExpandToggle(model.id, isSelected)}
                            <div className={cn(
                              'flex items-center justify-center h-4 w-4 rounded border transition-colors shrink-0',
                              isSelected
                                ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)]'
                                : 'border-[var(--abu-border)]',
                            )}>
                              {isSelected && <Check className="h-3 w-3 text-white" />}
                            </div>
                            <span className="text-sm text-[var(--abu-text-primary)] flex-1 truncate">{model.label}</span>
                            {!hasFetched && (
                              <button
                                type="button"
                                onClick={() => handleToggleModel(model.id)}
                                className="text-[var(--abu-text-muted)] hover:text-red-400 shrink-0"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                          {renderModelCapsPanel(model.id, isSelected)}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {/* Ollama models — checkbox list with size, one card per model */}
              {isOllama && ollamaStatus === 'online' && ollamaModels.length > 0 && (
                <div className="max-h-48 overflow-y-auto space-y-2">
                  {ollamaModels.map((model) => {
                    const isSelected = selectedModels.has(model.id);
                    return (
                      <div key={model.id} className="rounded-lg border border-[var(--abu-border)] p-2">
                        <label className="flex items-center gap-2.5 cursor-pointer">
                          {renderModelExpandToggle(model.id, isSelected)}
                          <div className={cn(
                            'flex items-center justify-center h-4 w-4 rounded border transition-colors shrink-0',
                            isSelected
                              ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)]'
                              : 'border-[var(--abu-border)]',
                          )}>
                            {isSelected && <Check className="h-3 w-3 text-white" />}
                          </div>
                          <span className="text-sm text-[var(--abu-text-primary)] flex-1">{model.label}</span>
                        </label>
                        {renderModelCapsPanel(model.id, isSelected)}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Ollama — no models detected */}
              {isOllama && ollamaStatus === 'online' && ollamaModels.length === 0 && (
                <div className="text-sm text-[var(--abu-text-tertiary)] px-1">
                  <p>{t.settings.ollamaNoModels}</p>
                  <p className="text-xs mt-1">{t.settings.ollamaNoModelsHint}</p>
                </div>
              )}
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-4 border-t border-[var(--abu-border)] flex items-center justify-between">
          {/* Left: validate connection + inline result */}
          <div className="flex items-center gap-2 min-w-0">
            {selectedId && !isOllama && !isLMStudio && (
              <button
                type="button"
                onClick={handleValidate}
                disabled={validating || !apiKey.trim() || !baseUrl.trim()}
                className="shrink-0 text-xs text-[var(--abu-clay)] hover:underline disabled:opacity-40 disabled:no-underline flex items-center gap-1"
              >
                {validating && <Loader2 className="h-3 w-3 animate-spin" />}
                {validating ? t.settings.validating : t.settings.validateConnection}
              </button>
            )}
            {validateResult && (
              <div className="flex items-center gap-1 min-w-0">
                {validateResult.success
                  ? <CircleCheck className="h-3.5 w-3.5 text-green-600 shrink-0" />
                  : <CircleX className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                <span className={cn('text-xs truncate max-w-[280px]', validateResult.success ? 'text-green-600' : 'text-red-500')}>
                  {validateResult.message}
                </span>
              </div>
            )}
          </div>
          {/* Right: cancel + save */}
          <div className="flex items-center gap-3 shrink-0">
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
      </div>
    </div>,
    document.body
  );
}
