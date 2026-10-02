import { memo, useState, useCallback, useEffect, useId, useLayoutEffect, useRef, useMemo, type ReactNode, type SetStateAction } from 'react';
import { open } from '@tauri-apps/plugin-shell';
import { useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { cn } from '@/lib/utils';
import { Button, IconButton } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { useConfirm } from '@/components/ds/confirm-context';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Popover } from '@/components/ds/popover';
import { Pressable } from '@/components/ds/pressable';
import { Select } from '@/components/ds/select';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { TextField } from '@/components/ds/text-field';
import SecretField from '@/components/settings/SecretField';
import { checkProviderHealth } from '@/core/llm/healthCheck';
import { buildFullChatUrl } from '@/core/llm/urlUtils';
import { isKnownModel } from '@/core/llm/modelCapabilities';
import { useSettingsStore, PROVIDER_CONFIGS } from '@/stores/settingsStore';
import { PROVIDER_GUIDES } from './providerGuides';
import { computeShowAdvanced, defaultModelDeclaredCapabilities } from './providerCapabilities';
import { toModelInfo } from './modelInfoUtil';
import { sortKnownFirst, unionSelectAll, filterModels, MODEL_FILTER_MIN_ITEMS } from './fetchModelUtils';
import AdvancedCapabilitiesFields from './AdvancedCapabilitiesFields';
import type { LLMProvider, ApiFormat } from '@/types';
import type { ModelInfo, ProviderSource, ModelDeclaredCapabilities, ProviderInstance } from '@/types/provider';
import {
  checkOllamaHealth,
  fetchOllamaModels,
  formatOllamaModelLabel,
} from '@/core/llm/ollama';
import { fetchProviderModels, type FetchModelsResult } from '@/core/llm/modelFetcher';
import { SECRET_KEYS } from '@/utils/secretStore';

/**
 * Turn a failed fetch into something the user can act on.
 *
 * These used to collapse into one line claiming the provider "doesn't support
 * model listing", which is only true for 404. A 403 means the endpoint is
 * there and this key just isn't allowed to list — telling that user to give
 * up and type ids by hand hides the fact that another config method (or
 * another key) would work. The status is appended so a screenshot is enough
 * to diagnose a report.
 */
function describeFetchFailure(result: FetchModelsResult, t: TranslationDict): string {
  const suffix = result.status ? `（HTTP ${result.status}）` : '';
  switch (result.errorCode) {
    case 'unsupported': return t.settings.fetchModelsUnsupported + suffix;
    case 'forbidden': return t.settings.fetchModelsForbidden + suffix;
    case 'unauthorized': return t.settings.fetchModelsUnauthorized + suffix;
    default: return result.error ?? t.settings.fetchModelsFailed;
  }
}

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

const FIELD_LABEL = 'text-ui-sm font-medium text-label';
// Looks like the closed design-system select; opens a panel instead of a list.
const PANEL_TRIGGER = 'flex h-7 w-full items-center justify-between gap-2 rounded-control border border-control-border bg-field px-2 text-ui text-label';
// A row that states a fact where another provider would have a field.
const FIXED_VALUE = 'flex h-7 items-center rounded-control bg-fill px-2 text-ui text-label-tertiary';
const TEXT_LINK = 'inline-flex items-center gap-1 rounded-control text-ui-sm text-link hover:underline';

// ── Model rows ───────────────────────────────────────────────────
// Both are memo with primitive props and stable callbacks: a fetched catalog can hold hundreds
// of models, and a keystroke in the search box must not render the rows that stay.

/** One model in the panel of a built-in provider. */
const PanelModelRow = memo(function PanelModelRow({ id, label, checked, onToggle }: {
  id: string;
  label: string;
  checked: boolean;
  onToggle: (id: string) => void;
}) {
  const boxId = useId();
  return (
    <div className="flex h-7 items-center gap-2 rounded-control px-2 hover:bg-fill-hover">
      <Checkbox id={boxId} checked={checked} onCheckedChange={() => onToggle(id)} />
      <label htmlFor={boxId} className="min-w-0 flex-1 truncate text-ui text-label">{label}</label>
    </div>
  );
});

/** One model in the list inside the window. `choice` is a fetched model the user ticks;
 *  `added` is a model the user typed, removed with its own button; `detected` is a model a
 *  local server reported, which the window selects by itself. */
const ModelRow = memo(function ModelRow({ id, label, kind, selected, expandable, expanded, expandLabel, removeLabel, onToggle, onToggleExpand, children }: {
  id: string;
  label: string;
  kind: 'choice' | 'added' | 'detected';
  selected: boolean;
  expandable: boolean;
  expanded: boolean;
  expandLabel: string;
  removeLabel: string;
  onToggle: (id: string) => void;
  onToggleExpand: (id: string) => void;
  children?: ReactNode;
}) {
  const boxId = useId();
  return (
    <div className="rounded-control border border-separator p-2">
      <div className="flex items-center gap-2">
        {expandable && (
          <IconButton
            size="sm"
            icon={expanded ? AppIcons.collapse : AppIcons.expand}
            label={expandLabel}
            aria-expanded={expanded}
            onClick={() => onToggleExpand(id)}
          />
        )}
        <Checkbox id={boxId} checked={selected} disabled={kind !== 'choice'} onCheckedChange={() => onToggle(id)} />
        <label htmlFor={boxId} className="min-w-0 flex-1 truncate text-ui text-label">{label}</label>
        {kind === 'added' && (
          <IconButton size="sm" icon={AppIcons.close} label={removeLabel} onClick={() => onToggle(id)} />
        )}
      </div>
      {children}
    </div>
  );
});

