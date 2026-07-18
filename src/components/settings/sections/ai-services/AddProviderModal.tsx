import { useState, useCallback, useEffect, useLayoutEffect, useRef, useMemo, type SetStateAction, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Search, ExternalLink, Eye, EyeOff, Check, Plus, Loader2,
  CircleCheck, CircleX, RefreshCw, ChevronDown, AlertTriangle, Trash2,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-shell';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { checkProviderHealth } from '@/core/llm/healthCheck';
import { buildFullChatUrl } from '@/core/llm/urlUtils';
import { isKnownModel } from '@/core/llm/modelCapabilities';
import { useSettingsStore, PROVIDER_CONFIGS } from '@/stores/settingsStore';
import { PROVIDER_GUIDES } from './providerGuides';
import { computeShowAdvanced, defaultModelDeclaredCapabilities } from './providerCapabilities';
import { toModelInfo } from './modelInfoUtil';
import { sortKnownFirst, computeFetchPreselection, SMALL_LIST_MAX } from './fetchModelUtils';
import AdvancedCapabilitiesFields from './AdvancedCapabilitiesFields';
import type { LLMProvider, ApiFormat } from '@/types';
import type { ModelInfo, ProviderSource, ModelDeclaredCapabilities, ProviderInstance } from '@/types/provider';
import {
  checkOllamaHealth,
  fetchOllamaModels,
  formatOllamaModelLabel,
} from '@/core/llm/ollama';
import { fetchProviderModels } from '@/core/llm/modelFetcher';
import { SECRET_KEYS } from '@/utils/secretStore';

// ── Types ────────────────────────────────────────────────────────

interface AddProviderModalProps {
  open: boolean;
  onClose: () => void;
  /** When present, the modal opens in edit mode for this existing provider:
   *  the provider selector locks into a read-only chip, fields prefill from
   *  the instance, save routes through `updateProvider(editProvider.id, …)`
   *  instead of creating a new entry, and a "Delete service" action appears
   *  in the footer. Unifies what used to be ProviderCard's separate inline
   *  edit form with this modal's "add" flow — see
   *  docs/2026-07-11-modal-unify-design.md. */
  editProvider?: ProviderInstance;
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
  { id: 'volcengine', label: 'Volcengine' },
  { id: 'zhipu', label: 'Zhipu GLM' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'moonshot', label: 'Kimi' },
  { id: 'minimax', label: 'MiniMax' },
  { id: 'bailian', label: 'Bailian' },
  { id: 'siliconflow', label: 'SiliconFlow' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'qiniu', label: 'Qiniu' },
];

const CUSTOM_ID = '__custom__';

// ── Helpers ──────────────────────────────────────────────────────

function buildProviderGroups(t: ReturnType<typeof useI18n>['t']): ProviderGroup[] {
  return [
    {
      label: t.settings.cloudProviders,
      key: 'cloud',
      options: CLOUD_PROVIDERS.map((p) => ({
        id: p.id,
        // Localized display name where available (e.g. 火山引擎 → "Volcengine"
        // in the English UI); falls back to the canonical PROVIDER_CONFIGS
        // name for everything else (already brand/English, or untranslated).
        label: (t.settings.providerNames as Partial<Record<LLMProvider, string>>)[p.id] ?? PROVIDER_CONFIGS[p.id].name,
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
          id: CUSTOM_ID,
          label: t.settings.customApi,
          provider: 'custom' as LLMProvider,
          source: 'custom' as ProviderSource,
          // Nominal — the format actually used is picked via the config-plan
          // dropdown (openai/anthropic plans on PROVIDER_CONFIGS.custom, see
          // design doc §7b) and read from `effectiveFormat`, not this field.
          format: 'openai-compatible' as ApiFormat,
        },
      ],
    },
  ];
}

function isCustomId(id: string): boolean {
  return id === CUSTOM_ID;
}

// Display order for a provider's config plans: recommended first, paygo last.
const PLAN_ORDER: Record<string, number> = { agent: 0, tokenplan: 1, coding: 2, paygo: 3 };

// ── Component ────────────────────────────────────────────────────

export default function AddProviderModal({ open: isOpen, onClose, editProvider }: AddProviderModalProps) {
  const { t } = useI18n();
  const providers = useSettingsStore((s) => s.providers);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const addProvider = useSettingsStore((s) => s.addProvider);
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const removeProvider = useSettingsStore((s) => s.removeProvider);
  const selectModel = useSettingsStore((s) => s.selectModel);
  // True when bootstrapSecrets detected a prior ciphertext for the provider
  // being edited but couldn't decrypt it (typical cause: hardware/UUID
  // change). Mirrors the same check ProviderCard's retired inline edit form
  // used to make — must not be lost in the unification (see design doc §6).
  const keyDecryptFailed = useSettingsStore((s) =>
    !!editProvider && s.failedSecretKeys.includes(SECRET_KEYS.provider(editProvider.id)),
  );

  // ── Form state ──
  const [selectedId, setSelectedId] = useState<string>('');
  const [serviceName, setServiceName] = useState('');
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());
  const [manualModelInput, setManualModelInput] = useState('');
  const [showAddModelInput, setShowAddModelInput] = useState(false);
  // Separate from showAddModelInput (which belongs to the custom/aggregator
  // inline flow): toggles the built-in curated dropdown's bottom "使用其他模型"
  // row between its default menu-item state and the revealed model-id input.
  const [showCuratedAddInput, setShowCuratedAddInput] = useState(false);
  const addModelInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const providerPanelRef = useRef<HTMLDivElement>(null);
  const [providerPanelStyle, setProviderPanelStyle] = useState<CSSProperties | null>(null);
  // The provider dropdown now lives inside the single scrolling field column
  // (see design doc §4.1/§4.2), so — like the model multi-select panel below
  // — it's portaled to <body> with fixed positioning: opening it can't grow
  // the modal or get clipped by the column's overflow-y-auto.
  const computeProviderPanel = useCallback(() => {
    const el = dropdownRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 4, margin = 12;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;
    const openUp = spaceBelow < 280 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(180, Math.floor(openUp ? spaceAbove : spaceBelow));
    setProviderPanelStyle({
      position: 'fixed', left: r.left, width: r.width, maxHeight, zIndex: 10000,
      ...(openUp ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }),
    });
  }, []);
  const toggleProviderDropdown = useCallback(() => {
    computeProviderPanel();
    setDropdownOpen((o) => !o);
  }, [computeProviderPanel]);
  // Built-in cloud providers pick models from a multi-select dropdown. The panel
  // is portaled to <body> with fixed positioning so opening it neither grows nor
  // re-centers the modal (in-flow made the modal "jump"), and isn't clipped by
  // the modal's overflow-y-auto content area.
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelPanelRef = useRef<HTMLDivElement>(null);
  const [modelPanelStyle, setModelPanelStyle] = useState<CSSProperties | null>(null);
  // Position the fixed panel under the trigger. Unlike the provider dropdown
  // above, the model panel ALWAYS opens downward (never flips up): the model
  // field is the last field in the modal, and a flip-up panel covered the
  // whole modal, which looked wrong. Instead we cap the height to the space
  // below the trigger and let the panel scroll internally, so it drops down
  // over the footer / toward the viewport bottom without overflowing off-screen.
  const computeModelPanel = useCallback(() => {
    const el = modelDropdownRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 4, margin = 12;
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const maxHeight = Math.max(120, Math.floor(spaceBelow));
    setModelPanelStyle({
      position: 'fixed', left: r.left, width: r.width, maxHeight, zIndex: 10000,
      top: r.bottom + gap,
    });
  }, []);
  const toggleModelDropdown = useCallback(() => {
    computeModelPanel();
    setModelDropdownOpen((o) => !o);
  }, [computeModelPanel]);

  // ── Ollama-specific state ──
  const [ollamaStatus, setOllamaStatus] = useState<OllamaConnectionStatus>('idle');
  const [ollamaError, setOllamaError] = useState<string>('');
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);

  // ── Fetch-models state (cloud providers) ──
  const [fetchModelsStatus, setFetchModelsStatus] = useState<FetchModelsStatus>('idle');
  const [fetchedModels, setFetchedModels] = useState<ModelInfo[]>([]);
  const [fetchModelsError, setFetchModelsError] = useState('');
  // Scoped search over the fetched-models checklist below — distinct from
  // `searchQuery` above, which filters the provider-type dropdown.
  const [modelListFilter, setModelListFilter] = useState('');

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

  // ── Delete (edit mode only) ──
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // ── Derived ──
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

  // ── Multi-endpoint config plans (e.g. volcengine paygo/coding/agent) ──
  // Also covers custom's two format "plans" (openai/anthropic, design doc
  // §7b) — PROVIDER_CONFIGS.custom carries them just like any multi-endpoint
  // builtin, so no isCustom gate is needed here.
  const providerPlans = useMemo(
    () => (selectedOption ? (PROVIDER_CONFIGS[selectedOption.provider].plans ?? null) : null),
    [selectedOption],
  );
  const activePlan = useMemo(
    () => providerPlans?.find(p => p.id === selectedPlanId) ?? null,
    [providerPlans, selectedPlanId],
  );
  const effectiveFormat: ApiFormat = activePlan?.format ?? selectedOption?.format ?? 'openai-compatible';
  // Built-in cloud providers ship a curated model list and a fixed endpoint, so
  // their API-address field is shown read-only (§4.3) and they skip the
  // fetch/add-model affordances (those are only for custom endpoints and local
  // providers that must discover models).
  const isBuiltinCloud = !!selectedOption && !isCustom && !isOllama && !isLMStudio;
  // OpenRouter / SiliconFlow are built-in providers (fixed endpoint, hidden URL)
  // but aggregate too many models to curate — the user supplies models like a
  // custom endpoint (fetch from /models + manual add), so they use the checklist
  // flow, not the curated multi-select dropdown.
  const usesFetchedModels = selectedOption?.provider === 'openrouter' || selectedOption?.provider === 'siliconflow';
  const isBuiltinCurated = isBuiltinCloud && !usesFetchedModels;
  const hasPlanRow = !!(providerPlans && providerPlans.length > 1);

  // Curated model list a built-in provider offers for the current selection:
  // the active plan's models when it has its own (e.g. volcengine coding vs
  // agent expose different models), otherwise the provider's top-level list.
  const builtinModelOptions = useMemo(
    () => (isBuiltinCurated && selectedOption
      ? (activePlan?.models ?? PROVIDER_CONFIGS[selectedOption.provider].models ?? [])
      : []),
    [isBuiltinCurated, selectedOption, activePlan],
  );
  // Curated options plus any ids the user typed via the dropdown's add-model
  // input that aren't curated — so they render as checked rows and show in the
  // trigger summary.
  const builtinModelList = useMemo(() => {
    const ids = new Set(builtinModelOptions.map((m) => m.id));
    const extra = [...selectedModels].filter((id) => !ids.has(id)).map((id) => ({ id, label: id }));
    return [...builtinModelOptions, ...extra];
  }, [builtinModelOptions, selectedModels]);

  // Non-applicable "config method" row placeholder (§4.3): the row is always
  // rendered, never hidden — only its content varies with the selection.
  // Custom always has 2 plans now (design doc §7b), so `hasPlanRow` is always
  // true for it and this placeholder never renders for isCustom — only local
  // providers (no plans) and single-plan builtins reach it.
  const configMethodPlaceholder = !selectedId
    ? t.settings.selectProviderFirst
    : (isOllama || isLMStudio)
      ? t.settings.configMethodLocalPlaceholder
      : t.settings.singleAccess;

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

      // Auto-fill base URL (and default config plan, if this provider ships
      // one). Custom itself now carries a `plans` array (openai/anthropic
      // format switch, design doc §7b) via PROVIDER_CONFIGS.custom, so this
      // path handles it the same way as a multi-endpoint builtin — no
      // isCustomId branch needed.
      const cfg = PROVIDER_CONFIGS[option.provider];
      if (cfg.plans && cfg.plans.length > 0) {
        // Multi-endpoint provider — default to the recommended (non-paygo)
        // plan: prefer Agent Plan, then Token Plan, then Coding Plan, then
        // whatever matches the top-level baseUrl, finally the first plan.
        // Paygo is never the default. (Custom's plans have neither
        // agent/tokenplan/coding ids nor a distinguishing baseUrl — both are
        // '' — so this falls through to `cfg.plans[0]`, i.e. the 'openai'
        // plan, which is exactly the desired default.)
        const def = cfg.plans.find(p => p.id === 'agent')
          ?? cfg.plans.find(p => p.id === 'tokenplan')
          ?? cfg.plans.find(p => p.id === 'coding')
          ?? cfg.plans.find(p => p.baseUrl === cfg.baseUrl)
          ?? cfg.plans[0];
        setSelectedPlanId(def.id);
        setBaseUrl(def.baseUrl);
        // No pre-selection: the user picks models from the multi-select
        // dropdown. (They must choose at least one before Save is enabled.)
        setSelectedModels(new Set());
      } else {
        setSelectedPlanId(null);
        setBaseUrl(cfg.baseUrl);
        setSelectedModels(new Set());
      }

      // Reset per-model declared capabilities. Models aren't pre-selected for an
      // existing builtin provider either (see setSelectedModels above), so there's
      // nothing to preload per-model here — only the endpoint-level useRawUrl flag
      // is worth restoring from the existing store entry.
      const existingP = providers.find(p => p.id === option.provider);
      setPerModelDeclared({});
      setExpandedModelIds(new Set());
      setModelDropdownOpen(false);
      setShowCuratedAddInput(false);
      setUseRawUrl(existingP?.declaredCapabilities?.useRawUrl ?? false);

      // Reset Ollama state
      setOllamaStatus('idle');
      setOllamaError('');
      setOllamaModels([]);

      // Reset fetch-models state
      setFetchModelsStatus('idle');
      setFetchedModels([]);
      setFetchModelsError('');
      setModelListFilter('');
      setApiKey('');
      setShowApiKey(false);
      // (fetch removed)
      // (fetch removed)
      setManualModelInput('');
      setShowAddModelInput(false);
    },
    [nameManuallyEdited, providers]
  );

  // Switching config plan (e.g. paygo → coding) swaps the whole endpoint
  // preset: baseUrl + format change together, and the key/models selected
  // under the old plan aren't valid under the new one, so downstream
  // selection/fetch state is cleared. Also used in edit mode — switching
  // plans while editing is allowed (design doc §4.5) and clears downstream
  // fields exactly like it does when adding.
  //
  // Custom is the one exception (design doc §7b, "已拍板:不清 key"): its two
  // "plans" are really just a format switch reusing this mechanism — both
  // plans share the same empty baseUrl (the user types their own), so there's
  // no real endpoint swap happening, and clearing the key/models the user
  // just typed/picked when they merely change format would be actively
  // hostile. Only `selectedPlanId` changes; `effectiveFormat` follows it.
  const handleSelectPlan = useCallback((planId: string) => {
    const plan = providerPlans?.find(p => p.id === planId);
    if (!plan) return;
    if (isCustom) {
      setSelectedPlanId(planId);
      return;
    }
    setSelectedPlanId(planId);
    setBaseUrl(plan.baseUrl);
    setApiKey('');
    // Switching plans swaps the model list (e.g. volcengine coding vs agent),
    // so clear the selection — the user re-picks from the dropdown.
    setSelectedModels(new Set());
    setPerModelDeclared({});
    setExpandedModelIds(new Set());
    setModelDropdownOpen(false);
    setShowCuratedAddInput(false);
    setFetchModelsStatus('idle');
    setFetchedModels([]);
    setFetchModelsError('');
    setModelListFilter('');
  }, [providerPlans, isCustom]);

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
      for (const id of toAdd) next[id] = defaultModelDeclaredCapabilities(id);
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

  // Close the provider dropdown when clicking outside it (trigger or portaled
  // panel) or pressing Escape. Capture phase: the modal backdrop
  // stopPropagation()s mousedown in the bubble phase, so a bubble-phase
  // document listener here never fires (the 91e0be5 fix this must not
  // regress). Also reposition on scroll/resize so the fixed panel can't
  // detach from its trigger while the field column scrolls.
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = dropdownRef.current?.contains(target);
      const inPanel = providerPanelRef.current?.contains(target);
      if (!inTrigger && !inPanel) setDropdownOpen(false);
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', computeProviderPanel);
    window.addEventListener('scroll', computeProviderPanel, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', computeProviderPanel);
      window.removeEventListener('scroll', computeProviderPanel, true);
    };
  }, [dropdownOpen, computeProviderPanel]);

  // Same capture-phase outside-click/Escape close for the built-in model
  // multi-select dropdown (see the provider dropdown effect above).
  useEffect(() => {
    if (!modelDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const t = e.target as Node;
      // The panel is portaled outside modelDropdownRef, so check it too.
      const inTrigger = modelDropdownRef.current?.contains(t);
      const inPanel = modelPanelRef.current?.contains(t);
      if (!inTrigger && !inPanel) { setModelDropdownOpen(false); setShowCuratedAddInput(false); }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setModelDropdownOpen(false); setShowCuratedAddInput(false); }
    };
    // Reposition if the layout shifts while open (window resize, or the modal's
    // content area scrolling), so the fixed panel can't detach.
    document.addEventListener('mousedown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', computeModelPanel);
    window.addEventListener('scroll', computeModelPanel, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', computeModelPanel);
      window.removeEventListener('scroll', computeModelPanel, true);
    };
  }, [modelDropdownOpen, computeModelPanel]);

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
        <p className="text-caption text-[var(--abu-text-tertiary)]">{t.settings.capPerModelHint}</p>
        <AdvancedCapabilitiesFields
          declared={perModelDeclared[modelId] ?? {}}
          setDeclared={(u) => updateModelDeclared(modelId, u)}
          // Must track the active plan's format, not the option's nominal
          // one: custom's single entry can be switched to the Anthropic plan
          // (design doc §7b), and `selectedOption.format` never changes for
          // it — only `effectiveFormat` (which follows `activePlan`) does.
          apiFormat={effectiveFormat}
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
    setModelListFilter('');

    const result = await fetchProviderModels(
      baseUrl,
      apiKey,
      effectiveFormat,
    );

    if (result.success && result.models.length > 0) {
      // Known-first ordering + convergence: for a large (aggregator-style)
      // result, pre-check only ids the local capability table recognizes,
      // union'd with whatever was already selected (e.g. a plan's curated
      // preset, or — in edit mode — the provider's existing models) so
      // Fetch never silently wipes it. Small direct-provider results still
      // pre-check everything (see fetchModelUtils.ts).
      const sorted = sortKnownFirst(result.models, isKnownModel);
      setFetchedModels(sorted);
      setSelectedModels((prev) => computeFetchPreselection(sorted, isKnownModel, prev));
      if (showAdvanced) {
        seedDeclaredDefaults(sorted.map((m) => m.id));
      }
      setFetchModelsStatus('success');
    } else if (result.success) {
      setFetchModelsStatus('error');
      setFetchModelsError(t.settings.fetchModelsEmpty);
    } else {
      setFetchModelsStatus('error');
      setFetchModelsError(result.error ?? t.settings.fetchModelsFailed);
    }
  }, [baseUrl, apiKey, effectiveFormat, t, showAdvanced, seedDeclaredDefaults]);

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

      // Auto-select fetched models — Ollama catalogs are local pulls, always
      // well under SMALL_LIST_MAX, so this stays "select everything" in
      // practice; still union'd with whatever was already selected (e.g. a
      // manually-added id, or the provider's existing models in edit mode)
      // so re-checking Ollama can't silently drop it.
      setSelectedModels((prev) => computeFetchPreselection(modelInfos, isKnownModel, prev));
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
        apiFormat: effectiveFormat,
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
  }, [baseUrl, apiKey, selectedModels, effectiveFormat, t]);

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
      ? effectiveFormat
      : 'openai-compatible';

    const resolvedBaseUrl = baseUrl || (selectedOption && !isCustom
      ? (activePlan?.baseUrl ?? PROVIDER_CONFIGS[selectedOption.provider].baseUrl)
      : '');
    // When a plan is active, use ONLY the plan's own capabilities (no fallback
    // to the provider-family top-level capabilities) — anthropic-format plans
    // deliberately have no builtin webSearch, and falling back would both show
    // a misleading web-search badge and store the wrong capabilities for the
    // runtime to act on (see getBuiltinSearchConfig in core/capabilities.ts).
    const capabilities = selectedOption && !isCustom
      ? (activePlan ? activePlan.capabilities : PROVIDER_CONFIGS[selectedOption.provider].capabilities)
      : undefined;
    const declaredCapabilities = showAdvanced ? { useRawUrl } : undefined;

    // For builtin providers: update the existing entry instead of creating a duplicate
    const existingBuiltin = !isCustom && selectedOption
      ? providers.find(p => p.id === selectedOption.provider)
      : null;

    let providerId: string;
    if (editProvider) {
      // Edit mode always updates the exact instance being edited (builtin or
      // custom) — the provider identity is locked, so there's no ambiguity
      // like the "already added builtin" case below. Mirrors the retired
      // ProviderCard inline-edit `handleSave` exactly:
      //  - never forces `enabled: true` (must not silently re-enable a
      //    provider the user deliberately disabled — `enabled` is simply
      //    omitted from the patch so the existing value is left untouched);
      //  - only touches provider-level `declaredCapabilities` when
      //    `showAdvanced` is shown, and even then preserves the existing
      //    object (`{ ...editProvider.declaredCapabilities, useRawUrl }`)
      //    instead of replacing it, so fields outside this modal's advanced
      //    section (thinkingFormat, maxTokensField, requiresToolResultName,
      //    max*Tokens, legacy supports* flags, …) survive a save.
      const editPatch: Partial<ProviderInstance> = {
        name: serviceName.trim(),
        apiKey,
        baseUrl: resolvedBaseUrl,
        apiFormat: effectiveFormat,
        models: modelInfos,
        capabilities,
        userAdded: true,
      };
      if (showAdvanced) {
        editPatch.declaredCapabilities = { ...editProvider.declaredCapabilities, useRawUrl };
      }
      updateProvider(editProvider.id, editPatch);
      providerId = editProvider.id;
    } else if (existingBuiltin) {
      // Adding a builtin preset "enables" a pre-seeded catalog entry whose
      // sortOrder is its original catalog index. Bump it to the front so a
      // just-added builtin shows newest-first, mirroring custom addProvider
      // (which assigns the highest sortOrder). Without this, builtin presets
      // (volcengine/bailian/...) stay stuck at their catalog position.
      updateProvider(existingBuiltin.id, {
        name: serviceName.trim(),
        enabled: true,
        apiKey,
        baseUrl: resolvedBaseUrl,
        apiFormat: effectiveFormat,
        models: modelInfos,
        capabilities,
        userAdded: true,
        declaredCapabilities,
        sortOrder: Math.max(0, ...providers.map(p => p.sortOrder)) + 1,
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

    // Auto-select first model if this is the first enabled provider — add
    // mode only. The retired ProviderCard inline-edit `handleSave` never
    // called `selectModel`; editing an existing provider must not disturb
    // whatever model the user currently has active.
    if (!editProvider) {
      const hasOtherEnabled = providers.some(p => p.enabled && p.id !== providerId);
      if (!hasOtherEnabled && modelInfos.length > 0) {
        selectModel(providerId, modelInfos[0].id);
      }
    }

    onClose();
  }, [
    serviceName, selectedModels, ollamaModels, selectedOption,
    isCustom, showAdvanced, perModelDeclared, useRawUrl, baseUrl, apiKey, providers,
    effectiveFormat, activePlan, editProvider,
    addProvider, updateProvider, selectModel, onClose,
  ]);

  // ── Delete (edit mode only) — mirrors ProviderCard's retired
  // handleDeleteConfirm exactly: custom providers are removed outright,
  // builtin providers are disabled + cleared (they can't leave the array,
  // they're reseeded by createDefaultProviders) so they simply drop out of
  // the visible list. ──
  const handleDeleteProvider = useCallback(() => {
    if (!editProvider) return;
    const wasActive = activeModel.providerId === editProvider.id;

    if (editProvider.source === 'custom') {
      removeProvider(editProvider.id);
    } else {
      updateProvider(editProvider.id, { enabled: false, apiKey: '', status: 'unchecked', userAdded: false });
    }

    if (wasActive) {
      const state = useSettingsStore.getState();
      const next = state.providers.find(p => p.enabled && p.id !== editProvider.id);
      if (next && next.models.length > 0) {
        selectModel(next.id, next.models[0].id);
      }
    }

    setShowDeleteConfirm(false);
    onClose();
  }, [editProvider, activeModel, removeProvider, updateProvider, selectModel, onClose]);

  // ── Reset / prefill on open ──
  // All state resets to blank whenever the modal opens fresh (add mode), or
  // prefills from the target instance when opening in edit mode. Keyed on
  // `editProvider?.id` rather than the object reference so a background store
  // update to the same provider (e.g. a health-check status change) while the
  // modal is already open doesn't clobber in-progress edits.
  const resetFormState = useCallback(() => {
    setSelectedId('');
    setServiceName('');
    setNameManuallyEdited(false);
    setApiKey('');
    setShowApiKey(false);
    setBaseUrl('');
    setSelectedPlanId(null);
    setSelectedModels(new Set());
    setManualModelInput('');
    setShowAddModelInput(false);
    setShowCuratedAddInput(false);
    setSearchQuery('');
    setDropdownOpen(false);
    setModelDropdownOpen(false);
    setOllamaStatus('idle');
    setOllamaError('');
    setOllamaModels([]);
    setFetchModelsStatus('idle');
    setFetchedModels([]);
    setFetchModelsError('');
    setModelListFilter('');
    setPerModelDeclared({});
    setExpandedModelIds(new Set());
    setUseRawUrl(false);
    setValidating(false);
    setValidateResult(null);
    setShowDeleteConfirm(false);
  }, []);

  const prefillFromEditProvider = useCallback((p: ProviderInstance) => {
    const optionId = p.source === 'builtin' ? p.id : CUSTOM_ID;
    setSelectedId(optionId);
    setServiceName(p.name);
    setNameManuallyEdited(true);
    setApiKey(p.apiKey);
    setShowApiKey(false);
    setBaseUrl(p.baseUrl);
    setSelectedModels(new Set(p.models.map(m => m.id)));
    setManualModelInput('');
    setShowAddModelInput(false);
    setShowCuratedAddInput(false);
    setSearchQuery('');
    setDropdownOpen(false);
    setModelDropdownOpen(false);

    // Config plan: find the plan (if any) whose baseUrl matches the
    // provider's current endpoint, so a multi-endpoint builtin (e.g.
    // volcengine) opens with the right tier pre-selected. Custom's two plans
    // (design doc §7b) share an empty baseUrl — nothing to match there — so
    // it's preselected by `apiFormat` instead.
    if (p.source === 'builtin') {
      const cfg = PROVIDER_CONFIGS[p.id as LLMProvider];
      const plan = cfg?.plans?.find(pl => pl.baseUrl === p.baseUrl);
      setSelectedPlanId(plan?.id ?? null);
    } else {
      setSelectedPlanId(p.apiFormat === 'anthropic' ? 'anthropic' : 'openai');
    }

    // Per-model declared capabilities, keyed by model id.
    const declaredMap: Record<string, ModelDeclaredCapabilities> = {};
    for (const m of p.models) {
      if (m.declaredCapabilities) declaredMap[m.id] = m.declaredCapabilities;
    }
    setPerModelDeclared(declaredMap);
    setExpandedModelIds(new Set());
    setUseRawUrl(p.declaredCapabilities?.useRawUrl ?? false);

    // Ollama's model checklist renders from `ollamaModels` (not the generic
    // `selectedModels`), so seed it directly from the provider's saved models —
    // the same "always show the saved list" behavior the retired ProviderCard
    // inline edit form had, rather than requiring a fresh connectivity check
    // before anything appears. A live "Refresh" still re-verifies and merges.
    const isOllamaEdit = p.id === 'ollama';
    setOllamaStatus(isOllamaEdit ? 'online' : 'idle');
    setOllamaError('');
    setOllamaModels(isOllamaEdit ? p.models : []);

    setFetchModelsStatus('idle');
    setFetchedModels([]);
    setFetchModelsError('');
    setModelListFilter('');
    setValidating(false);
    setValidateResult(null);
    setShowDeleteConfirm(false);
  }, []);

  // useLayoutEffect (not useEffect) so prefill/reset runs synchronously BEFORE
  // the first paint: in edit mode this means baseUrl — and the "Will request:
  // POST …" preview line that depends on it — are present on the first painted
  // frame, avoiding a one-time layout jump where the preview line pops in after
  // the effect ran post-paint.
  useLayoutEffect(() => {
    if (!isOpen) return;
    if (editProvider) {
      prefillFromEditProvider(editProvider);
    } else {
      resetFormState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editProvider?.id]);

  const handleClose = useCallback(() => {
    resetFormState();
    onClose();
  }, [resetFormState, onClose]);

  if (!isOpen) return null;

  // ── Render helpers ──

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
          <h2 className="text-h-md font-semibold text-[var(--abu-text-primary)]">
            {editProvider ? t.settings.editService : t.settings.addService}
          </h2>
          <Button variant="ghost" size="icon-sm" onClick={handleClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Single scrolling field column — every field lives here (design doc
            §4.1). Nothing is pinned above it except the header/footer chrome,
            which are structural (not fields). */}
        <div className="flex-1 overflow-y-auto px-6 pt-4 pb-5 space-y-2.5">
          {keyDecryptFailed && (
            <div className="flex items-start gap-2 rounded-md border border-[var(--abu-danger)] bg-[var(--abu-danger-bg)] px-3 py-2 text-caption text-[var(--abu-danger)]">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{t.settings.apiKeyDecryptFailed}</span>
            </div>
          )}

          {/* 1. Provider selector — above service name (design doc §4.1). Locked
              into a read-only chip in edit mode: the provider identity can't
              change (that would be a different service). */}
          <div className="space-y-1">
            <label className="text-minor font-medium text-[var(--abu-text-primary)]">
              {t.settings.selectProviderType}
            </label>
            {editProvider ? (
              <div className="w-full h-9 px-3 flex items-center bg-[var(--abu-bg-hover)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-secondary)]">
                {selectedOption?.label ?? editProvider.name}
              </div>
            ) : (
              <div className="relative" ref={dropdownRef}>
                <button
                  type="button"
                  onClick={toggleProviderDropdown}
                  className={cn(
                    'w-full h-9 px-3 flex items-center justify-between',
                    'bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] rounded-lg',
                    'text-body text-[var(--abu-text-primary)]',
                    'hover:border-[var(--abu-clay)] transition-colors',
                  )}
                >
                  <span className={selectedOption ? '' : 'text-[var(--abu-text-placeholder)]'}>
                    {selectedOption ? selectedOption.label : t.settings.selectProviderType}
                  </span>
                  <ChevronDown className={cn('h-4 w-4 text-[var(--abu-text-secondary)] transition-transform', dropdownOpen && 'rotate-180')} />
                </button>

                {dropdownOpen && providerPanelStyle && createPortal(
                  <div
                    ref={providerPanelRef}
                    style={providerPanelStyle}
                    className="flex flex-col rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-lg overflow-hidden"
                  >
                    {/* Search */}
                    <div className="shrink-0 p-2 border-b border-[var(--abu-border)]">
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-placeholder)]" />
                        <Input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder={t.settings.searchProvider}
                          className="pl-8 h-8 text-minor"
                          autoFocus
                        />
                      </div>
                    </div>

                    {/* Options */}
                    <div className="flex-1 min-h-0 overflow-y-auto py-1">
                      {filteredGroups.map((group) => (
                        <div key={group.key}>
                          <div className="px-3 py-1.5 text-minor font-medium text-[var(--abu-text-tertiary)] uppercase tracking-wider">
                            {group.label}
                          </div>
                          {group.options.map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => handleSelectProvider(option)}
                              className={cn(
                                'w-full px-3 py-2 flex items-center justify-between text-body',
                                'hover:bg-[var(--abu-bg-hover)] transition-colors',
                                selectedId === option.id && 'bg-[var(--abu-bg-hover)]',
                              )}
                            >
                              <span className="text-[var(--abu-text-primary)]">{option.label}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  </div>,
                  document.body
                )}
              </div>
            )}
          </div>

          {/* 2. Service Name */}
          <div className="space-y-1">
            <label className="text-minor font-medium text-[var(--abu-text-primary)]">
              {t.settings.serviceName}
            </label>
            <Input
              value={serviceName}
              onChange={handleNameChange}
              placeholder={t.settings.serviceNameAuto}
              className="h-8"
            />
          </div>

          {/* 3. Config Plan — always rendered (design doc §4.3): multi-plan
              builtins get the dropdown as before; everything else (single-plan
              builtin, custom, local) shows a greyed read-only placeholder so
              the row never disappears. */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-minor font-medium text-[var(--abu-text-primary)]">
                {t.settings.configPlan}
              </label>
              {hasPlanRow && guide && (
                <button
                  type="button"
                  onClick={() => open(guide.url)}
                  className="inline-flex items-center gap-1 text-minor text-[var(--abu-clay)] hover:underline"
                >
                  {t.settings.viewDocs}
                  <ExternalLink className="h-3 w-3" />
                </button>
              )}
            </div>
            {hasPlanRow ? (
              <Select
                value={selectedPlanId ?? ''}
                options={[...providerPlans!]
                  .sort((a, b) => (PLAN_ORDER[a.id] ?? 99) - (PLAN_ORDER[b.id] ?? 99))
                  .map(p => ({
                    value: p.id,
                    label: p.label ?? (
                      p.id === 'paygo' ? t.settings.billingPaygo
                      : p.id === 'coding' ? t.settings.billingCoding
                      : p.id === 'tokenplan' ? t.settings.billingTokenPlan
                      // Custom's two format "plans" (design doc §7b) — reuse
                      // the existing entry-label i18n keys as the dropdown's
                      // option labels.
                      : p.id === 'openai' ? t.settings.customApiOpenai
                      : p.id === 'anthropic' ? t.settings.customApiAnthropic
                      : t.settings.billingAgent),
                  }))}
                onChange={handleSelectPlan}
              />
            ) : (
              <div className="h-9 px-3 flex items-center bg-[var(--abu-bg-hover)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-tertiary)]">
                {configMethodPlaceholder}
              </div>
            )}
          </div>

          {/* 4. API Key — read-only "no key needed" for keyless local providers,
              disabled placeholder before a provider is picked. */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <label className="text-minor font-medium text-[var(--abu-text-primary)]">
                  {t.settings.apiKey}
                </label>
                {selectedId && !isOllama && !isLMStudio && (
                  <span className="text-minor text-[var(--abu-text-tertiary)]">
                    {isCustom ? t.settings.apiKeyOptional : t.settings.apiKeyRequired}
                  </span>
                )}
              </div>
              {selectedId && !hasPlanRow && guide && (
                <button
                  type="button"
                  onClick={() => open(guide.url)}
                  className="inline-flex items-center gap-1 text-minor text-[var(--abu-clay)] hover:underline"
                >
                  {t.settings.viewDocs}
                  <ExternalLink className="h-3 w-3" />
                </button>
              )}
            </div>
            {isOllama || isLMStudio ? (
              <div className="h-8 px-3 flex items-center bg-[var(--abu-bg-hover)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-tertiary)]">
                {t.settings.localNoKeyNeeded}
              </div>
            ) : (
              <div className="relative">
                <Input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                  disabled={!selectedId}
                  className="pr-9 h-8"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  disabled={!selectedId}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-secondary)] disabled:opacity-50 disabled:pointer-events-none"
                >
                  {showApiKey
                    ? <EyeOff className="h-4 w-4" />
                    : <Eye className="h-4 w-4" />}
                </button>
              </div>
            )}
          </div>

          {/* 5. API Address — read-only fixed endpoint for built-in cloud
              providers (shown, not hidden, per design doc §4.3), editable for
              custom/local, disabled placeholder before a provider is picked. */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-minor font-medium text-[var(--abu-text-primary)]">
                {isOllama ? t.settings.ollamaUrlLabel : isLMStudio ? t.settings.lmstudioUrlLabel : t.settings.apiUrl}
              </label>
              {showAdvanced && effectiveFormat !== 'anthropic' && (
                <div className="flex items-center gap-2" title={t.settings.capRawUrlHint}>
                  <span className="text-minor text-[var(--abu-text-secondary)]">{t.settings.capRawUrl}</span>
                  <Toggle checked={useRawUrl} onChange={() => setUseRawUrl(v => !v)} size="sm" />
                </div>
              )}
            </div>
            {isBuiltinCloud ? (
              <p className="text-minor text-[var(--abu-text-secondary)] font-mono bg-[var(--abu-bg-hover)] rounded-lg px-3 py-2 break-all select-all">
                {baseUrl}
              </p>
            ) : (
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={isOllama ? 'http://127.0.0.1:11434' : isLMStudio ? 'http://127.0.0.1:1234/v1' : 'https://...'}
                onBlur={isOllama ? handleCheckOllama : isLMStudio ? handleFetchModels : undefined}
                disabled={!selectedId}
                className="h-8"
              />
            )}
            {(isOllama || isLMStudio) && (
              <p className="text-minor text-[var(--abu-text-tertiary)]">
                {isOllama ? t.settings.ollamaUrlHint : t.settings.lmstudioUrlHint}
              </p>
            )}

            {/* Final request URL preview — hidden for local providers which have their own status UI */}
            {!isOllama && !isLMStudio && baseUrl.trim() && selectedOption && (
              <p className="text-caption font-mono text-[var(--abu-text-muted)] break-all">
                ↳ {t.settings.apiUrlPreview}: POST {buildFullChatUrl(baseUrl, effectiveFormat, { useRawUrl })}
              </p>
            )}

            {/* Ollama connection status */}
            {isOllama && ollamaStatus !== 'idle' && ollamaStatus !== 'checking' && (
              <div className="mt-1 space-y-0.5">
                <div className={cn(
                  'flex items-center gap-1.5 text-minor',
                  ollamaStatus === 'online' ? 'text-[var(--abu-success)]' : 'text-[var(--abu-danger)]',
                )}>
                  {ollamaStatus === 'online'
                    ? <><CircleCheck className="h-3.5 w-3.5" /> {t.settings.ollamaOnline}</>
                    : <><CircleX className="h-3.5 w-3.5" /> {t.settings.ollamaOffline}</>}
                </div>
                {ollamaStatus === 'offline' && ollamaError && (
                  <p className="text-caption font-mono text-[var(--abu-danger)] break-all pl-5">{ollamaError}</p>
                )}
              </div>
            )}

            {/* LM Studio connection status */}
            {isLMStudio && fetchModelsStatus !== 'idle' && fetchModelsStatus !== 'fetching' && (
              <div className={cn(
                'flex items-center gap-1.5 text-minor mt-1',
                fetchModelsStatus === 'success' ? 'text-[var(--abu-success)]' : 'text-[var(--abu-danger)]',
              )}>
                {fetchModelsStatus === 'success'
                  ? <><CircleCheck className="h-3.5 w-3.5" /> {t.settings.lmstudioOnline}</>
                  : <><CircleX className="h-3.5 w-3.5" /> {t.settings.lmstudioOffline}</>}
              </div>
            )}
          </div>

          {/* 6. Model Selection — row always present; content is a disabled
              placeholder before a provider is picked. */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-minor font-medium text-[var(--abu-text-primary)]">
                {t.settings.models}
              </label>
              <div className="flex items-center gap-3">
                {/* Fetch/refresh models button — custom, LM Studio, and the
                    aggregator built-ins (OpenRouter/SiliconFlow) that ship no
                    curated list; curated built-ins don't need it. */}
                {(isCustom || isLMStudio || usesFetchedModels) && effectiveFormat !== 'anthropic' && baseUrl.trim() && (
                  <button
                    type="button"
                    onClick={handleFetchModels}
                    disabled={fetchModelsStatus === 'fetching' || !baseUrl.trim()}
                    className="flex items-center gap-1 text-minor text-[var(--abu-clay)] hover:underline disabled:opacity-40 disabled:no-underline"
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
                    className="flex items-center gap-1 text-minor text-[var(--abu-clay)] hover:underline disabled:opacity-40 disabled:no-underline"
                  >
                    {ollamaStatus === 'checking'
                      ? <Loader2 className="h-3 w-3 animate-spin" />
                      : <RefreshCw className="h-3 w-3" />}
                    {ollamaStatus === 'checking' ? t.settings.fetchingModels : t.settings.fetchModels}
                  </button>
                )}
                {(isCustom || isLMStudio || usesFetchedModels) && (
                  <button
                    type="button"
                    onClick={toggleAddModelInput}
                    className="flex items-center gap-1 text-minor text-[var(--abu-clay)] hover:underline"
                  >
                    <Plus className="h-3 w-3" />
                    {t.settings.addModel}
                  </button>
                )}
              </div>
            </div>

            {!selectedId ? (
              <div className="h-9 px-3 flex items-center bg-[var(--abu-bg-hover)] border border-[var(--abu-border)] rounded-lg text-body text-[var(--abu-text-placeholder)]">
                {t.settings.selectProviderFirst}
              </div>
            ) : (
              <>
                {/* Fetch status messages */}
                {fetchModelsStatus === 'success' && (
                  <p className="text-minor text-[var(--abu-success)]">
                    {t.settings.fetchModelsSuccess.replace('{count}', String(fetchedModels.length))}
                  </p>
                )}
                {fetchModelsStatus === 'error' && (
                  <p className="text-minor text-[var(--abu-danger)]">
                    {fetchModelsError || t.settings.fetchModelsError}
                  </p>
                )}

                {/* Curated built-in providers — multi-select dropdown over the
                    curated model list, plus an add-model input for ids not listed.
                    Nothing is pre-selected; the user checks what to add. */}
                {isBuiltinCurated && (
                  <div className="relative" ref={modelDropdownRef}>
                    <button
                      type="button"
                      onClick={toggleModelDropdown}
                      className={cn(
                        'w-full min-h-9 px-3 py-1.5 flex items-center justify-between gap-2',
                        'bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] rounded-lg',
                        'text-body text-[var(--abu-text-primary)]',
                        'hover:border-[var(--abu-clay)] transition-colors',
                      )}
                    >
                      <span className={cn('text-left truncate', selectedModels.size === 0 && 'text-[var(--abu-text-placeholder)]')}>
                        {selectedModels.size === 0
                          ? t.settings.selectModel
                          : builtinModelList.filter((m) => selectedModels.has(m.id)).map((m) => m.label).join('、')}
                      </span>
                      <ChevronDown className={cn('h-4 w-4 text-[var(--abu-text-secondary)] shrink-0 transition-transform', modelDropdownOpen && 'rotate-180')} />
                    </button>

                    {modelDropdownOpen && modelPanelStyle && createPortal(
                      <div
                        ref={modelPanelRef}
                        style={modelPanelStyle}
                        className="flex flex-col rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-lg overflow-hidden"
                      >
                        <div className="flex-1 min-h-0 overflow-y-auto py-1">
                          {builtinModelList.map((model) => {
                            const checked = selectedModels.has(model.id);
                            return (
                              <button
                                key={model.id}
                                type="button"
                                onClick={() => handleToggleModel(model.id)}
                                className="w-full px-3 py-2 flex items-center gap-2.5 text-body hover:bg-[var(--abu-bg-hover)] transition-colors"
                              >
                                <span className={cn('flex-1 text-left truncate', checked ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-primary)]')}>{model.label}</span>
                                {checked && <Check className="h-4 w-4 text-[var(--abu-clay)] shrink-0" />}
                              </button>
                            );
                          })}
                        </div>
                        {/* Add a model id the curated list doesn't have — a
                            "使用其他模型" menu row by default that reveals the
                            model-id input on click, collapsing back after add. */}
                        <div className="shrink-0 border-t border-[var(--abu-border)]">
                          {showCuratedAddInput ? (
                            <div className="flex items-center gap-1.5 p-2">
                              <Input
                                ref={addModelInputRef}
                                value={manualModelInput}
                                onChange={(e) => setManualModelInput(e.target.value)}
                                placeholder={t.settings.addModelPlaceholder}
                                className="h-7 px-2 text-minor flex-1"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    if (manualModelInput.trim()) { handleAddManualModel(); setShowCuratedAddInput(false); }
                                  }
                                }}
                              />
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="outline"
                                onClick={() => { handleAddManualModel(); setShowCuratedAddInput(false); }}
                                disabled={!manualModelInput.trim()}
                              >
                                <Plus className="h-3 w-3" />
                              </Button>
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => { setManualModelInput(''); setShowCuratedAddInput(false); }}
                              >
                                <X className="h-3 w-3" />
                              </Button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setShowCuratedAddInput(true)}
                              className="w-full px-3 py-2 flex flex-col items-start gap-0.5 text-left hover:bg-[var(--abu-bg-hover)] transition-colors"
                            >
                              <span className="flex items-center gap-1.5 text-body text-[var(--abu-text-primary)]">
                                <Plus className="h-3.5 w-3.5 shrink-0" />
                                {t.settings.useOtherModel}
                              </span>
                              <span className="text-caption text-[var(--abu-text-tertiary)] pl-5">
                                {t.settings.useOtherModelDesc}
                              </span>
                            </button>
                          )}
                        </div>
                      </div>,
                      document.body
                    )}
                  </div>
                )}

                {/* Non-Ollama models — fetched checklist (checkbox select/deselect) merged
                    with manually-added ids (remove via X); one card per model. */}
                {!isOllama && !isBuiltinCurated && (() => {
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

                  // Only surface the scoped search once the checklist is large enough
                  // that scrolling through it to find one model is actually annoying
                  // (aggregator/gateway fetches) — a handful of models doesn't need it.
                  const showModelListFilter = displayList.length > SMALL_LIST_MAX;
                  const filteredList = showModelListFilter && modelListFilter.trim()
                    ? displayList.filter((m) => m.id.toLowerCase().includes(modelListFilter.trim().toLowerCase()))
                    : displayList;

                  return (
                    <div className="space-y-2">
                      {showModelListFilter && (
                        <div className="relative">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-placeholder)]" />
                          <Input
                            value={modelListFilter}
                            onChange={(e) => setModelListFilter(e.target.value)}
                            placeholder={t.settings.filterModelsPlaceholder}
                            className="pl-8 h-7 text-minor"
                          />
                        </div>
                      )}
                      <div className="max-h-48 overflow-y-auto space-y-2">
                      {/* Inline add-model input, revealed at the top of the model list */}
                      {showAddModelInput && (
                        <div className="flex items-center gap-1.5">
                          <Input
                            ref={addModelInputRef}
                            value={manualModelInput}
                            onChange={(e) => setManualModelInput(e.target.value)}
                            placeholder={t.settings.addModelPlaceholder}
                            className="h-7 px-2 text-minor flex-1"
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

                      {showModelListFilter && filteredList.length === 0 && (
                        <p className="text-minor text-[var(--abu-text-tertiary)] px-1 py-2">
                          {t.settings.filterModelsNoResults}
                        </p>
                      )}
                      {filteredList.map((model) => {
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
                              <span className="text-body text-[var(--abu-text-primary)] flex-1 truncate">{model.label}</span>
                              {!hasFetched && (
                                <button
                                  type="button"
                                  onClick={() => handleToggleModel(model.id)}
                                  className="text-[var(--abu-text-muted)] hover:text-[var(--abu-danger)] shrink-0"
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
                            <span className="text-body text-[var(--abu-text-primary)] flex-1">{model.label}</span>
                          </label>
                          {renderModelCapsPanel(model.id, isSelected)}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Ollama — no models detected */}
                {isOllama && ollamaStatus === 'online' && ollamaModels.length === 0 && (
                  <div className="text-body text-[var(--abu-text-tertiary)] px-1">
                    <p>{t.settings.ollamaNoModels}</p>
                    <p className="text-minor mt-1">{t.settings.ollamaNoModelsHint}</p>
                  </div>
                )}
              </>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-4 border-t border-[var(--abu-border)] flex items-center justify-between gap-3">
          {/* Left: delete (edit mode only) + validate connection + inline result */}
          <div className="flex items-center gap-3 min-w-0">
            {editProvider && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="shrink-0 flex items-center gap-1 text-minor text-[var(--abu-danger)] hover:text-[var(--abu-danger)] hover:underline"
              >
                <Trash2 className="h-3 w-3" />
                {t.settings.deleteService}
              </button>
            )}
            <div className="flex items-center gap-2 min-w-0">
              {selectedId && !isOllama && !isLMStudio && (
                <button
                  type="button"
                  onClick={handleValidate}
                  disabled={validating || !apiKey.trim() || !baseUrl.trim() || selectedModels.size === 0}
                  className="shrink-0 text-minor text-[var(--abu-clay)] hover:underline disabled:opacity-40 disabled:no-underline flex items-center gap-1"
                >
                  {validating && <Loader2 className="h-3 w-3 animate-spin" />}
                  {validating ? t.settings.validating : t.settings.validateConnection}
                </button>
              )}
              {validateResult && (
                <div className="flex items-center gap-1 min-w-0">
                  {validateResult.success
                    ? <CircleCheck className="h-3.5 w-3.5 text-[var(--abu-success)] shrink-0" />
                    : <CircleX className="h-3.5 w-3.5 text-[var(--abu-danger)] shrink-0" />}
                  <span className={cn('text-minor truncate max-w-[280px]', validateResult.success ? 'text-[var(--abu-success)]' : 'text-[var(--abu-danger)]')}>
                    {validateResult.message}
                  </span>
                </div>
              )}
            </div>
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

      {/* Delete confirmation dialog (edit mode only) */}
      {editProvider && (
        <ConfirmDialog
          open={showDeleteConfirm}
          title={t.settings.deleteProvider}
          message={t.settings.deleteProviderConfirm}
          confirmText={t.common.confirm}
          cancelText={t.common.cancel}
          variant="danger"
          onConfirm={handleDeleteProvider}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>,
    document.body
  );
}
