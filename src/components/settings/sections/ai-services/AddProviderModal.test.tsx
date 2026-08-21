/// <reference types="@testing-library/jest-dom" />
/**
 * Unit tests for AddProviderModal.
 *
 * Two tiers:
 *  1. Pure-logic helpers (showAdvanced predicate, supportedEfforts toggle
 *     reducer) via their shared module — cheap, no rendering needed.
 *  2. Edit-mode rendering, using the REAL settingsStore (Tauri calls are
 *     mocked globally in src/test/setup.ts, so addProvider/updateProvider's
 *     fire-and-forget secret-store writes are safe) — covers prefill,
 *     provider-selector locking, save-routes-through-update, and delete.
 *     Add-mode's full interactive flow (portal dropdowns, fetch, ollama) is
 *     intentionally not re-tested here; it was already effectively covered
 *     only by manual/smoke testing before this change and stays that way —
 *     see docs/2026-07-11-modal-unify-design.md §7.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { computeShowAdvanced, toggleEffort } from './providerCapabilities';
import AddProviderModal from './AddProviderModal';
import { useSettingsStore } from '@/stores/settingsStore';
import { setLanguage } from '@/i18n';
import type { ProviderInstance } from '@/types/provider';

// The fetched-model checklist tests drive the real component against a stubbed
// GET /models — no other test in this file clicks Fetch, so a file-wide mock is safe.
vi.mock('@/core/llm/modelFetcher', () => ({ fetchProviderModels: vi.fn() }));
import { fetchProviderModels } from '@/core/llm/modelFetcher';

// ── Tests ──────────────────────────────────────────────────────────

describe('AddProviderModal — showAdvanced predicate', () => {
  it('shows advanced section for custom OpenAI-compatible provider', () => {
    expect(computeShowAdvanced(true, 'custom', 'openai-compatible')).toBe(true);
  });

  it('shows advanced section for custom Anthropic-format provider', () => {
    // Anthropic custom endpoints are often proxies fronting non-Claude models,
    // so tools/vision/token-limit declarations still apply. Fields that don't
    // (useRawUrl, reasoning-effort) are hidden in AdvancedCapabilitiesFields.
    expect(computeShowAdvanced(true, 'custom', 'anthropic')).toBe(true);
  });

  it('shows advanced section for ollama', () => {
    expect(computeShowAdvanced(false, 'ollama', undefined)).toBe(true);
  });

  it('shows advanced section for lmstudio', () => {
    expect(computeShowAdvanced(false, 'lmstudio', undefined)).toBe(true);
  });

  it('hides advanced section for builtin cloud provider (anthropic)', () => {
    expect(computeShowAdvanced(false, 'anthropic', 'anthropic')).toBe(false);
  });

  it('hides advanced section for builtin cloud provider (openai)', () => {
    expect(computeShowAdvanced(false, 'openai', 'openai-compatible')).toBe(false);
  });

  it('hides advanced section when no provider is selected', () => {
    expect(computeShowAdvanced(false, undefined, undefined)).toBe(false);
  });
});

describe('AddProviderModal — supportedEfforts toggle reducer', () => {
  it('adds an effort level when not present', () => {
    const result = toggleEffort(undefined, 'low');
    expect(result).toContain('low');
  });

  it('removes an effort level when already present', () => {
    const result = toggleEffort(['low', 'medium'], 'low');
    expect(result).not.toContain('low');
    expect(result).toContain('medium');
  });

  it('preserves other effort levels when toggling a new one', () => {
    const result = toggleEffort(['medium'], 'high');
    expect(result).toContain('medium');
    expect(result).toContain('high');
  });

  it('handles toggle on empty supportedEfforts', () => {
    const result = toggleEffort([], 'medium');
    expect(result).toEqual(['medium']);
  });

  it('can build all three effort levels independently', () => {
    let d: Array<'low' | 'medium' | 'high'> | undefined = undefined;
    d = toggleEffort(d, 'low');
    d = toggleEffort(d, 'medium');
    d = toggleEffort(d, 'high');
    expect(new Set(d)).toEqual(new Set(['low', 'medium', 'high']));
  });
});

// ── Edit mode (design doc §4.4/§4.5: unify Add + Edit into one modal) ──

describe('AddProviderModal — edit mode', () => {
  // Builtin provider: PROVIDER_CONFIGS names (e.g. "DeepSeek") are literal
  // vendor strings, not translated — safe to assert on regardless of locale.
  const builtinProvider: ProviderInstance = {
    id: 'deepseek',
    source: 'builtin',
    name: 'My DeepSeek',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-existing',
    models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    status: 'unchecked',
    sortOrder: 0,
    userAdded: true,
  };

  const customProvider: ProviderInstance = {
    id: 'custom-abc123',
    source: 'custom',
    name: 'My Custom API',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'sk-custom',
    models: [{ id: 'my-model', label: 'my-model' }],
    status: 'unchecked',
    sortOrder: 1,
    userAdded: true,
  };

  beforeEach(() => {
    setLanguage('en-US');
    useSettingsStore.setState({
      providers: [builtinProvider, customProvider],
      activeModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' },
      failedSecretKeys: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('prefills service name and API key from the provider being edited', () => {
    render(<AddProviderModal open={true} editProvider={builtinProvider} onClose={vi.fn()} />);

    expect(screen.getByDisplayValue('My DeepSeek')).toBeInTheDocument();
    const keyInput = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(keyInput?.value).toBe('sk-existing');
  });

  it('locks the provider selector into a read-only chip (not a clickable dropdown)', () => {
    render(<AddProviderModal open={true} editProvider={builtinProvider} onClose={vi.fn()} />);

    // The vendor name renders as static text, not inside a <button> (the
    // interactive add-mode dropdown trigger is a <button>).
    const chip = screen.getByText('DeepSeek');
    expect(chip.closest('button')).toBeNull();
  });

  it('does not render the read-only chip in add mode (no editProvider)', () => {
    render(<AddProviderModal open={true} onClose={vi.fn()} />);
    // Nothing is selected yet, so the interactive trigger shows the
    // placeholder text, not a vendor name — the dropdown is a <button>.
    const trigger = screen.getByRole('button', { name: /select provider/i });
    expect(trigger).toBeInTheDocument();
  });

  it('save routes through updateProvider with the edited provider id, not addProvider', () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), 'updateProvider');
    const addSpy = vi.spyOn(useSettingsStore.getState(), 'addProvider');
    const onClose = vi.fn();

    render(<AddProviderModal open={true} editProvider={builtinProvider} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateSpy).toHaveBeenCalledWith('deepseek', expect.objectContaining({
      name: 'My DeepSeek',
      apiKey: 'sk-existing',
    }));
    expect(addSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a delete action that removes a custom provider via removeProvider', () => {
    const removeSpy = vi.spyOn(useSettingsStore.getState(), 'removeProvider');
    const onClose = vi.fn();

    render(<AddProviderModal open={true} editProvider={customProvider} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /delete service/i }));
    // Confirm dialog
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(removeSpy).toHaveBeenCalledWith('custom-abc123');
    expect(onClose).toHaveBeenCalled();
  });

  it('deleting a builtin provider disables it instead of removing it', () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), 'updateProvider');
    const onClose = vi.fn();

    render(<AddProviderModal open={true} editProvider={builtinProvider} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /delete service/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(updateSpy).toHaveBeenCalledWith('deepseek', expect.objectContaining({
      enabled: false,
      apiKey: '',
      userAdded: false,
    }));
  });

  it('shows the API-key decrypt-failure warning when the key failed to decrypt', () => {
    useSettingsStore.setState({ failedSecretKeys: ['provider:deepseek'] });
    render(<AddProviderModal open={true} editProvider={builtinProvider} onClose={vi.fn()} />);
    expect(screen.getByText(/could not be decrypted/i)).toBeInTheDocument();
  });
});

// ── Edit-save regressions (edit-save wrongly routed through add-mode-only
// behavior — see docs/2026-07-11-modal-unify-design.md; the retired
// ProviderCard inline-edit `handleSave` never auto-selected a model, never
// forced `enabled: true`, and always preserved existing provider-level
// declaredCapabilities fields) ──

describe('AddProviderModal — edit-save regressions', () => {
  beforeEach(() => {
    setLanguage('en-US');
  });

  afterEach(() => {
    cleanup();
  });

  it('editing the only enabled provider does not change the active model when a non-first model is currently active', () => {
    const provider: ProviderInstance = {
      id: 'deepseek',
      source: 'builtin',
      name: 'My DeepSeek',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-existing',
      models: [
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
        { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      ],
      status: 'unchecked',
      sortOrder: 0,
      userAdded: true,
    };
    useSettingsStore.setState({ providers: [provider], failedSecretKeys: [] });
    // Make the non-first model the active one, the same way a real user would.
    useSettingsStore.getState().selectModel('deepseek', 'deepseek-v4-flash');

    const onClose = vi.fn();
    render(<AddProviderModal open={true} editProvider={provider} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onClose).toHaveBeenCalled();
    expect(useSettingsStore.getState().activeModel).toEqual({
      providerId: 'deepseek',
      modelId: 'deepseek-v4-flash',
    });
  });

  it('editing a disabled provider and saving keeps it disabled', () => {
    const provider: ProviderInstance = {
      id: 'custom-disabled',
      source: 'custom',
      name: 'My Disabled Provider',
      enabled: false,
      apiFormat: 'openai-compatible',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-custom',
      models: [{ id: 'my-model', label: 'my-model' }],
      status: 'unchecked',
      sortOrder: 0,
      userAdded: true,
    };
    useSettingsStore.setState({ providers: [provider], failedSecretKeys: [] });

    const onClose = vi.fn();
    render(<AddProviderModal open={true} editProvider={provider} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onClose).toHaveBeenCalled();
    expect(useSettingsStore.getState().providers.find(p => p.id === 'custom-disabled')?.enabled).toBe(false);
  });

  it('editing a provider whose declaredCapabilities has extra fields preserves them (not wiped to { useRawUrl })', () => {
    const provider: ProviderInstance = {
      id: 'custom-caps',
      source: 'custom',
      name: 'My Custom Caps',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-custom',
      models: [{ id: 'my-model', label: 'my-model' }],
      status: 'unchecked',
      sortOrder: 0,
      userAdded: true,
      declaredCapabilities: {
        maxTokensField: 'max_completion_tokens',
        requiresToolResultName: true,
      },
    };
    useSettingsStore.setState({ providers: [provider], failedSecretKeys: [] });
    const updateSpy = vi.spyOn(useSettingsStore.getState(), 'updateProvider');
    const onClose = vi.fn();

    render(<AddProviderModal open={true} editProvider={provider} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateSpy).toHaveBeenCalledWith('custom-caps', expect.objectContaining({
      declaredCapabilities: expect.objectContaining({
        maxTokensField: 'max_completion_tokens',
        requiresToolResultName: true,
      }),
    }));
  });
});

// ── Custom API single entry (design doc §7b): the two former "Custom API
// (OpenAI Compatible)" / "Custom API (Anthropic Compatible)" provider-type
// options are collapsed into one "Custom API" entry, whose format is instead
// picked via the same 配置方式/config-plan dropdown a multi-endpoint builtin
// (e.g. volcengine) uses — reusing PROVIDER_CONFIGS.custom.plans. ──

describe('AddProviderModal — custom API single entry with format-switch plans', () => {
  beforeEach(() => {
    setLanguage('en-US');
    useSettingsStore.setState({
      providers: [],
      activeModel: { providerId: '', modelId: '' },
      failedSecretKeys: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('selecting the single custom entry shows a config-method dropdown with two format options', () => {
    render(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom API' }));

    // The old "not applicable for custom" greyed placeholder must be gone —
    // custom now gets a real, active config-method Select like a
    // multi-endpoint builtin.
    expect(screen.queryByText(/not applicable for custom/i)).not.toBeInTheDocument();

    // Defaults to the OpenAI-compatible plan.
    const planTrigger = screen.getByRole('button', { name: 'OpenAI' });
    fireEvent.click(planTrigger);
    expect(screen.getByRole('button', { name: 'Anthropic' })).toBeInTheDocument();
  });

  it('switching the custom format does not clear a typed API key, base URL, or selected models', () => {
    render(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom API' }));

    const apiKeyInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: 'sk-my-secret' } });

    const baseUrlInput = screen.getByPlaceholderText('https://...') as HTMLInputElement;
    fireEvent.change(baseUrlInput, { target: { value: 'https://my-proxy.example.com/v1' } });

    fireEvent.click(screen.getByRole('button', { name: /add model/i }));
    const modelInput = screen.getByPlaceholderText('Enter model ID');
    fireEvent.change(modelInput, { target: { value: 'my-custom-model' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });
    expect(screen.getByText('my-custom-model')).toBeInTheDocument();

    // Switch OpenAI-compatible → Anthropic.
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic' }));

    expect(apiKeyInput.value).toBe('sk-my-secret');
    expect(baseUrlInput.value).toBe('https://my-proxy.example.com/v1');
    expect(screen.getByText('my-custom-model')).toBeInTheDocument();
  });

  it('editing a saved custom provider with apiFormat "anthropic" preselects the Anthropic format plan', () => {
    const provider: ProviderInstance = {
      id: 'custom-anthropic-1',
      source: 'custom',
      name: 'My Anthropic Proxy',
      enabled: true,
      apiFormat: 'anthropic',
      baseUrl: 'https://my-anthropic-proxy.example.com',
      apiKey: 'sk-abc',
      models: [{ id: 'claude-via-proxy', label: 'claude-via-proxy' }],
      status: 'unchecked',
      sortOrder: 0,
      userAdded: true,
    };
    useSettingsStore.setState({ providers: [provider], failedSecretKeys: [] });

    render(<AddProviderModal open={true} editProvider={provider} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Anthropic' })).toBeInTheDocument();
  });

  it('saving a new custom provider on the Anthropic format persists apiFormat "anthropic"', () => {
    const addSpy = vi.spyOn(useSettingsStore.getState(), 'addProvider');
    const onClose = vi.fn();

    render(<AddProviderModal open={true} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom API' }));

    fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anthropic' }));

    const baseUrlInput = screen.getByPlaceholderText('https://...');
    fireEvent.change(baseUrlInput, { target: { value: 'https://my-anthropic-proxy.example.com' } });

    fireEvent.click(screen.getByRole('button', { name: /add model/i }));
    const modelInput = screen.getByPlaceholderText('Enter model ID');
    fireEvent.change(modelInput, { target: { value: 'claude-via-proxy' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
      apiFormat: 'anthropic',
      baseUrl: 'https://my-anthropic-proxy.example.com',
    }));
    expect(onClose).toHaveBeenCalled();
  });
});

// ── Validate Connection is gated on a selected model ──
// handleValidate builds its test request from selectedModels[0]; with no model
// it would send an empty model id and fail, so the button must stay disabled
// until key + URL + at least one model are all present. Built-in curated
// providers pick models from the portal dropdown (选择模型 ▾), so the model is
// selected by opening it and clicking a model option.

describe('AddProviderModal — Validate Connection gating', () => {
  beforeEach(() => {
    setLanguage('en-US');
    useSettingsStore.setState({
      providers: [],
      activeModel: { providerId: '', modelId: '' },
      failedSecretKeys: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('stays disabled until a model is selected (built-in curated provider)', () => {
    render(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));

    // Built-in cloud providers ship a fixed endpoint (baseUrl already set);
    // supply just the key so only the model is still missing.
    const apiKeyInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: 'sk-test' } });

    const validateButton = screen.getByRole('button', { name: /validate connection/i });
    expect(validateButton).toBeDisabled();

    // Open the curated model dropdown and pick a model.
    fireEvent.click(screen.getByRole('button', { name: /select model/i }));
    fireEvent.click(screen.getByText('DeepSeek V4 Pro'));

    expect(validateButton).not.toBeDisabled();
  });
});

describe('AddProviderModal — Bailian pay-as-you-go', () => {
  beforeEach(() => {
    setLanguage('en-US');
    useSettingsStore.setState({
      providers: [],
      activeModel: { providerId: '', modelId: '' },
      failedSecretKeys: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('switches the endpoint and curated models to Beijing pay-as-you-go', () => {
    render(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Alibaba Bailian' }));
    expect(screen.getByText(/three key types are not interchangeable/i)).toBeInTheDocument();

    // Token Plan remains the recommended default; pay-as-you-go is an
    // explicit last-tier choice because its API key is not interchangeable.
    fireEvent.click(screen.getByRole('button', { name: 'Token Plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pay-as-you-go (Beijing)' }));

    expect(screen.getByText(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
      { exact: true },
    )).toBeInTheDocument();
    expect(screen.getByText(/POST https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions/))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /select model/i }));
    expect(screen.getByText('Qwen3.7 Max')).toBeInTheDocument();
  });
});

// ── Built-in curated dropdown: "使用其他模型" entry row ──
// The curated dropdown's bottom affordance is a two-state "Use another model"
// menu row (not an always-visible input): clicking it reveals the model-id
// input, and a successful add collapses it back to the row.

describe('AddProviderModal — curated "use another model" row', () => {
  beforeEach(() => {
    setLanguage('en-US');
    useSettingsStore.setState({
      providers: [],
      activeModel: { providerId: '', modelId: '' },
      failedSecretKeys: [],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the row (no input) by default, reveals the input on click, and adds a custom model that collapses back', () => {
    render(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
    fireEvent.click(screen.getByRole('button', { name: /select model/i }));

    // Default state: the row is present, no add-model input yet.
    expect(screen.getByText('Use another model')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Enter model ID')).not.toBeInTheDocument();

    // Click the row → the input appears.
    fireEvent.click(screen.getByText('Use another model'));
    const modelInput = screen.getByPlaceholderText('Enter model ID');
    expect(modelInput).toBeInTheDocument();

    // Enter a custom id + Enter → it's added and selected, and the input
    // collapses back to the row.
    fireEvent.change(modelInput, { target: { value: 'deepseek-custom-x' } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });

    // Rendered both as a checked row in the panel and in the trigger summary.
    expect(screen.getAllByText('deepseek-custom-x').length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText('Enter model ID')).not.toBeInTheDocument();
    expect(screen.getByText('Use another model')).toBeInTheDocument();
  });
});

describe('AddProviderModal — fetched model checklist', () => {
  // 12 models: enough to cross MODEL_FILTER_MIN_ITEMS so the search box renders.
  const FETCHED_IDS = [
    'openai/gpt-4o',
    'anthropic/claude-opus-4',
    ...Array.from({ length: 10 }, (_, i) => `vendor/aggregator-model-${i}`),
  ];

  const savedProvider: ProviderInstance = {
    id: 'custom-fetch-test',
    source: 'custom',
    name: 'My Gateway',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://gateway.example.com/v1',
    apiKey: 'sk-gateway',
    models: [{ id: 'already-saved-model', label: 'already-saved-model' }],
    status: 'unchecked',
    sortOrder: 0,
    userAdded: true,
  };

  beforeEach(() => {
    setLanguage('en-US');
    useSettingsStore.setState({
      providers: [savedProvider],
      activeModel: { providerId: 'custom-fetch-test', modelId: 'already-saved-model' },
      failedSecretKeys: [],
    });
    vi.mocked(fetchProviderModels).mockResolvedValue({
      success: true,
      models: FETCHED_IDS.map((id) => ({ id, label: id })),
    });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(fetchProviderModels).mockReset();
  });

  /** Render in edit mode (prefills provider + baseUrl, skipping the portal
   *  dropdown) and click Fetch Models; resolves once the list has rendered. */
  async function renderAndFetch() {
    render(<AddProviderModal open={true} editProvider={savedProvider} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));
    await screen.findByText(`Found ${FETCHED_IDS.length} models`);
  }

  it('pre-checks NOTHING it fetched — the saved model stays selected, the 12 new ones do not', async () => {
    await renderAndFetch();

    // 1 selected (the provider's saved model) out of 13 listed (12 fetched + 1 saved).
    expect(screen.getByText(`1 of ${FETCHED_IDS.length + 1} selected`)).toBeInTheDocument();
    // Every fetched id is listed — nothing is hidden, it just isn't checked.
    for (const id of FETCHED_IDS) {
      expect(screen.getByText(id)).toBeInTheDocument();
    }
  });

  it('renders the search box for a list this size and filters it by substring', async () => {
    await renderAndFetch();

    const search = screen.getByPlaceholderText('Search models…');
    fireEvent.change(search, { target: { value: 'claude' } });

    await waitFor(() => expect(screen.queryByText('openai/gpt-4o')).not.toBeInTheDocument());
    expect(screen.getByText('anthropic/claude-opus-4')).toBeInTheDocument();
    expect(screen.queryByText('vendor/aggregator-model-0')).not.toBeInTheDocument();
  });

  it('"Select all" applies to the current search results only, not the whole fetched list', async () => {
    await renderAndFetch();

    fireEvent.change(screen.getByPlaceholderText('Search models…'), { target: { value: 'aggregator' } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));

    // 10 aggregator matches + the saved model = 11; gpt-4o/claude were filtered
    // out at the time of the click and stay unselected.
    await screen.findByText(`11 of ${FETCHED_IDS.length + 1} selected`);
  });

  it('LM Studio is the exception — its local catalog stays auto-selected', async () => {
    // Same fetch path as a cloud provider, but the models it lists are already
    // loaded on this machine, so "check them all" is still what the user meant.
    const lmstudio: ProviderInstance = {
      id: 'lmstudio',
      source: 'builtin',
      name: 'LM Studio',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      models: [],
      status: 'unchecked',
      sortOrder: 0,
      userAdded: true,
    };
    useSettingsStore.setState({ providers: [lmstudio], failedSecretKeys: [] });

    render(<AddProviderModal open={true} editProvider={lmstudio} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));
    await screen.findByText(`Found ${FETCHED_IDS.length} models`);

    await screen.findByText(`${FETCHED_IDS.length} of ${FETCHED_IDS.length} selected`);
  });

  it('"Clear" deselects the visible rows, including the provider\'s saved model', async () => {
    await renderAndFetch();

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await screen.findByText(`${FETCHED_IDS.length + 1} of ${FETCHED_IDS.length + 1} selected`);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    // Empty selection swaps the counter for the pick-something hint.
    await screen.findByText('Select the models you want to add');
  });
});