// ── Component ────────────────────────────────────────────────────

export default function AddProviderModal({ open: isOpen, onClose, editProvider }: AddProviderModalProps) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const fieldId = useId();
  const providers = useSettingsStore((s) => s.providers);
  const addProvider = useSettingsStore((s) => s.addProvider);
  const updateProvider = useSettingsStore((s) => s.updateProvider);
  const removeProvider = useSettingsStore((s) => s.removeProvider);
  const selectModel = useSettingsStore((s) => s.selectModel);
  // The page clears `editProvider` in the same update that closes the window. While the window
  // fades out it keeps showing the provider it was opened for.
  const [heldProvider, setHeldProvider] = useState(editProvider);
  if (isOpen && heldProvider !== editProvider) setHeldProvider(editProvider);
  const shownProvider = isOpen ? editProvider : heldProvider;
  // True when bootstrapSecrets detected a prior ciphertext for the provider
  // being edited but couldn't decrypt it (typical cause: hardware/UUID
  // change). Mirrors the same check ProviderCard's retired inline edit form
  // used to make — must not be lost in the unification (see design doc §6).
  const keyDecryptFailed = useSettingsStore((s) =>
    !!shownProvider && s.failedSecretKeys.includes(SECRET_KEYS.provider(shownProvider.id)),
  );
  // Most recent secret write for the edited provider failed (broken OS
  // keychain) — key works via plaintext fallback but is not stored securely.
  const keySaveFailed = useSettingsStore((s) =>
    !!shownProvider && s.secretWriteFailedKeys.includes(SECRET_KEYS.provider(shownProvider.id)),
  );

  // ── Form state ──
  const [selectedId, setSelectedId] = useState<string>('');
  const [serviceName, setServiceName] = useState('');
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [apiKey, setApiKey] = useState('');
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
  // The provider panel and the model panel of a built-in provider are popovers: they float over
  // the window, so opening one neither grows the window nor is cut off by its scrolling column.
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

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
  const supportsModelListForSelection = (() => {
    if (!selectedOption) return true;
    if (activePlan?.supportsModelList !== undefined) return activePlan.supportsModelList;
    return PROVIDER_CONFIGS[selectedOption.provider]?.supportsModelList !== false;
  })();
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
  // Some endpoints simply have no /models route (Volcengine Ark's subscription
  // hosts answer 404 — its model listing lives on a separate AK/SK-signed
  // control-plane API). Offering a fetch button there is a guaranteed dead end,
  // so the config declares it and the button disappears. Declared per BILLING
  // TIER first: a vendor's tiers are separate hosts with separate credentials,
  // so one can serve the endpoint while another doesn't.
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
  // What the curated dropdown actually lists, in three tiers:
  //   1. the curated options (hand-maintained: real labels + vendor ordering),
  //   2. anything a live fetch returned that the curated list doesn't have —
  //      this is what keeps a shipped-static list from going stale between
  //      releases. Ordered after the curated rows but NOT visually marked:
  //      where a model id came from is our plumbing, not something the user
  //      picking a model has any use for,
  //   3. ids the user typed via "使用其他模型" that neither tier covers.
  const builtinModelList = useMemo<{ id: string; label: string }[]>(() => {
    const curatedIds = new Set(builtinModelOptions.map((m) => m.id));
    const fetchedExtra = fetchedModels
      .filter((m) => !curatedIds.has(m.id))
      .map((m) => ({ id: m.id, label: m.label }));
    const listed = new Set([...curatedIds, ...fetchedExtra.map((m) => m.id)]);
    const manualExtra = [...selectedModels]
      .filter((id) => !listed.has(id))
      .map((id) => ({ id, label: id }));
    return [...builtinModelOptions, ...fetchedExtra, ...manualExtra];
  }, [builtinModelOptions, fetchedModels, selectedModels]);

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

  // Read through a ref so the handler keeps one identity: every model row receives it.
  const selectedModelsRef = useRef(selectedModels);
  useLayoutEffect(() => { selectedModelsRef.current = selectedModels; });
  const handleToggleModel = useCallback((modelId: string) => {
    const isSelecting = !selectedModelsRef.current.has(modelId);
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
  }, [showAdvanced, seedDeclaredDefaults]);

  // Bulk selection over the fetched checklist. Both act on the list the user is
  // actually looking at (the search-filtered subset), so "select all" after
  // typing a query means "all matches", not "all 400 fetched models" — the
  // counter next to the buttons makes the resulting size visible either way.
  const handleSelectModels = useCallback((ids: string[]) => {
    setSelectedModels((prev) => new Set([...prev, ...ids]));
    if (showAdvanced) {
      seedDeclaredDefaults(ids);
    }
  }, [showAdvanced, seedDeclaredDefaults]);

  const handleDeselectModels = useCallback((ids: string[]) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

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

  // ── Shared row of the three model lists inside the window (fetched checklist / models the
  // user typed / models Ollama reported): the expand button and the abilities under it are
  // gated identically everywhere: showAdvanced && isSelected. ──
  const renderModelCapsPanel = (modelId: string) => {
    return (
      <div className="mt-2 space-y-2 border-l border-separator pl-3">
        <p className="text-caption text-label-tertiary">{t.settings.capPerModelHint}</p>
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

  const renderModelRow = (model: { id: string; label: string }, kind: 'choice' | 'added' | 'detected', isSelected: boolean) => {
    const expandable = showAdvanced && isSelected;
    const expanded = expandable && expandedModelIds.has(model.id);
    return (
      <ModelRow
        key={model.id}
        id={model.id}
        label={model.label}
        kind={kind}
        selected={isSelected}
        expandable={expandable}
        expanded={expanded}
        expandLabel={t.settings.advancedConfig}
        removeLabel={t.common.delete}
        onToggle={handleToggleModel}
        onToggleExpand={toggleModelExpand}
      >
        {expanded ? renderModelCapsPanel(model.id) : null}
      </ModelRow>
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
      // Fetch shows, the user picks: for a cloud endpoint the selection is
      // deliberately left untouched — nothing gets pre-checked, and nothing
      // already selected (a plan's curated preset, or the provider's saved
      // models in edit mode) gets dropped. Ordering is known-first so
      // recognizable ids sit at the top; the search box narrows the rest.
      // LM Studio is the exception, for the same reason as Ollama: it lists
      // the models already loaded on this machine, so check them all.
      const sorted = sortKnownFirst(result.models, isKnownModel);
      setFetchedModels(sorted);
      if (isLMStudio) {
        setSelectedModels((prev) => unionSelectAll(sorted, prev));
      }
      // A curated provider's models live behind a closed dropdown, so a fetch
      // would otherwise look like nothing happened. Open it on the result.
      if (isBuiltinCurated) {
        setModelDropdownOpen(true);
      }
      if (showAdvanced) {
        seedDeclaredDefaults(sorted.map((m) => m.id));
      }
      setFetchModelsStatus('success');
    } else if (result.success) {
      setFetchModelsStatus('error');
      setFetchModelsError(t.settings.fetchModelsEmpty);
    } else {
      setFetchModelsStatus('error');
      setFetchModelsError(describeFetchFailure(result, t));
    }
  }, [baseUrl, apiKey, effectiveFormat, isLMStudio, isBuiltinCurated, t, showAdvanced, seedDeclaredDefaults]);

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

      // Auto-select every detected model — unlike a cloud catalog, these are
      // models the user already deliberately pulled onto this machine, and
      // there are only ever a handful. Union'd with whatever was already
      // selected (e.g. a manually-added id, or the provider's existing models
      // in edit mode) so re-checking Ollama can't silently drop it.
      setSelectedModels((prev) => unionSelectAll(modelInfos, prev));
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

  // ── Unsaved input ──
  // Everything the user can fill in, as one string. The window has something to lose once this
  // differs from what the form held when it opened (or when it was last saved). The string
  // holds the key: it stays in memory, and is never logged or rendered.
  const formSnapshot = JSON.stringify([
    selectedId, serviceName, apiKey, baseUrl, selectedPlanId, useRawUrl, manualModelInput,
    [...selectedModels].map((id) => [id, showAdvanced ? perModelDeclared[id] ?? null : null]),
  ]);
  // null until the form has been reset or prefilled for this opening (the layout effect below).
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  if (isOpen && savedSnapshot === null) setSavedSnapshot(formSnapshot);
  const dirty = isOpen && savedSnapshot !== null && formSnapshot !== savedSnapshot;

  // ── Save ──

  const handleSave = useCallback(() => {
    // The window stays on screen while it fades out; a second click then must not save again.
    if (!isOpen) return;
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

    // What the form holds is saved now: nothing is left to discard.
    setSavedSnapshot(formSnapshot);
    onClose();
  }, [
    isOpen, formSnapshot,
    serviceName, selectedModels, ollamaModels, selectedOption,
    isCustom, showAdvanced, perModelDeclared, useRawUrl, baseUrl, apiKey, providers,
    effectiveFormat, activePlan, editProvider,
    addProvider, updateProvider, selectModel, onClose,
  ]);

  // ── Delete (edit mode only) — the same question and the same calls as the
  // delete button on the provider's card: custom providers are removed outright,
  // builtin providers are disabled + cleared (they can't leave the array,
  // they're reseeded by createDefaultProviders) so they simply drop out of
  // the visible list. ──
  const handleDeleteProvider = useCallback(async () => {
    if (!isOpen || !editProvider) return;
    const confirmed = await confirm({
      title: t.settings.deleteProviderConfirm,
      message: editProvider.name,
      confirmLabel: t.common.confirm,
      tone: 'danger',
    });
    if (!confirmed) return;
    // The answer is about the provider as it is now: it may have gone, or become the one in
    // use, while the question was open.
    const answered = useSettingsStore.getState();
    const current = answered.providers.find((p) => p.id === editProvider.id);
    if (!current) return;
    const wasActive = answered.activeModel.providerId === current.id;

    if (current.source === 'custom') {
      removeProvider(current.id);
    } else {
      updateProvider(current.id, { enabled: false, apiKey: '', status: 'unchecked', userAdded: false });
    }

    if (wasActive) {
      const state = useSettingsStore.getState();
      const next = state.providers.find(p => p.enabled && p.id !== current.id);
      if (next && next.models.length > 0) {
        selectModel(next.id, next.models[0].id);
      }
    }

    onClose();
  }, [isOpen, editProvider, confirm, t, removeProvider, updateProvider, selectModel, onClose]);

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
  }, []);

  const prefillFromEditProvider = useCallback((p: ProviderInstance) => {
    const optionId = p.source === 'builtin' ? p.id : CUSTOM_ID;
    setSelectedId(optionId);
    setServiceName(p.name);
    setNameManuallyEdited(true);
    setApiKey(p.apiKey);
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
    // The next render holds the form as it opens: that is what "nothing typed yet" means.
    setSavedSnapshot(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, editProvider?.id]);

  // ── Render helpers ──

  const canSave = serviceName.trim() && selectedModels.size > 0;
  // One spinner for the model list; the button that started the work keeps its icon still.
  const modelsBusy = fetchModelsStatus === 'fetching' || ollamaStatus === 'checking';
  const searchIcon = (
    <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-label-tertiary">
      <Icon icon={AppIcons.search} size="sm" />
    </span>
  );
  const docsLink = guide && (
    <Pressable onClick={() => open(guide.url)} className={TEXT_LINK}>
      {t.settings.viewDocs}
      <Icon icon={AppIcons.openExternal} size="sm" />
    </Pressable>
  );

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => { if (!next) onClose(); }}
      // The form is wiped once the window has gone, so it does not empty while it fades out.
      onCloseAutoFocus={() => { if (!isOpen) resetFormState(); }}
      title={shownProvider ? t.settings.editService : t.settings.addService}
      size="lg"
      closeButton
      dirty={dirty}
      footer={(
        <>
          {/* Left: delete (edit mode only), validate connection and its result */}
          <div className="mr-auto flex min-w-0 items-center gap-2">
            {shownProvider && (
              <Button variant="danger" size="sm" icon={AppIcons.delete} onClick={() => { void handleDeleteProvider(); }}>
                {t.settings.deleteService}
              </Button>
            )}
            {selectedId && !isOllama && !isLMStudio && (
              <Button
                variant="plain"
                size="sm"
                onClick={handleValidate}
                disabled={validating || !apiKey.trim() || !baseUrl.trim() || selectedModels.size === 0}
              >
                {t.settings.validateConnection}
              </Button>
            )}
            {/* The one spinner of this area; it gives its place to the result. */}
            {validating && <Spinner size="sm" label={t.settings.validating} />}
            {validateResult && (
              <span className={cn('inline-flex min-w-0 items-center gap-1 text-ui-sm', validateResult.success ? 'text-success' : 'text-danger')}>
                <StatusIcon tone={validateResult.success ? 'success' : 'danger'} size="sm" />
                <span className="max-w-70 truncate">{validateResult.message}</span>
              </span>
            )}
          </div>
          {/* Cancel closes the way Escape does: typed input is asked about first. */}
          <DialogClose asChild><Button variant="secondary">{t.common.cancel}</Button></DialogClose>
          <Button variant="primary" onClick={handleSave} disabled={!canSave}>{t.settings.save}</Button>
        </>
      )}
    >
      {/* Single field column — every field lives here (design doc §4.1); the
          dialog scrolls it and keeps the title and the buttons in place. */}
      <div className="space-y-3">
        {keyDecryptFailed && <InlineMessage tone="danger">{t.settings.apiKeyDecryptFailed}</InlineMessage>}
        {!keyDecryptFailed && keySaveFailed && <InlineMessage tone="warning">{t.settings.apiKeySaveFailed}</InlineMessage>}

        {/* 1. Provider selector — above service name (design doc §4.1). Locked
            into a read-only chip in edit mode: the provider identity can't
            change (that would be a different service). */}
        <div className="space-y-1">
          <label className={FIELD_LABEL}>{t.settings.selectProviderType}</label>
          {shownProvider ? (
            <div className="flex h-7 items-center rounded-control bg-fill px-2 text-ui text-label-secondary">
              {selectedOption?.label ?? shownProvider.name}
            </div>
          ) : (
            <Popover
              open={dropdownOpen}
              onOpenChange={setDropdownOpen}
              align="start"
              className="w-(--radix-popover-trigger-width) p-1"
              trigger={(
                <Pressable aria-expanded={dropdownOpen} className={PANEL_TRIGGER}>
                  <span className={cn('min-w-0 truncate', !selectedOption && 'text-label-placeholder')}>
                    {selectedOption ? selectedOption.label : t.settings.selectProviderType}
                  </span>
                  <Icon icon={AppIcons.selectorChevrons} size="sm" className="text-label-secondary" />
                </Pressable>
              )}
            >
              <div className="relative">
                {searchIcon}
                <TextField
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t.settings.searchProvider}
                  className="pl-7"
                />
              </div>
              {/* Picking a provider only fills the form; nothing happens until Save.
                  The padding keeps the focus ring of a row inside the scroll box. */}
              <div className="-mx-1 -mb-1 mt-1 max-h-64 overflow-y-auto px-1 pb-1">
                {filteredGroups.map((group) => (
                  <div key={group.key}>
                    <div className="px-2 py-1 text-ui-sm text-label-tertiary">{group.label}</div>
                    {group.options.map((option) => {
                      const current = selectedId === option.id;
                      return (
                        <Pressable
                          key={option.id}
                          onClick={() => handleSelectProvider(option)}
                          className={cn(
                            'flex h-7 w-full items-center gap-2 rounded-control px-2 text-left text-ui hover:bg-fill-hover',
                            current && 'bg-fill-selected',
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{option.label}</span>
                          {current && <Icon icon={AppIcons.done} size="sm" />}
                        </Pressable>
                      );
                    })}
                  </div>
                ))}
              </div>
            </Popover>
          )}
        </div>

        {/* 2. Service Name */}
        <div className="space-y-1">
          <label htmlFor={`${fieldId}-name`} className={FIELD_LABEL}>{t.settings.serviceName}</label>
          <TextField
            id={`${fieldId}-name`}
            value={serviceName}
            onChange={handleNameChange}
            placeholder={t.settings.serviceNameAuto}
          />
        </div>

        {/* 3. Config Plan — always rendered (design doc §4.3): multi-plan
            builtins get the dropdown as before; everything else (single-plan
            builtin, custom, local) shows a greyed read-only placeholder so
            the row never disappears. */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label className={FIELD_LABEL}>{t.settings.configPlan}</label>
            {hasPlanRow && docsLink}
          </div>
          {hasPlanRow ? (
              <Select
                fullWidth
                label={t.settings.configPlan}
                value={selectedPlanId ?? ''}
                options={[...providerPlans!]
                  .sort((a, b) => (PLAN_ORDER[a.id] ?? 99) - (PLAN_ORDER[b.id] ?? 99))
                  .map(p => ({
                    value: p.id,
                    label: p.label ?? (
                      p.id === 'paygo' && selectedOption?.provider === 'bailian'
                        ? t.settings.billingPaygoBeijing
                      : p.id === 'paygo' ? t.settings.billingPaygo
                      : p.id === 'coding' ? t.settings.billingCoding
                      : p.id === 'tokenplan' ? t.settings.billingTokenPlan
                      // Custom's two format "plans" (design doc §7b) — reuse
                      // the existing entry-label i18n keys as the dropdown's
                      // option labels.
                      : p.id === 'openai' ? t.settings.customApiOpenai
                      : p.id === 'anthropic' ? t.settings.customApiAnthropic
                      : t.settings.billingAgent),
                  }))}
                onValueChange={handleSelectPlan}
              />
          ) : (
            <div className={FIXED_VALUE}>{configMethodPlaceholder}</div>
          )}
        </div>

        {/* 4. API Key — read-only "no key needed" for keyless local providers,
            disabled placeholder before a provider is picked. */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label htmlFor={isOllama || isLMStudio ? undefined : `${fieldId}-key`} className={FIELD_LABEL}>
                {t.settings.apiKey}
              </label>
              {selectedId && !isOllama && !isLMStudio && (
                <span className="text-ui-sm text-label-tertiary">
                  {isCustom ? t.settings.apiKeyOptional : t.settings.apiKeyRequired}
                </span>
              )}
            </div>
            {selectedId && !hasPlanRow && docsLink}
          </div>
          {isOllama || isLMStudio ? (
            <div className={FIXED_VALUE}>{t.settings.localNoKeyNeeded}</div>
          ) : (
            <>
              {/* Keyed by provider: the key of another provider starts masked again. */}
              <SecretField
                key={selectedId}
                id={`${fieldId}-key`}
                value={apiKey}
                onChange={setApiKey}
                placeholder="sk-..."
                disabled={!selectedId}
              />
              {selectedOption?.provider === 'bailian' && activePlan && (
                <p className="text-caption text-label-tertiary">{t.settings.bailianBillingKeyHint}</p>
              )}
            </>
          )}
        </div>

        {/* 5. API Address — read-only fixed endpoint for built-in cloud
            providers (shown, not hidden, per design doc §4.3), editable for
            custom/local, disabled placeholder before a provider is picked. */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor={`${fieldId}-url`} className={FIELD_LABEL}>
              {isOllama ? t.settings.ollamaUrlLabel : isLMStudio ? t.settings.lmstudioUrlLabel : t.settings.apiUrl}
            </label>
            {showAdvanced && effectiveFormat !== 'anthropic' && (
              <span className="inline-flex items-center gap-2" title={t.settings.capRawUrlHint}>
                <label htmlFor={`${fieldId}-raw-url`} className="text-ui-sm text-label-secondary">{t.settings.capRawUrl}</label>
                <Switch id={`${fieldId}-raw-url`} checked={useRawUrl} onCheckedChange={() => setUseRawUrl(v => !v)} />
              </span>
            )}
          </div>
          {isBuiltinCloud ? (
            <TextField id={`${fieldId}-url`} readOnly value={baseUrl} className="font-code" />
          ) : (
            <TextField
              id={`${fieldId}-url`}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={isOllama ? 'http://127.0.0.1:11434' : isLMStudio ? 'http://127.0.0.1:1234/v1' : 'https://...'}
              onBlur={isOllama ? handleCheckOllama : isLMStudio ? handleFetchModels : undefined}
              disabled={!selectedId}
            />
          )}
          {(isOllama || isLMStudio) && (
            <p className="text-ui-sm text-label-tertiary">
              {isOllama ? t.settings.ollamaUrlHint : t.settings.lmstudioUrlHint}
            </p>
          )}

          {/* Final request URL preview — hidden for local providers which have their own status UI */}
          {!isOllama && !isLMStudio && baseUrl.trim() && selectedOption && (
            <p className="break-all font-code text-caption text-label-tertiary">
              ↳ {t.settings.apiUrlPreview}: POST {buildFullChatUrl(baseUrl, effectiveFormat, { useRawUrl })}
            </p>
          )}

          {/* Ollama connection status */}
          {isOllama && ollamaStatus !== 'idle' && ollamaStatus !== 'checking' && (
            <div className="space-y-1">
              <div className={cn('flex items-center gap-1 text-ui-sm', ollamaStatus === 'online' ? 'text-success' : 'text-danger')}>
                <StatusIcon tone={ollamaStatus === 'online' ? 'success' : 'danger'} size="sm" />
                <span>{ollamaStatus === 'online' ? t.settings.ollamaOnline : t.settings.ollamaOffline}</span>
              </div>
              {ollamaStatus === 'offline' && ollamaError && (
                <p className="break-all pl-5 font-code text-caption text-danger">{ollamaError}</p>
              )}
            </div>
          )}

          {/* LM Studio connection status */}
          {isLMStudio && fetchModelsStatus !== 'idle' && fetchModelsStatus !== 'fetching' && (
            <div className={cn('flex items-center gap-1 text-ui-sm', fetchModelsStatus === 'success' ? 'text-success' : 'text-danger')}>
              <StatusIcon tone={fetchModelsStatus === 'success' ? 'success' : 'danger'} size="sm" />
              <span>{fetchModelsStatus === 'success' ? t.settings.lmstudioOnline : t.settings.lmstudioOffline}</span>
            </div>
          )}
        </div>

        {/* 6. Model Selection — row always present; content is a disabled
            placeholder before a provider is picked. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className={FIELD_LABEL}>{t.settings.models}</label>
            <div className="flex items-center gap-1">
              {/* The one spinner of the model list. It sits before the buttons, which keep their place. */}
              {modelsBusy && <Spinner size="sm" label={t.settings.fetchingModels} />}
              {/* Fetch/refresh models button — every non-Ollama provider
                  (Ollama has its own probe button below). Curated built-ins
                  get it too: their model list is a hand-maintained static
                  table that goes stale between releases, so "fetch" is how a
                  user reaches a model we haven't shipped yet. The anthropic
                  format is no longer excluded — modelFetcher routes it
                  through the Anthropic Models API. */}
              {!isOllama && supportsModelListForSelection && baseUrl.trim() && (
                <Button
                  variant="plain"
                  size="sm"
                  icon={AppIcons.retry}
                  onClick={handleFetchModels}
                  disabled={fetchModelsStatus === 'fetching' || !baseUrl.trim()}
                >
                  {t.settings.fetchModels}
                </Button>
              )}
              {isOllama && (
                <Button
                  variant="plain"
                  size="sm"
                  icon={AppIcons.retry}
                  onClick={handleCheckOllama}
                  disabled={ollamaStatus === 'checking'}
                >
                  {t.settings.fetchModels}
                </Button>
              )}
              {(isCustom || isLMStudio || usesFetchedModels) && (
                <Button variant="plain" size="sm" icon={AppIcons.add} onClick={toggleAddModelInput}>
                  {t.settings.addModel}
                </Button>
              )}
            </div>
          </div>

          {!selectedId ? (
            <div className={FIXED_VALUE}>{t.settings.selectProviderFirst}</div>
          ) : (
            <>
              {/* Fetch status messages */}
              {fetchModelsStatus === 'success' && (
                <p className="flex items-center gap-1 text-ui-sm text-success">
                  <StatusIcon tone="success" size="sm" />
                  <span>{t.settings.fetchModelsSuccess.replace('{count}', String(fetchedModels.length))}</span>
                </p>
              )}
              {fetchModelsStatus === 'error' && (
                <p className="flex items-center gap-1 text-ui-sm text-danger">
                  <StatusIcon tone="danger" size="sm" />
                  <span>{fetchModelsError || t.settings.fetchModelsError}</span>
                </p>
              )}

              {/* Curated built-in providers — a panel over the curated model
                  list, plus an add-model input for ids not listed.
                  Nothing is pre-selected; the user checks what to add. */}
              {isBuiltinCurated && (
                <Popover
                  open={modelDropdownOpen}
                  onOpenChange={(next) => {
                    setModelDropdownOpen(next);
                    if (!next) setShowCuratedAddInput(false);
                  }}
                  align="start"
                  className="w-(--radix-popover-trigger-width) p-1"
                  trigger={(
                    <Pressable aria-expanded={modelDropdownOpen} className={PANEL_TRIGGER}>
                      <span className={cn('min-w-0 truncate text-left', selectedModels.size === 0 && 'text-label-placeholder')}>
                        {selectedModels.size === 0
                          ? t.settings.selectModel
                          : builtinModelList.filter((m) => selectedModels.has(m.id)).map((m) => m.label).join('、')}
                      </span>
                      <Icon icon={AppIcons.selectorChevrons} size="sm" className="text-label-secondary" />
                    </Pressable>
                  )}
                >
                  {(() => {
                    // Same "search + counter + bulk" affordances as the
                    // fetched checklist below, scoped to this panel —
                    // a fetch can turn a 4-row curated list into a
                    // 300-row catalog, and scrolling that is unusable.
                    const showFilter = builtinModelList.length >= MODEL_FILTER_MIN_ITEMS;
                    const visible = showFilter
                      ? filterModels(builtinModelList, modelListFilter)
                      : builtinModelList;
                    const visibleIds = visible.map((m) => m.id);
                    const visibleSelected = visibleIds.filter((id) => selectedModels.has(id)).length;
                    return (
                      <>
                        {showFilter && (
                          <div className="mb-1 space-y-1 border-b border-separator pb-1">
                            <div className="relative">
                              {searchIcon}
                              <TextField
                                value={modelListFilter}
                                onChange={(e) => setModelListFilter(e.target.value)}
                                placeholder={t.settings.filterModelsPlaceholder}
                                className="pl-7"
                              />
                            </div>
                            <div className="flex items-center justify-between gap-2 pl-2">
                              <span className="truncate text-ui-sm text-label-tertiary">
                                {t.settings.modelsSelectedCount
                                  .replace('{selected}', String(selectedModels.size))
                                  .replace('{total}', String(builtinModelList.length))}
                              </span>
                              <div className="flex shrink-0 items-center gap-1">
                                <Button
                                  variant="plain"
                                  size="sm"
                                  onClick={() => handleSelectModels(visibleIds)}
                                  disabled={visibleIds.length === 0 || visibleSelected === visibleIds.length}
                                >
                                  {t.settings.selectAllModels}
                                </Button>
                                <Button
                                  variant="plain"
                                  size="sm"
                                  onClick={() => handleDeselectModels(visibleIds)}
                                  disabled={visibleSelected === 0}
                                >
                                  {t.settings.clearSelectedModels}
                                </Button>
                              </div>
                            </div>
                          </div>
                        )}
                        {/* One panel for the whole list: a row is a checkbox and its name, nothing floats per row. */}
                        <div className="max-h-64 overflow-y-auto">
                          {showFilter && visible.length === 0 && (
                            <p className="px-2 py-1 text-ui-sm text-label-tertiary">{t.settings.filterModelsNoResults}</p>
                          )}
                          {visible.map((model) => (
                            <PanelModelRow
                              key={model.id}
                              id={model.id}
                              label={model.label}
                              checked={selectedModels.has(model.id)}
                              onToggle={handleToggleModel}
                            />
                          ))}
                        </div>
                      </>
                    );
                  })()}
                  {/* Add a model id the curated list doesn't have — a
                      "使用其他模型" row by default that reveals the
                      model-id input on click, collapsing back after add.
                      Stays pinned: in a long merged list an escape hatch
                      parked after the last row is unfindable. */}
                  <div className="mt-1 border-t border-separator pt-1">
                    {showCuratedAddInput ? (
                      <div className="flex items-center gap-1">
                        <div className="min-w-0 flex-1">
                          <TextField
                            ref={addModelInputRef}
                            value={manualModelInput}
                            onChange={(e) => setManualModelInput(e.target.value)}
                            placeholder={t.settings.addModelPlaceholder}
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (manualModelInput.trim()) { handleAddManualModel(); setShowCuratedAddInput(false); }
                              }
                            }}
                          />
                        </div>
                        <IconButton
                          size="sm"
                          icon={AppIcons.add}
                          label={t.settings.add}
                          onClick={() => { handleAddManualModel(); setShowCuratedAddInput(false); }}
                          disabled={!manualModelInput.trim()}
                        />
                        <IconButton
                          size="sm"
                          icon={AppIcons.close}
                          label={t.common.cancel}
                          onClick={() => { setManualModelInput(''); setShowCuratedAddInput(false); }}
                        />
                      </div>
                    ) : (
                      <Pressable
                        onClick={() => setShowCuratedAddInput(true)}
                        className="flex w-full items-start gap-2 rounded-control px-2 py-1 text-left hover:bg-fill-hover"
                      >
                        <span className="flex h-5 items-center text-label-secondary"><Icon icon={AppIcons.add} size="sm" /></span>
                        <span className="flex min-w-0 flex-col">
                          <span className="text-ui text-label">{t.settings.useOtherModel}</span>
                          <span className="text-ui-sm text-label-tertiary">{t.settings.useOtherModelDesc}</span>
                        </span>
                      </Pressable>
                    )}
                  </div>
                </Popover>
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

                  // Surface the scoped search once the checklist is long enough that
                  // scrolling to find one model is annoying — which, now that a fetch
                  // pre-checks nothing, is the normal way to work through an
                  // aggregator/gateway catalog rather than a rare escape hatch.
                  const showModelListFilter = displayList.length >= MODEL_FILTER_MIN_ITEMS;
                  const filteredList = showModelListFilter
                    ? filterModels(displayList, modelListFilter)
                    : displayList;
                  const visibleIds = filteredList.map((m) => m.id);
                  const visibleSelectedCount = visibleIds.filter((id) => selectedModels.has(id)).length;

                  return (
                    <div className="space-y-2">
                      {showModelListFilter && (
                        <div className="relative">
                          {searchIcon}
                          <TextField
                            value={modelListFilter}
                            onChange={(e) => setModelListFilter(e.target.value)}
                            placeholder={t.settings.filterModelsPlaceholder}
                            className="pl-7"
                          />
                        </div>
                      )}
                      {/* Selection counter + bulk actions — only meaningful for a
                          fetched checklist (a manual-only list is all-selected by
                          construction, with per-row X to remove). */}
                      {hasFetched && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-ui-sm text-label-tertiary">
                            {selectedModels.size === 0
                              ? t.settings.modelsPickHint
                              : t.settings.modelsSelectedCount
                                  .replace('{selected}', String(selectedModels.size))
                                  .replace('{total}', String(displayList.length))}
                          </span>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="plain"
                              size="sm"
                              onClick={() => handleSelectModels(visibleIds)}
                              disabled={visibleIds.length === 0 || visibleSelectedCount === visibleIds.length}
                            >
                              {t.settings.selectAllModels}
                            </Button>
                            <Button
                              variant="plain"
                              size="sm"
                              onClick={() => handleDeselectModels(visibleIds)}
                              disabled={visibleSelectedCount === 0}
                            >
                              {t.settings.clearSelectedModels}
                            </Button>
                          </div>
                        </div>
                      )}
                      {/* The padding keeps the focus ring of a row's controls inside the scroll box. */}
                      <div className="-m-1 max-h-72 space-y-2 overflow-y-auto p-1">
                      {/* Inline add-model input, revealed at the top of the model list */}
                      {showAddModelInput && (
                        <div className="flex items-center gap-1">
                          <div className="min-w-0 flex-1">
                            <TextField
                              ref={addModelInputRef}
                              value={manualModelInput}
                              onChange={(e) => setManualModelInput(e.target.value)}
                              placeholder={t.settings.addModelPlaceholder}
                              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddManualModel(); } }}
                            />
                          </div>
                          <IconButton
                            size="sm"
                            icon={AppIcons.add}
                            label={t.settings.add}
                            onClick={() => { handleAddManualModel(); addModelInputRef.current?.focus(); }}
                            disabled={!manualModelInput.trim()}
                          />
                          <IconButton size="sm" icon={AppIcons.close} label={t.common.cancel} onClick={toggleAddModelInput} />
                        </div>
                      )}

                      {showModelListFilter && filteredList.length === 0 && (
                        <p className="px-1 py-2 text-ui-sm text-label-tertiary">{t.settings.filterModelsNoResults}</p>
                      )}
                      {filteredList.map((model) => (
                        renderModelRow(model, hasFetched ? 'choice' : 'added', hasFetched ? selectedModels.has(model.id) : true)
                      ))}
                      </div>
                    </div>
                  );
                })()}

              {/* Ollama models — the models the local server reported, one card per model */}
              {isOllama && ollamaStatus === 'online' && ollamaModels.length > 0 && (
                <div className="-m-1 max-h-48 space-y-2 overflow-y-auto p-1">
                  {ollamaModels.map((model) => renderModelRow(model, 'detected', selectedModels.has(model.id)))}
                </div>
              )}

              {/* Ollama — no models detected */}
              {isOllama && ollamaStatus === 'online' && ollamaModels.length === 0 && (
                <div className="px-1 text-ui text-label-tertiary">
                  <p>{t.settings.ollamaNoModels}</p>
                  <p className="mt-1 text-ui-sm">{t.settings.ollamaNoModelsHint}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
