// @vitest-environment happy-dom
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
import { useState, type ReactElement } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { computeShowAdvanced, defaultModelDeclaredCapabilities, toggleEffort } from './providerCapabilities';
import { toModelInfo } from './modelInfoUtil';
import AddProviderModal from './AddProviderModal';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useSettingsStore, PROVIDER_CONFIGS } from '@/stores/settingsStore';
import { getI18n, setLanguage } from '@/i18n';
import type { ProviderInstance } from '@/types/provider';

// The fetched-model checklist tests drive the real component against a stubbed
// GET /models — no other test in this file clicks Fetch, so a file-wide mock is safe.
vi.mock('@/core/llm/modelFetcher', () => ({ fetchProviderModels: vi.fn() }));
import { fetchProviderModels } from '@/core/llm/modelFetcher';
// LM Studio / Ollama 获取模型后会询问窗口；测试里不发真实请求
vi.mock('@/core/llm/contextWindowProbe', () => ({
  fetchLmStudioContextWindows: vi.fn(async () => new Map<string, number>()),
  fetchOllamaLoadedContextWindows: vi.fn(async () => new Map<string, number>()),
}));
// The behaviour pins at the end of this file press Validate against a stubbed health check; the
// redaction test runs the real one over a stubbed adapter (the only thing that would reach the network).
// Only checkProviderHealth is stubbed: the model fetch and the Ollama check redact their failure
// text through the real safeFailureText of this module.
vi.mock('@/core/llm/healthCheck', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/llm/healthCheck')>()),
  checkProviderHealth: vi.fn(),
}));
import { checkProviderHealth } from '@/core/llm/healthCheck';
const { mockAdapterChat } = vi.hoisted(() => ({ mockAdapterChat: vi.fn() }));
vi.mock('@/core/llm/openai-compatible', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/llm/openai-compatible')>()),
  OpenAICompatibleAdapter: class {
    chat = mockAdapterChat;
  },
}));
import { classifyError } from '@/core/llm/adapter';
// 失败文字的测试运行真实的 fetchProviderModels 与 checkOllamaHealth，只替换发出网络请求的 fetch
const { mockTransportFetch } = vi.hoisted(() => ({ mockTransportFetch: vi.fn() }));
vi.mock('@/core/llm/tauriFetch', () => ({ getTauriFetch: async () => mockTransportFetch }));
// The real checkbox, counted: a model row renders one, so the count says which rows rendered again.
const checkboxRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('@/components/ds/checkbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/checkbox')>();
  return {
    Checkbox: (props: Parameters<typeof actual.Checkbox>[0]) => {
      checkboxRenders.count += 1;
      return <actual.Checkbox {...props} />;
    },
  };
});

// The real dialog and the real key field, with what each render handed them written down: the
// title and the unsaved-input flag the window gives its dialog, whether the content it hands over
// (shown or not) carries the made-up key anywhere, and the value the key field is rendered with.
const windowRenders = vi.hoisted(() => ({
  dialogs: [] as { title: unknown; dirty: unknown; holdsKey: boolean; holds: (text: string) => boolean }[],
  keys: [] as string[],
}));

// Is the text anywhere in this element tree: in a string child or in a string prop of an element?
// Only strings, lists and React elements are followed; refs, stores and other objects are not content.
function carriesText(node: unknown, text: string): boolean {
  if (typeof node === 'string') return node.includes(text);
  if (Array.isArray(node)) return node.some((child) => carriesText(child, text));
  if (node === null || typeof node !== 'object' || !('$$typeof' in node)) return false;
  const props = (node as { props?: Record<string, unknown> }).props ?? {};
  return Object.values(props).some((value) => carriesText(value, text));
}

vi.mock('@/components/ds/dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/dialog')>();
  return {
    ...actual,
    Dialog: (props: Parameters<typeof actual.Dialog>[0]) => {
      windowRenders.dialogs.push({
        title: props.title,
        dirty: props.dirty,
        holdsKey: carriesText([props.children, props.footer], 'sk-test-not-a-secret'),
        // Asked later, about the content this render handed over.
        holds: (text) => carriesText([props.children, props.footer], text),
      });
      return <actual.Dialog {...props} />;
    },
  };
});
vi.mock('@/components/settings/SecretField', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/settings/SecretField')>();
  return {
    default: (props: Parameters<typeof actual.default>[0]) => {
      windowRenders.keys.push(props.value);
      return <actual.default {...props} />;
    },
  };
});
// Only the unsaved-input tests let the window detect local models.
vi.mock('@/core/llm/ollama', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/llm/ollama')>();
  return { ...actual, checkOllamaHealth: vi.fn(), fetchOllamaModels: vi.fn() };
});
import { checkOllamaHealth, fetchOllamaModels } from '@/core/llm/ollama';

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out,
// until the test ends the animation.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

// The window that is fading out.
function closingWindow(): HTMLElement {
  const closing = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
  if (!closing) throw new Error('No window is closing');
  return closing;
}

// Ends the fade: the window leaves the page, and what it does once it has gone runs (one timer tick later).
function finishClosing() {
  vi.useFakeTimers();
  const ended = new Event('animationend', { bubbles: true });
  Object.defineProperty(ended, 'animationName', { value: 'exit' });
  act(() => { closingWindow().dispatchEvent(ended); });
  act(() => { vi.runOnlyPendingTimers(); });
  vi.useRealTimers();
}

beforeAll(() => {
  // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

// The window uses design-system layers (dialog, popovers, the confirmation), so it renders inside their provider.
function renderWindow(ui: ReactElement) {
  return render(ui, { wrapper: DesignSystemProvider });
}

// A dialog that is unmounted while open gives the focus back one timer tick later. Left pending,
// that tick lands in the next test and takes the focus out of a panel the test has just opened,
// which closes the panel. The fake clock runs the tick here, inside the test that caused it.
function unmountWindow() {
  vi.useFakeTimers();
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
}

// Opens the access-method list and picks one of its options.
async function choosePlan(label: string) {
  await userEvent.click(screen.getByRole('combobox', { name: getI18n().settings.configPlan }));
  await userEvent.click(screen.getByRole('option', { name: label }));
}

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
    unmountWindow();
  });

  it('prefills service name and API key from the provider being edited', () => {
    renderWindow(<AddProviderModal open={true} editProvider={builtinProvider} onClose={vi.fn()} />);

    expect(screen.getByDisplayValue('My DeepSeek')).toBeInTheDocument();
    const keyInput = document.querySelector('input[type="password"]') as HTMLInputElement | null;
    expect(keyInput?.value).toBe('sk-existing');
  });

  it('locks the provider selector into a read-only chip (not a clickable dropdown)', () => {
    renderWindow(<AddProviderModal open={true} editProvider={builtinProvider} onClose={vi.fn()} />);

    // The vendor name renders as static text, not inside a <button> (the
    // interactive add-mode dropdown trigger is a <button>).
    const chip = screen.getByText('DeepSeek');
    expect(chip.closest('button')).toBeNull();
  });

  it('does not render the read-only chip in add mode (no editProvider)', () => {
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);
    // Nothing is selected yet, so the interactive trigger shows the
    // placeholder text, not a vendor name — the dropdown is a <button>.
    const trigger = screen.getByRole('button', { name: /select provider/i });
    expect(trigger).toBeInTheDocument();
  });

  it('save routes through updateProvider with the edited provider id, not addProvider', () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), 'updateProvider');
    const addSpy = vi.spyOn(useSettingsStore.getState(), 'addProvider');
    const onClose = vi.fn();

    renderWindow(<AddProviderModal open={true} editProvider={builtinProvider} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateSpy).toHaveBeenCalledWith('deepseek', expect.objectContaining({
      name: 'My DeepSeek',
      apiKey: 'sk-existing',
    }));
    expect(addSpy).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a delete action that removes a custom provider via removeProvider', async () => {
    const removeSpy = vi.spyOn(useSettingsStore.getState(), 'removeProvider');
    const onClose = vi.fn();

    renderWindow(<AddProviderModal open={true} editProvider={customProvider} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /delete service/i }));
    // Confirm dialog
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });

    expect(removeSpy).toHaveBeenCalledWith('custom-abc123');
    expect(onClose).toHaveBeenCalled();
  });

  it('deleting a builtin provider disables it instead of removing it', async () => {
    const updateSpy = vi.spyOn(useSettingsStore.getState(), 'updateProvider');
    const onClose = vi.fn();

    renderWindow(<AddProviderModal open={true} editProvider={builtinProvider} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /delete service/i }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });

    expect(updateSpy).toHaveBeenCalledWith('deepseek', expect.objectContaining({
      enabled: false,
      apiKey: '',
      userAdded: false,
    }));
  });

  it('shows the API-key decrypt-failure warning when the key failed to decrypt', () => {
    useSettingsStore.setState({ failedSecretKeys: ['provider:deepseek'] });
    renderWindow(<AddProviderModal open={true} editProvider={builtinProvider} onClose={vi.fn()} />);
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
    unmountWindow();
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
    renderWindow(<AddProviderModal open={true} editProvider={provider} onClose={onClose} />);
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
    renderWindow(<AddProviderModal open={true} editProvider={provider} onClose={onClose} />);
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

    renderWindow(<AddProviderModal open={true} editProvider={provider} onClose={onClose} />);
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
    unmountWindow();
  });

  it('selecting the single custom entry shows a config-method dropdown with two format options', async () => {
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom API' }));

    // The old "not applicable for custom" greyed placeholder must be gone —
    // custom now gets a real, active config-method Select like a
    // multi-endpoint builtin.
    expect(screen.queryByText(/not applicable for custom/i)).not.toBeInTheDocument();

    // Defaults to the OpenAI-compatible plan.
    const planTrigger = screen.getByRole('combobox', { name: 'Access method' });
    expect(planTrigger).toHaveTextContent('OpenAI');
    await userEvent.click(planTrigger);
    expect(screen.getByRole('option', { name: 'Anthropic' })).toBeInTheDocument();
  });

  it('switching the custom format does not clear a typed API key, base URL, or selected models', async () => {
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);

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
    await choosePlan('Anthropic');

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

    renderWindow(<AddProviderModal open={true} editProvider={provider} onClose={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Access method' })).toHaveTextContent('Anthropic');
  });

  it('saving a new custom provider on the Anthropic format persists apiFormat "anthropic"', async () => {
    const addSpy = vi.spyOn(useSettingsStore.getState(), 'addProvider');
    const onClose = vi.fn();

    renderWindow(<AddProviderModal open={true} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom API' }));

    await choosePlan('Anthropic');

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
    unmountWindow();
  });

  it('stays disabled until a model is selected (built-in curated provider)', () => {
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);

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
    fireEvent.click(screen.getByRole('checkbox', { name: 'DeepSeek V4 Pro' }));

    expect(validateButton).not.toBeDisabled();
  });

  it('shows a failed validation without the key the endpoint echoed back', async () => {
    const fakeKey = 'sk-test-not-a-secret';
    // The real health check runs here; only the adapter under it is stubbed.
    const realHealthCheck = await vi.importActual<typeof import('@/core/llm/healthCheck')>('@/core/llm/healthCheck');
    vi.mocked(checkProviderHealth).mockImplementation(realHealthCheck.checkProviderHealth);
    mockAdapterChat.mockRejectedValue(
      classifyError(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${fakeKey}` } })),
    );
    try {
      renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
      fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
      const apiKeyInput = document.querySelector('input[type="password"]') as HTMLInputElement;
      fireEvent.change(apiKeyInput, { target: { value: fakeKey } });
      fireEvent.click(screen.getByRole('button', { name: /select model/i }));
      fireEvent.click(screen.getByRole('checkbox', { name: 'DeepSeek V4 Pro' }));
      fireEvent.click(screen.getByRole('button', { name: /validate connection/i }));

      expect(await screen.findByText('Incorrect API key provided: [REDACTED]')).toBeInTheDocument();
      expect(mockAdapterChat).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).not.toContain(fakeKey);
      for (const attribute of ['title', 'aria-label']) {
        const values = Array.from(document.querySelectorAll(`[${attribute}]`), (el) => el.getAttribute(attribute));
        expect(values.join('\n')).not.toContain(fakeKey);
      }
    } finally {
      vi.mocked(checkProviderHealth).mockReset();
      mockAdapterChat.mockReset();
    }
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
    unmountWindow();
  });

  it('switches the endpoint and curated models to Beijing pay-as-you-go', async () => {
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Alibaba Bailian' }));
    expect(screen.getByText(/three key types are not interchangeable/i)).toBeInTheDocument();

    // Token Plan remains the recommended default; pay-as-you-go is an
    // explicit last-tier choice because its API key is not interchangeable.
    expect(screen.getByRole('combobox', { name: 'Access method' })).toHaveTextContent('Token Plan');
    await choosePlan('Pay-as-you-go (Beijing)');

    // The fixed address of a built-in provider is text that wraps, so a long one shows in full;
    // a field would cut it off at its right edge.
    const address = screen.getByText('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(address.tagName).toBe('P');
    expect(address).toHaveClass('break-all');
    expect(address).toHaveClass('select-all');
    expect(screen.queryByDisplayValue('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBeNull();
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
    unmountWindow();
  });

  it('shows the row (no input) by default, reveals the input on click, and adds a custom model that collapses back', () => {
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);

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
    unmountWindow();
    vi.mocked(fetchProviderModels).mockReset();
  });

  /** Render in edit mode (prefills provider + baseUrl, skipping the portal
   *  dropdown) and click Fetch Models; resolves once the list has rendered. */
  async function renderAndFetch() {
    renderWindow(<AddProviderModal open={true} editProvider={savedProvider} onClose={vi.fn()} />);
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

    renderWindow(<AddProviderModal open={true} editProvider={lmstudio} onClose={vi.fn()} />);
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

describe('AddProviderModal — curated provider fetch', () => {
  // DeepSeek ships a curated list of exactly these two.
  // Read the shipped list rather than restating it: hardcoding the ids made
  // this suite fail the moment DeepSeek's curated list gained a model, which is
  // a config change, not a regression in what these tests are about.
  const CURATED = PROVIDER_CONFIGS.deepseek.models.map((m) => m.id);
  // What a live fetch returns: the curated pair plus 8 ids we never shipped —
  // enough rows to cross MODEL_FILTER_MIN_ITEMS so the dropdown grows its
  // search + counter header.
  const FETCHED_ONLY = [
    'deepseek-v5-preview', 'deepseek-chat', 'deepseek-reasoner', 'deepseek-coder',
    'deepseek-v4-pro-thinking', 'deepseek-v4-lite', 'deepseek-math', 'deepseek-vl',
  ];
  const FETCHED = [...CURATED, ...FETCHED_ONLY];
  const TOTAL_ROWS = CURATED.length + FETCHED_ONLY.length;

  const curatedProvider: ProviderInstance = {
    id: 'deepseek',
    source: 'builtin',
    name: 'DeepSeek',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-ds',
    models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' }],
    status: 'unchecked',
    sortOrder: 0,
    userAdded: true,
  };

  const anthropicProvider: ProviderInstance = {
    ...curatedProvider,
    id: 'anthropic',
    name: 'Anthropic',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    models: [],
  };

  beforeEach(() => {
    setLanguage('en-US');
    useSettingsStore.setState({ providers: [curatedProvider], failedSecretKeys: [] });
    vi.mocked(fetchProviderModels).mockResolvedValue({
      success: true,
      models: FETCHED.map((id) => ({ id, label: id })),
    });
  });

  afterEach(() => {
    unmountWindow();
    vi.mocked(fetchProviderModels).mockReset();
  });

  async function renderAndFetch(provider: ProviderInstance = curatedProvider) {
    renderWindow(<AddProviderModal open={true} editProvider={provider} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));
    await screen.findByText(`Found ${FETCHED.length} models`);
  }

  it('offers a fetch button on a curated built-in (it used to be hidden — static list only)', () => {
    renderWindow(<AddProviderModal open={true} editProvider={curatedProvider} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /fetch models/i })).toBeInTheDocument();
  });

  it('offers it on an anthropic-format provider too (previously excluded outright)', () => {
    useSettingsStore.setState({ providers: [anthropicProvider], failedSecretKeys: [] });
    renderWindow(<AddProviderModal open={true} editProvider={anthropicProvider} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: /fetch models/i })).toBeInTheDocument();
  });

  it('merges fetched-only ids into the curated dropdown', async () => {
    await renderAndFetch();

    // The dropdown opens itself on success — no second click needed.
    expect(await screen.findByText('deepseek-v5-preview')).toBeInTheDocument();
    for (const id of FETCHED_ONLY) {
      expect(screen.getByText(id)).toBeInTheDocument();
    }
  });

  it('does not label where a row came from — provenance is plumbing, not UI', async () => {
    await renderAndFetch();
    await screen.findByText('deepseek-v5-preview');

    expect(screen.queryByText('from API')).not.toBeInTheDocument();
    expect(screen.queryByText('来自接口')).not.toBeInTheDocument();
  });

  /** A saved provider on one of Volcengine's three tiers (matched by baseUrl). */
  function arkOnTier(baseUrl: string): ProviderInstance {
    return { ...curatedProvider, id: 'volcengine', name: '火山引擎', baseUrl, models: [] };
  }

  it.each([
    ['Agent Plan (measured: empty-bodied 404)', 'https://ark.cn-beijing.volces.com/api/plan/v3'],
    ['Coding Plan (same subscription host family)', 'https://ark.cn-beijing.volces.com/api/coding/v3'],
  ])('hides the fetch button on Volcengine %s', (_label, baseUrl) => {
    const ark = arkOnTier(baseUrl);
    useSettingsStore.setState({ providers: [ark], failedSecretKeys: [] });

    renderWindow(<AddProviderModal open={true} editProvider={ark} onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /fetch models/i })).not.toBeInTheDocument();
  });

  it('keeps the fetch button on Volcengine pay-as-you-go — a different, unmeasured host', () => {
    // The per-tier flag exists precisely so one measured tier does not silently
    // disable a sibling that was never tested.
    const ark = arkOnTier('https://ark.cn-beijing.volces.com/api/v3');
    useSettingsStore.setState({ providers: [ark], failedSecretKeys: [] });

    renderWindow(<AddProviderModal open={true} editProvider={ark} onClose={vi.fn()} />);

    expect(screen.getByRole('button', { name: /fetch models/i })).toBeInTheDocument();
  });

  it('pre-checks nothing it fetched — only the provider\'s saved model stays selected', async () => {
    await renderAndFetch();

    expect(await screen.findByText(`1 of ${TOTAL_ROWS} selected`)).toBeInTheDocument();
  });

  it('searching inside the dropdown narrows the merged list', async () => {
    await renderAndFetch();
    await screen.findByText('deepseek-v5-preview');

    fireEvent.change(screen.getByPlaceholderText('Search models…'), { target: { value: 'reasoner' } });

    await waitFor(() => expect(screen.queryByText('deepseek-v5-preview')).not.toBeInTheDocument());
    expect(screen.getByText('deepseek-reasoner')).toBeInTheDocument();
  });

  it('"Select all" in the dropdown applies to the search results only', async () => {
    await renderAndFetch();
    await screen.findByText('deepseek-v5-preview');

    const query = 'deepseek-v4';
    fireEvent.change(screen.getByPlaceholderText('Search models…'), { target: { value: query } });
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));

    // Everything matching the query ends up selected — and nothing else. The
    // expected count is derived, not restated, so it tracks the shipped list.
    const matching = [...CURATED, ...FETCHED_ONLY].filter((id) => id.includes(query));
    await screen.findByText(`${matching.length} of ${TOTAL_ROWS} selected`);
  });
});

// ── Behaviour pins: what the window does to the store, to the health check and to its key
// field. Every store action writes into one log, so a test reads the calls and their order.
// `ui` is the only place that knows how a control is found. ──

// A made-up value. Nothing here is a real credential.
const FAKE_KEY = 'sk-test-not-a-secret';
const t = () => getI18n();

// Everywhere the key could be read on the page, apart from the value of the input it was typed into.
function keyOutsideItsInput(): string[] {
  const hits: string[] = [];
  if ((document.body.textContent ?? '').includes(FAKE_KEY)) hits.push('text');
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (element instanceof HTMLInputElement && attribute.name === 'value') continue;
      if (attribute.value.includes(FAKE_KEY)) hits.push(`${element.tagName.toLowerCase()}[${attribute.name}]`);
    }
  }
  return hits;
}

const ui = {
  // The panel gives the focus back to its button one timer tick after it closes. The fake clock
  // runs that tick here; left pending, it would take the focus out of a panel opened right after
  // and close it at a moment that depends on the machine.
  pickProvider(name: string) {
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: t().settings.selectProviderType }));
    fireEvent.click(screen.getByRole('button', { name }));
    act(() => { vi.runOnlyPendingTimers(); });
    vi.useRealTimers();
  },
  keyInput: () => screen.getByPlaceholderText('sk-...') as HTMLInputElement,
  nameInput: () => screen.getByPlaceholderText(t().settings.serviceNameAuto) as HTMLInputElement,
  urlInput: () => screen.getByPlaceholderText('https://...') as HTMLInputElement,
  toggleKey() {
    const shown = ui.keyInput().type === 'text';
    fireEvent.click(screen.getByRole('button', { name: shown ? t().settings.secretHide : t().settings.secretShow }));
  },
  pickCuratedModel(label: string) {
    fireEvent.click(screen.getByRole('button', { name: t().settings.selectModel }));
    fireEvent.click(screen.getByRole('checkbox', { name: label }));
  },
  addManualModel(id: string) {
    fireEvent.click(screen.getByRole('button', { name: t().settings.addModel }));
    const input = screen.getByPlaceholderText(t().settings.addModelPlaceholder);
    fireEvent.change(input, { target: { value: id } });
    fireEvent.keyDown(input, { key: 'Enter' });
  },
  save() {
    fireEvent.click(screen.getByRole('button', { name: t().settings.save }));
  },
  // The window's own Cancel is the last one: the field for typing a model id has a small one before it.
  cancel() {
    fireEvent.click(screen.getAllByRole('button', { name: t().common.cancel }).at(-1)!);
  },
  corner() {
    fireEvent.click(screen.getByRole('button', { name: t().common.close }));
  },
  // The question that Escape, Cancel, the corner button and a click outside ask once something was typed.
  discardQuestion: () => screen.queryByRole('alertdialog', { name: t().designSystem.discardTitle }),
  discard() {
    fireEvent.click(screen.getByRole('button', { name: t().designSystem.discard }));
  },
  keepEditing() {
    fireEvent.click(screen.getByRole('button', { name: t().designSystem.keepEditing }));
  },
  askToDelete() {
    fireEvent.click(screen.getByRole('button', { name: t().settings.deleteService }));
  },
  // The code after the answer runs once the confirmation's promise has settled.
  async answerDelete(confirmed: boolean) {
    const name = confirmed ? t().common.confirm : t().common.cancel;
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name }).at(-1)!); });
  },
  validate() {
    fireEvent.click(screen.getByRole('button', { name: t().settings.validateConnection }));
  },
};

describe('AddProviderModal — behaviour pins', () => {
  const RECORDED = ['addProvider', 'updateProvider', 'removeProvider', 'selectModel'] as const;
  type Action = (...values: unknown[]) => unknown;
  const log: unknown[][] = [];
  const returned: unknown[] = [];
  let originals: Record<string, unknown> = {};

  const seededDeepSeek: ProviderInstance = {
    id: 'deepseek',
    source: 'builtin',
    name: 'DeepSeek',
    enabled: false,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    models: PROVIDER_CONFIGS.deepseek.models.map((m) => ({ id: m.id, label: m.label })),
    status: 'unchecked',
    sortOrder: 4,
    userAdded: false,
  };

  const ownA: ProviderInstance = {
    id: 'own-a',
    source: 'custom',
    name: 'Service A',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1',
    apiKey: FAKE_KEY,
    models: [{ id: 'model-a', label: 'Model A' }, { id: 'model-a2', label: 'Model A2' }],
    status: 'verified',
    sortOrder: 2,
    userAdded: true,
  };

  const ownB: ProviderInstance = {
    ...ownA,
    id: 'own-b',
    name: 'Service B',
    models: [{ id: 'model-b', label: 'Model B' }],
    sortOrder: 1,
  };

  function seed(providers: ProviderInstance[], activeProviderId = '') {
    const active = providers.find((p) => p.id === activeProviderId);
    useSettingsStore.setState({ providers, activeModel: { providerId: activeProviderId, modelId: active?.models[0]?.id ?? '' } });
    log.length = 0;
    returned.length = 0;
  }

  function open(editProvider?: ProviderInstance) {
    const onClose = vi.fn();
    const view = render(<AddProviderModal open={true} editProvider={editProvider} onClose={onClose} />, { wrapper: DesignSystemProvider });
    const close = () => view.rerender(<AddProviderModal open={false} onClose={onClose} />);
    const show = () => view.rerender(<AddProviderModal open={true} onClose={onClose} />);
    const reopen = () => {
      close();
      show();
    };
    return { onClose, reopen, close, show };
  }

  beforeEach(() => {
    setLanguage('en-US');
    vi.mocked(checkProviderHealth).mockReset();
    const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
    originals = Object.fromEntries(RECORDED.map((name) => [name, state[name]]));
    const recorded = Object.fromEntries(RECORDED.map((name) => [name, (...args: unknown[]) => {
      log.push([name, ...args]);
      const result = (originals[name] as Action)(...args);
      returned.push(result);
      return result;
    }]));
    useSettingsStore.setState({ ...recorded, failedSecretKeys: [], secretWriteFailedKeys: [] });
    seed([]);
  });

  afterEach(() => {
    unmountWindow();
    useSettingsStore.setState(originals);
  });

  describe('the key field', () => {
    it('is masked until the user asks to see it', () => {
      open();
      ui.pickProvider('DeepSeek');
      fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });

      expect(ui.keyInput().type).toBe('password');
      ui.toggleKey();
      expect(ui.keyInput().type).toBe('text');
      ui.toggleKey();
      expect(ui.keyInput().type).toBe('password');
    });

    it('is masked again when another provider is picked, and empty', () => {
      open();
      ui.pickProvider('DeepSeek');
      fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });
      ui.toggleKey();
      expect(ui.keyInput().type).toBe('text');

      fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
      fireEvent.click(screen.getByRole('button', { name: 'OpenAI' }));

      expect(ui.keyInput().type).toBe('password');
      expect(ui.keyInput().value).toBe('');
    });

    it('cannot be typed into before a provider is picked', () => {
      open();
      expect(ui.keyInput()).toBeDisabled();
    });

    it.each(['Ollama', 'LM Studio'])('is replaced by words for the local provider %s', (name) => {
      open();
      ui.pickProvider(name);

      expect(screen.queryByPlaceholderText('sk-...')).not.toBeInTheDocument();
      expect(screen.getByText(t().settings.localNoKeyNeeded)).toBeInTheDocument();
    });

    it('holds the key as its value and shows it nowhere else, masked or not', () => {
      open();
      ui.pickProvider('DeepSeek');
      fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });

      expect(ui.keyInput().value).toBe(FAKE_KEY);
      expect(keyOutsideItsInput()).toEqual([]);
      ui.toggleKey();
      expect(keyOutsideItsInput()).toEqual([]);
    });

    it('shows the saved key of the provider being edited only as the value of the masked field', () => {
      seed([ownA]);
      open(ownA);

      expect(ui.keyInput().type).toBe('password');
      expect(ui.keyInput().value).toBe(FAKE_KEY);
      expect(keyOutsideItsInput()).toEqual([]);
    });
  });

  describe('saving', () => {
    it('adds a built-in provider by switching on its seeded entry, then makes its first model the one in use', () => {
      seed([seededDeepSeek]);
      const { onClose } = open();
      ui.pickProvider('DeepSeek');
      fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });
      ui.pickCuratedModel('DeepSeek V4 Pro');
      ui.save();

      expect(log).toEqual([
        ['updateProvider', 'deepseek', {
          name: 'DeepSeek',
          enabled: true,
          apiKey: FAKE_KEY,
          baseUrl: 'https://api.deepseek.com',
          apiFormat: 'openai-compatible',
          models: [toModelInfo('deepseek-v4-pro')],
          capabilities: undefined,
          userAdded: true,
          declaredCapabilities: undefined,
          sortOrder: 5,
        }],
        ['selectModel', 'deepseek', 'deepseek-v4-pro'],
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('adds a custom provider with its name, key, address, models and declared abilities', () => {
      const { onClose } = open();
      ui.pickProvider(t().settings.customApi);
      fireEvent.change(ui.nameInput(), { target: { value: 'Gateway' } });
      fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });
      fireEvent.change(ui.urlInput(), { target: { value: 'https://gateway.example.test/v1' } });
      ui.addManualModel('model-x');
      ui.save();

      expect(log).toEqual([
        ['addProvider', {
          source: 'custom',
          name: 'Gateway',
          enabled: true,
          apiFormat: 'openai-compatible',
          baseUrl: 'https://gateway.example.test/v1',
          apiKey: FAKE_KEY,
          models: [toModelInfo('model-x', { declaredCapabilities: defaultModelDeclaredCapabilities('model-x') })],
          capabilities: undefined,
          userAdded: true,
          declaredCapabilities: { useRawUrl: false },
        }],
        ['selectModel', returned[0], 'model-x'],
      ]);
      expect(typeof returned[0]).toBe('string');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('edits a provider through updateProvider alone: no new entry, the model in use untouched', () => {
      seed([ownA, ownB], 'own-b');
      const { onClose } = open(ownA);
      fireEvent.change(ui.nameInput(), { target: { value: 'Service A renamed' } });
      fireEvent.change(ui.keyInput(), { target: { value: `${FAKE_KEY}-2` } });
      ui.save();

      expect(log).toEqual([
        ['updateProvider', 'own-a', {
          name: 'Service A renamed',
          apiKey: `${FAKE_KEY}-2`,
          baseUrl: 'https://models.example.test/v1',
          apiFormat: 'openai-compatible',
          models: [toModelInfo('model-a'), toModelInfo('model-a2')],
          capabilities: undefined,
          userAdded: true,
          declaredCapabilities: { useRawUrl: false },
        }],
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('does nothing without a name or without a model', () => {
      const { onClose } = open();
      ui.pickProvider('DeepSeek');

      expect(screen.getByRole('button', { name: t().settings.save })).toBeDisabled();
      ui.save();
      expect(log).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('opens empty the next time', () => {
      const { onClose, reopen } = open();
      ui.pickProvider(t().settings.customApi);
      fireEvent.change(ui.nameInput(), { target: { value: 'Gateway' } });
      fireEvent.change(ui.urlInput(), { target: { value: 'https://gateway.example.test/v1' } });
      ui.addManualModel('model-x');
      ui.save();
      expect(onClose).toHaveBeenCalledTimes(1);

      reopen();

      expect(ui.nameInput().value).toBe('');
      expect(screen.getByRole('button', { name: t().settings.selectProviderType })).toBeInTheDocument();
      expect(screen.queryByText('model-x')).not.toBeInTheDocument();
    });
  });

  describe('closing', () => {
    it('closes from Cancel without touching the store', () => {
      const { onClose } = open();
      ui.cancel();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(log).toEqual([]);
    });

    it('closes from the button in the corner without touching the store', () => {
      const { onClose } = open();
      ui.corner();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(log).toEqual([]);
    });

    it('opens empty after a half-filled form was closed', () => {
      const { onClose, reopen } = open();
      ui.pickProvider('DeepSeek');
      fireEvent.change(ui.nameInput(), { target: { value: 'Half typed' } });
      fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });
      ui.cancel();
      ui.discard();
      expect(onClose).toHaveBeenCalledTimes(1);

      reopen();

      expect(ui.nameInput().value).toBe('');
      expect(ui.keyInput().value).toBe('');
      expect(screen.getByRole('button', { name: t().settings.selectProviderType })).toBeInTheDocument();
      expect(log).toEqual([]);
    });
  });

  describe('deleting from the edit window', () => {
    it('touches nothing until the question is answered', () => {
      seed([ownA, ownB], 'own-a');
      const { onClose } = open(ownA);
      ui.askToDelete();

      expect(log).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('touches nothing when the answer is Cancel', async () => {
      seed([ownA, ownB], 'own-a');
      const { onClose } = open(ownA);
      ui.askToDelete();
      await ui.answerDelete(false);

      expect(log).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().providers.map((p) => p.id)).toEqual(['own-a', 'own-b']);
    });

    it('removes a custom provider and hands the one in use to the next enabled provider', async () => {
      seed([ownA, ownB], 'own-a');
      const { onClose } = open(ownA);
      ui.askToDelete();
      await ui.answerDelete(true);

      expect(log).toEqual([
        ['removeProvider', 'own-a'],
        ['selectModel', 'own-b', 'model-b'],
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('removes a custom provider that is not the one in use with one call', async () => {
      seed([ownA, ownB], 'own-b');
      const { onClose } = open(ownA);
      ui.askToDelete();
      await ui.answerDelete(true);

      expect(log).toEqual([['removeProvider', 'own-a']]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('switches a built-in provider off and clears its key instead of removing it', async () => {
      const deepSeek: ProviderInstance = { ...seededDeepSeek, enabled: true, apiKey: FAKE_KEY, userAdded: true };
      seed([deepSeek, ownB], 'own-b');
      const { onClose } = open(deepSeek);
      ui.askToDelete();
      await ui.answerDelete(true);

      expect(log).toEqual([
        ['updateProvider', 'deepseek', { enabled: false, apiKey: '', status: 'unchecked', userAdded: false }],
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('names the provider in the question, worded like the question on its card', () => {
      seed([ownA, ownB], 'own-a');
      open(ownA);
      ui.askToDelete();

      const ask = screen.getByRole('alertdialog', { name: t().settings.deleteProviderConfirm });
      expect(ask).toHaveTextContent('Service A');
      expect(keyOutsideItsInput()).toEqual([]);
    });

    it('does nothing when the provider has gone by the time the answer comes', async () => {
      seed([ownA, ownB], 'own-a');
      const { onClose } = open(ownA);
      ui.askToDelete();
      act(() => { useSettingsStore.setState({ providers: [ownB] }); });
      await ui.answerDelete(true);

      expect(log).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('deletes the provider as it is when the answer comes: the one in use by then hands over', async () => {
      seed([ownA, ownB], 'own-b');
      const { onClose } = open(ownA);
      ui.askToDelete();
      act(() => { useSettingsStore.setState({ activeModel: { providerId: 'own-a', modelId: 'model-a' } }); });
      await ui.answerDelete(true);

      expect(log).toEqual([
        ['removeProvider', 'own-a'],
        ['selectModel', 'own-b', 'model-b'],
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('the window itself', () => {
    // The models page: it closes the window when the window asks to be closed.
    function Page({ editProvider, onClose }: { editProvider?: ProviderInstance; onClose: () => void }) {
      const [shown, setShown] = useState(true);
      return <AddProviderModal open={shown} editProvider={shown ? editProvider : undefined} onClose={() => { onClose(); setShown(false); }} />;
    }

    function openOnPage(editProvider?: ProviderInstance) {
      const onClose = vi.fn();
      render(<Page editProvider={editProvider} onClose={onClose} />, { wrapper: DesignSystemProvider });
      return { onClose };
    }

    it('is a dialog named after adding', () => {
      open();
      expect(screen.getByRole('dialog', { name: t().settings.addService })).toBeInTheDocument();
    });

    it('is a dialog named after editing', () => {
      seed([ownA]);
      open(ownA);
      expect(screen.getByRole('dialog', { name: t().settings.editService })).toBeInTheDocument();
    });

    it('has one filled button', () => {
      seed([ownA]);
      open(ownA);
      const filled = screen.getAllByRole('button').filter((button) => button.className.split(' ').includes('bg-emphasis'));
      expect(filled.map((button) => button.textContent)).toEqual([t().settings.save]);
    });

    it('closes on Escape when nothing was typed', async () => {
      const { onClose } = openOnPage();
      await userEvent.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(ui.discardQuestion()).not.toBeInTheDocument();
    });

    it('closes an untouched edit window on Escape without a question', async () => {
      seed([ownA]);
      const { onClose } = openOnPage(ownA);
      await userEvent.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(ui.discardQuestion()).not.toBeInTheDocument();
    });

    it('asks before discarding what was typed: keeping it keeps every field, discarding closes', async () => {
      const { onClose } = openOnPage();
      ui.pickProvider('DeepSeek');
      fireEvent.change(ui.nameInput(), { target: { value: 'Half typed' } });
      fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });
      await userEvent.keyboard('{Escape}');

      expect(ui.discardQuestion()).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();

      ui.keepEditing();
      expect(ui.discardQuestion()).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(ui.nameInput().value).toBe('Half typed');
      expect(ui.keyInput().value).toBe(FAKE_KEY);

      await userEvent.keyboard('{Escape}');
      ui.discard();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(log).toEqual([]);
    });

    it('asks the same question from Cancel and from the corner button', () => {
      const { onClose } = openOnPage();
      ui.pickProvider('DeepSeek');

      ui.cancel();
      expect(ui.discardQuestion()).toBeInTheDocument();
      ui.keepEditing();
      ui.corner();
      expect(ui.discardQuestion()).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('asks about an edit window once a field differs from the saved provider, and no longer when it is typed back', async () => {
      seed([ownA]);
      const { onClose } = openOnPage(ownA);
      fireEvent.change(ui.nameInput(), { target: { value: 'Service A renamed' } });
      await userEvent.keyboard('{Escape}');
      expect(ui.discardQuestion()).toBeInTheDocument();
      ui.keepEditing();

      fireEvent.change(ui.nameInput(), { target: { value: 'Service A' } });
      await userEvent.keyboard('{Escape}');
      expect(ui.discardQuestion()).not.toBeInTheDocument();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes without a question after a save', () => {
      const { onClose } = openOnPage();
      ui.pickProvider(t().settings.customApi);
      fireEvent.change(ui.urlInput(), { target: { value: 'https://gateway.example.test/v1' } });
      ui.addManualModel('model-x');
      ui.save();

      expect(log.map(([name]) => name)).toEqual(['addProvider', 'selectModel']);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(ui.discardQuestion()).not.toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('has nothing left to discard after a save even when the page keeps it open', async () => {
      const { onClose } = open();
      ui.pickProvider(t().settings.customApi);
      fireEvent.change(ui.urlInput(), { target: { value: 'https://gateway.example.test/v1' } });
      ui.addManualModel('model-x');
      ui.save();
      expect(onClose).toHaveBeenCalledTimes(1);

      await userEvent.keyboard('{Escape}');
      expect(ui.discardQuestion()).not.toBeInTheDocument();
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('closes only the access-method list on Escape', async () => {
      const { onClose } = openOnPage();
      ui.pickProvider(t().settings.customApi);
      await userEvent.click(screen.getByRole('combobox', { name: t().settings.configPlan }));
      expect(screen.getByRole('listbox')).toBeInTheDocument();

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: t().settings.addService })).toBeInTheDocument();
      expect(ui.discardQuestion()).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes only the provider panel on Escape, and picks nothing', async () => {
      const { onClose } = openOnPage();
      fireEvent.click(screen.getByRole('button', { name: t().settings.selectProviderType }));
      expect(screen.getByPlaceholderText(t().settings.searchProvider)).toBeInTheDocument();

      await userEvent.keyboard('{ArrowDown}{ArrowDown}{Escape}');

      expect(screen.queryByPlaceholderText(t().settings.searchProvider)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: t().settings.selectProviderType })).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: t().settings.addService })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('closes only the model panel on Escape, and its other-model field with it', async () => {
      const { onClose } = openOnPage();
      ui.pickProvider('DeepSeek');
      fireEvent.click(screen.getByRole('button', { name: t().settings.selectModel }));
      fireEvent.click(screen.getByText(t().settings.useOtherModel));
      expect(screen.getByPlaceholderText(t().settings.addModelPlaceholder)).toBeInTheDocument();

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: t().settings.addService })).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: t().settings.selectModel }));
      expect(screen.queryByPlaceholderText(t().settings.addModelPlaceholder)).not.toBeInTheDocument();
      expect(screen.getByText(t().settings.useOtherModel)).toBeInTheDocument();
    });
  });

  describe('while the window fades out, and once it has gone', () => {
    let computedStyle: ReturnType<typeof keepClosingLayersOnScreen>;

    beforeEach(() => {
      computedStyle = keepClosingLayersOnScreen();
    });

    afterEach(() => {
      computedStyle.mockRestore();
    });

    // The models page: it closes the window and forgets the edited provider in one update, and can open it again.
    function Page({ editProvider, keepProvider = false, onClose }: { editProvider?: ProviderInstance; keepProvider?: boolean; onClose: () => void }) {
      const [shown, setShown] = useState(true);
      const [editing, setEditing] = useState(editProvider);
      return (
        <>
          <Button onClick={() => setShown(true)}>Open again</Button>
          <AddProviderModal
            open={shown}
            editProvider={editing}
            onClose={() => {
              onClose();
              setShown(false);
              if (!keepProvider) setEditing(undefined);
            }}
          />
        </>
      );
    }

    function openOnPage(editProvider?: ProviderInstance, keepProvider = false) {
      const onClose = vi.fn();
      render(<Page editProvider={editProvider} keepProvider={keepProvider} onClose={onClose} />, { wrapper: DesignSystemProvider });
      return { onClose };
    }

    const titlesOfThisWindow = () => windowRenders.dialogs
      .map((dialog) => dialog.title)
      .filter((title) => title === t().settings.addService || title === t().settings.editService);

    it('saves once when Save is pressed again during the fade', () => {
      const { onClose } = openOnPage();
      ui.pickProvider(t().settings.customApi);
      fireEvent.change(ui.urlInput(), { target: { value: 'https://gateway.example.test/v1' } });
      ui.addManualModel('model-x');
      ui.save();
      expect(closingWindow()).toBeInTheDocument();

      ui.save();

      expect(log.map(([name]) => name)).toEqual(['addProvider', 'selectModel']);
      expect(useSettingsStore.getState().providers).toHaveLength(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('asks nothing when Delete is pressed during the fade', () => {
      seed([ownA, ownB], 'own-b');
      const { onClose } = openOnPage(ownA, true);
      ui.cancel();
      expect(closingWindow()).toBeInTheDocument();

      ui.askToDelete();

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(log).toEqual([]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('keeps showing the provider and what the form held during the fade', () => {
      seed([ownA, ownB], 'own-b');
      openOnPage(ownA);
      ui.cancel();

      const closing = closingWindow();
      expect(closing).toHaveTextContent(t().settings.editService);
      expect(closing).not.toHaveTextContent(t().settings.addService);
      expect(ui.nameInput().value).toBe('Service A');
      expect(ui.keyInput().value).toBe(FAKE_KEY);
      expect(screen.getByRole('button', { name: t().settings.deleteService })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t().settings.selectProviderType })).not.toBeInTheDocument();
    });

    it('forgets the provider and the form once it has gone, so the next opening starts empty', () => {
      seed([ownA, ownB], 'own-b');
      openOnPage(ownA);
      fireEvent.change(ui.nameInput(), { target: { value: 'Service A renamed' } });
      ui.cancel();
      ui.discard();
      // Fading out, it still holds the form, key included.
      expect(windowRenders.dialogs.at(-1)).toMatchObject({ title: t().settings.editService, holdsKey: true });
      finishClosing();

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      // Gone, it holds neither the provider it edited nor the key.
      expect(windowRenders.dialogs.at(-1)).toMatchObject({ title: t().settings.addService, holdsKey: false });

      windowRenders.dialogs.length = 0;
      windowRenders.keys.length = 0;
      fireEvent.click(screen.getByText('Open again'));

      // No render of the new window was handed the old key, and none of them had anything to discard.
      expect(windowRenders.keys.length).toBeGreaterThan(0);
      expect(windowRenders.keys.filter((value) => value !== '')).toEqual([]);
      expect(windowRenders.dialogs.length).toBeGreaterThan(0);
      expect(windowRenders.dialogs.filter((dialog) => dialog.dirty)).toEqual([]);
      expect(titlesOfThisWindow()).not.toContain(t().settings.editService);
      expect(ui.nameInput().value).toBe('');
      expect(screen.getByRole('button', { name: t().settings.selectProviderType })).toBeInTheDocument();
    });

    it('forgets a deleted provider once the window has gone', async () => {
      seed([ownA, ownB], 'own-b');
      const { onClose } = openOnPage(ownA);
      ui.askToDelete();
      await ui.answerDelete(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(closingWindow()).toHaveTextContent(t().settings.editService);

      finishClosing();

      expect(windowRenders.dialogs.at(-1)).toMatchObject({ title: t().settings.addService, holdsKey: false });
      windowRenders.keys.length = 0;
      fireEvent.click(screen.getByText('Open again'));
      expect(windowRenders.keys.filter((value) => value !== '')).toEqual([]);
    });
  });

  describe('unsaved input after a fetch or a detection', () => {
    // The models page: it closes the window when the window asks to be closed.
    function Page({ editProvider, onClose }: { editProvider: ProviderInstance; onClose: () => void }) {
      const [shown, setShown] = useState(true);
      return <AddProviderModal open={shown} editProvider={shown ? editProvider : undefined} onClose={() => { onClose(); setShown(false); }} />;
    }

    function openOnPage(editProvider: ProviderInstance) {
      seed([editProvider]);
      const onClose = vi.fn();
      render(<Page editProvider={editProvider} onClose={onClose} />, { wrapper: DesignSystemProvider });
      return { onClose };
    }

    // Saved before the window stored abilities with each model: its models carry none.
    const ollama: ProviderInstance = {
      id: 'ollama',
      source: 'builtin',
      name: 'Ollama',
      enabled: true,
      apiFormat: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      models: [{ id: 'llama-a', label: 'llama-a' }, { id: 'llama-b', label: 'llama-b' }],
      status: 'verified',
      sortOrder: 0,
      userAdded: true,
    };

    function detects(names: string[]) {
      vi.mocked(checkOllamaHealth).mockResolvedValue({ ok: true });
      vi.mocked(fetchOllamaModels).mockResolvedValue(names.map((name) => ({ name, details: {} })) as Awaited<ReturnType<typeof fetchOllamaModels>>);
    }

    async function blurAddress() {
      await act(async () => { fireEvent.blur(screen.getByPlaceholderText('http://127.0.0.1:11434')); });
    }

    afterEach(() => {
      vi.mocked(fetchProviderModels).mockReset();
      vi.mocked(checkOllamaHealth).mockReset();
      vi.mocked(fetchOllamaModels).mockReset();
    });

    it('has nothing to discard after fetching models and ticking none', async () => {
      vi.mocked(fetchProviderModels).mockResolvedValue({
        success: true,
        models: ['model-a', 'model-a2', 'model-new'].map((id) => ({ id, label: id })),
      });
      const { onClose } = openOnPage(ownA);
      fireEvent.click(screen.getByRole('button', { name: t().settings.fetchModels }));
      await screen.findByText(t().settings.fetchModelsSuccess.replace('{count}', '3'));

      await userEvent.keyboard('{Escape}');

      expect(ui.discardQuestion()).not.toBeInTheDocument();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('has nothing to discard after a detection that found the saved models again', async () => {
      detects(['llama-a', 'llama-b']);
      const { onClose } = openOnPage(ollama);
      await blurAddress();
      expect(vi.mocked(fetchOllamaModels)).toHaveBeenCalledTimes(1);

      await userEvent.keyboard('{Escape}');

      expect(ui.discardQuestion()).not.toBeInTheDocument();
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('asks before discarding a model that a detection added to the selection', async () => {
      detects(['llama-a', 'llama-b', 'llama-c']);
      const { onClose } = openOnPage(ollama);
      await blurAddress();
      expect(screen.getByText('llama-c')).toBeInTheDocument();

      await userEvent.keyboard('{Escape}');

      expect(ui.discardQuestion()).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('asks once an ability of a model was changed, also after a fetch', async () => {
      vi.mocked(fetchProviderModels).mockResolvedValue({ success: true, models: [{ id: 'model-a', label: 'model-a' }] });
      const { onClose } = openOnPage(ownA);
      fireEvent.click(screen.getByRole('button', { name: t().settings.fetchModels }));
      await screen.findByText(t().settings.fetchModelsSuccess.replace('{count}', '1'));
      fireEvent.click(screen.getAllByRole('button', { name: t().settings.advancedConfig })[0]);
      fireEvent.click(screen.getByRole('checkbox', { name: t().settings.capImages }));

      await userEvent.keyboard('{Escape}');

      expect(ui.discardQuestion()).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('the model lists', () => {
    const MANY = Array.from({ length: 12 }, (_, i) => `vendor/model-${String(i).padStart(2, '0')}`);

    beforeEach(() => {
      vi.mocked(fetchProviderModels).mockResolvedValue({ success: true, models: MANY.map((id) => ({ id, label: id })) });
    });

    afterEach(() => {
      vi.mocked(fetchProviderModels).mockReset();
    });

    async function fetchInto(provider: ProviderInstance) {
      seed([provider]);
      open(provider);
      fireEvent.click(screen.getByRole('button', { name: t().settings.fetchModels }));
      await screen.findByText(t().settings.fetchModelsSuccess.replace('{count}', String(MANY.length)));
    }

    it('says it is fetching in one place and keeps the fetch button still', async () => {
      let finish: (result: { success: boolean; models: { id: string; label: string }[] }) => void = () => undefined;
      vi.mocked(fetchProviderModels).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      seed([ownA]);
      open(ownA);
      fireEvent.click(screen.getByRole('button', { name: t().settings.fetchModels }));

      const statuses = screen.getAllByRole('status');
      expect(statuses.map((status) => status.textContent)).toEqual([t().settings.fetchingModels]);
      const button = screen.getByRole('button', { name: t().settings.fetchModels });
      expect(button).toBeDisabled();
      expect(button.querySelector('[data-ds-spinner]')).toBeNull();

      await act(async () => { finish({ success: true, models: [] }); });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('ticks a fetched model through its checkbox, and unticks it', async () => {
      await fetchInto(ownA);
      const box = screen.getByRole('checkbox', { name: MANY[3] });
      expect(box).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(box);
      expect(screen.getByRole('checkbox', { name: MANY[3] })).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByRole('checkbox', { name: MANY[3] }));
      expect(screen.getByRole('checkbox', { name: MANY[3] })).toHaveAttribute('aria-checked', 'false');
    });

    // The row of a model is the box around its checkbox and its name.
    const rowOf = (name: string) => screen.getByRole('checkbox', { name }).closest('div') as HTMLElement;

    it('ticks a fetched model from a press on the empty part of its row, and unticks it', async () => {
      await fetchInto(ownA);

      fireEvent.click(rowOf(MANY[3]));
      expect(screen.getByRole('checkbox', { name: MANY[3] })).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(rowOf(MANY[3]));
      expect(screen.getByRole('checkbox', { name: MANY[3] })).toHaveAttribute('aria-checked', 'false');
    });

    it('ticks a fetched model once from a press on its name', async () => {
      const user = userEvent.setup();
      await fetchInto(ownA);

      await user.click(screen.getByText(MANY[3]));
      expect(screen.getByRole('checkbox', { name: MANY[3] })).toHaveAttribute('aria-checked', 'true');
    });

    it('ticks a model in the panel of a built-in provider from a press on the empty part of its row', async () => {
      const deepSeek: ProviderInstance = { ...seededDeepSeek, enabled: true, apiKey: FAKE_KEY, userAdded: true };
      await fetchInto(deepSeek);

      fireEvent.click(rowOf(MANY[3]));
      expect(screen.getByRole('checkbox', { name: MANY[3] })).toHaveAttribute('aria-checked', 'true');
    });

    it('leaves a model the user typed alone on a press on its row', () => {
      seed([ownA]);
      open(ownA);
      const boxes = screen.getAllByRole('checkbox');
      expect(boxes).toHaveLength(2);

      fireEvent.click(boxes[0].closest('div') as HTMLElement);

      expect(screen.getAllByRole('checkbox')).toHaveLength(2);
      expect(boxes[0]).toHaveAttribute('aria-checked', 'true');
    });

    it('does not tick a fetched model from a press on the button that opens its abilities', async () => {
      await fetchInto(ownA);
      fireEvent.click(screen.getByRole('checkbox', { name: MANY[3] }));
      expect(screen.getByRole('checkbox', { name: MANY[3] })).toHaveAttribute('aria-checked', 'true');

      fireEvent.click(within(rowOf(MANY[3])).getByRole('button', { name: t().settings.advancedConfig }));

      expect(screen.getByRole('checkbox', { name: MANY[3] })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByText(t().settings.capPerModelHint)).toBeInTheDocument();
    });

    it('renders only the row that changed when one fetched model is ticked', async () => {
      await fetchInto(ownA);
      expect(checkboxRenders.count).toBeGreaterThan(0);

      checkboxRenders.count = 0;
      fireEvent.click(screen.getByRole('checkbox', { name: MANY[3] }));
      expect(checkboxRenders.count).toBe(1);
    });

    it('renders no remaining row again while the search narrows the fetched list', async () => {
      await fetchInto(ownA);
      expect(checkboxRenders.count).toBeGreaterThan(0);

      checkboxRenders.count = 0;
      fireEvent.change(screen.getByPlaceholderText(t().settings.filterModelsPlaceholder), { target: { value: 'model-0' } });
      expect(screen.getAllByRole('checkbox')).toHaveLength(10);
      expect(checkboxRenders.count).toBe(0);
    });

    it('renders no remaining row again while the search narrows the model panel of a built-in provider', async () => {
      const deepSeek: ProviderInstance = { ...seededDeepSeek, enabled: true, apiKey: FAKE_KEY, userAdded: true };
      await fetchInto(deepSeek);
      // The panel opened itself with the curated and the fetched models.
      expect(screen.getAllByRole('checkbox')).toHaveLength(PROVIDER_CONFIGS.deepseek.models.length + MANY.length);

      checkboxRenders.count = 0;
      fireEvent.change(screen.getByPlaceholderText(t().settings.filterModelsPlaceholder), { target: { value: 'model-0' } });
      expect(screen.getAllByRole('checkbox')).toHaveLength(10);
      expect(checkboxRenders.count).toBe(0);
    });

    it('opens the abilities of a selected model from a named button', async () => {
      seed([ownA]);
      open(ownA);
      const expand = screen.getAllByRole('button', { name: t().settings.advancedConfig });
      expect(expand).toHaveLength(2);
      expect(screen.queryByText(t().settings.capPerModelHint)).not.toBeInTheDocument();

      fireEvent.click(expand[0]);

      expect(screen.getByText(t().settings.capPerModelHint)).toBeInTheDocument();
      expect(screen.getByRole('checkbox', { name: t().settings.capTools })).toBeInTheDocument();
    });

    it('saves the abilities ticked for a model', () => {
      seed([ownA]);
      open(ownA);
      fireEvent.click(screen.getAllByRole('button', { name: t().settings.advancedConfig })[0]);
      fireEvent.click(screen.getByRole('checkbox', { name: t().settings.capTools }));
      fireEvent.click(screen.getByRole('checkbox', { name: t().settings.capReasoning }));
      fireEvent.click(screen.getByRole('checkbox', { name: t().settings.effortHigh }));
      fireEvent.change(screen.getByRole('textbox', { name: t().settings.capContextLength }), { target: { value: '12a8000' } });
      ui.save();

      expect(log).toEqual([
        ['updateProvider', 'own-a', expect.objectContaining({
          models: [
            toModelInfo('model-a', { declaredCapabilities: { supportsTools: true, supportsReasoning: true, supportedEfforts: ['high'], maxInputTokens: 128000 } }),
            toModelInfo('model-a2'),
          ],
        })],
      ]);
    });
  });

  describe('validating the connection', () => {
    function fillDeepSeek() {
      seed([seededDeepSeek]);
      const view = open();
      ui.pickProvider('DeepSeek');
      fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });
      ui.pickCuratedModel('DeepSeek V4 Pro');
      return view;
    }

    it('checks a throwaway provider built from the form, and says so while it waits', async () => {
      let finish: (result: { success: boolean; latencyMs: number }) => void = () => undefined;
      vi.mocked(checkProviderHealth).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const { onClose } = fillDeepSeek();
      ui.validate();

      expect(vi.mocked(checkProviderHealth).mock.calls).toEqual([[{
        id: '_test',
        source: 'custom',
        name: '',
        enabled: true,
        apiFormat: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
        apiKey: FAKE_KEY,
        models: [{ id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' }],
        status: 'unchecked',
        sortOrder: 0,
      }]]);
      expect(screen.getByText(t().settings.validating)).toBeInTheDocument();
      expect(keyOutsideItsInput()).toEqual([]);

      await act(async () => { finish({ success: true, latencyMs: 88 }); });

      expect(screen.getByText(t().settings.validationSuccess.replace('{latency}', '88'))).toBeInTheDocument();
      expect(screen.queryByText(t().settings.validating)).not.toBeInTheDocument();
      expect(keyOutsideItsInput()).toEqual([]);
      // Validating is not saving.
      expect(log).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    });

    // A button that went out of the tab order while it checked would drop the keyboard onto
    // the window: the next Tab would start from its first control.
    it('keeps the keyboard on the button while it checks and when the answer is in', async () => {
      const user = userEvent.setup();
      let finish: (result: { success: boolean; latencyMs: number }) => void = () => undefined;
      vi.mocked(checkProviderHealth).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      fillDeepSeek();
      const button = screen.getByRole('button', { name: t().settings.validateConnection });
      button.focus();

      await user.keyboard('{Enter}');

      expect(checkProviderHealth).toHaveBeenCalledTimes(1);
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      // Still a Tab stop: a natively disabled button cannot hold the focus.
      expect(button).not.toBeDisabled();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');
      expect(checkProviderHealth).toHaveBeenCalledTimes(1);

      await act(async () => { finish({ success: true, latencyMs: 88 }); });

      expect(button).toHaveFocus();
      expect(button).not.toHaveAttribute('aria-disabled');
    });

    // Two presses can arrive before the window has drawn the button as busy: the check itself
    // refuses a second run while the first is out.
    it('runs one check when the button is pressed twice before the window draws again', async () => {
      let finish: (result: { success: boolean; latencyMs: number }) => void = () => undefined;
      vi.mocked(checkProviderHealth).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      fillDeepSeek();
      const button = screen.getByRole('button', { name: t().settings.validateConnection });

      act(() => {
        button.click();
        button.click();
      });
      expect(checkProviderHealth).toHaveBeenCalledTimes(1);

      await act(async () => { finish({ success: true, latencyMs: 88 }); });
      expect(screen.getByText(t().settings.validationSuccess.replace('{latency}', '88'))).toBeInTheDocument();

      // Once the answer is in, the button checks again.
      vi.mocked(checkProviderHealth).mockResolvedValue({ success: true, latencyMs: 12 });
      await act(async () => { button.click(); });
      expect(checkProviderHealth).toHaveBeenCalledTimes(2);
    });

    it('checks again after a check that threw', async () => {
      vi.mocked(checkProviderHealth).mockRejectedValueOnce(new Error('network down'));
      fillDeepSeek();
      const button = screen.getByRole('button', { name: t().settings.validateConnection });
      await act(async () => { button.click(); });
      expect(screen.getByText(t().settings.validationFailed)).toBeInTheDocument();

      vi.mocked(checkProviderHealth).mockResolvedValue({ success: true, latencyMs: 12 });
      await act(async () => { button.click(); });
      expect(checkProviderHealth).toHaveBeenCalledTimes(2);
    });

    describe('when the window is closed and opened again while a check is out', () => {
      type Answer = (result: { success: boolean; latencyMs: number }) => void;
      // Each check waits until the test answers it; `answers` holds them in the order they started.
      function holdChecks(): Answer[] {
        const answers: Answer[] = [];
        vi.mocked(checkProviderHealth).mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
        return answers;
      }
      // The window clears its form once it has closed; that settles before the form is filled again.
      async function fillAgain() {
        await act(async () => { await Promise.resolve(); });
        ui.pickProvider('DeepSeek');
        fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });
        ui.pickCuratedModel('DeepSeek V4 Pro');
      }
      const validateButton = () => screen.getByRole('button', { name: t().settings.validateConnection });

      it('starts a new check from the reopened window', async () => {
        holdChecks();
        const { reopen } = fillDeepSeek();
        ui.validate();
        expect(checkProviderHealth).toHaveBeenCalledTimes(1);

        reopen();
        await fillAgain();
        expect(validateButton()).not.toHaveAttribute('aria-disabled');
        ui.validate();
        expect(checkProviderHealth).toHaveBeenCalledTimes(2);
        expect(screen.getByText(t().settings.validating)).toBeInTheDocument();
      });

      it('does not show the answer of the old check in the reopened window', async () => {
        const answers = holdChecks();
        const { reopen } = fillDeepSeek();
        ui.validate();
        reopen();
        await fillAgain();

        await act(async () => { answers[0]({ success: true, latencyMs: 88 }); });

        expect(screen.queryByText(t().settings.validationSuccess.replace('{latency}', '88'))).toBeNull();
        expect(validateButton()).not.toHaveAttribute('aria-disabled');
      });

      it('writes nothing when the answer arrives after the window has closed and stays closed', async () => {
        const answers = holdChecks();
        const { close, show } = fillDeepSeek();
        ui.validate();
        close();
        // The window has gone and has forgotten its form: the key is in no content it hands over.
        await waitFor(() => expect(windowRenders.dialogs.at(-1)?.holdsKey).toBe(false));
        const drawn = windowRenders.dialogs.length;
        const answer = t().settings.validationSuccess.replace('{latency}', '88');

        await act(async () => { answers[0]({ success: true, latencyMs: 88 }); });
        await act(async () => { await Promise.resolve(); });
        // However often the closed window is drawn after that, no draw holds the late answer:
        // a result written into its state would be in the content of the next draw.
        expect(windowRenders.dialogs.slice(drawn).filter((render) => render.holds(answer))).toEqual([]);

        show();
        await fillAgain();
        expect(screen.queryByText(t().settings.validationSuccess.replace('{latency}', '88'))).toBeNull();
        expect(screen.queryByText(t().settings.validating)).toBeNull();
        expect(validateButton()).not.toHaveAttribute('aria-disabled');
      });

      it('keeps the new check running when the old one answers late, and shows only the new answer', async () => {
        const answers = holdChecks();
        const { reopen } = fillDeepSeek();
        ui.validate();
        reopen();
        await fillAgain();
        ui.validate();

        await act(async () => { answers[0]({ success: true, latencyMs: 88 }); });
        expect(validateButton()).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByText(t().settings.validating)).toBeInTheDocument();
        expect(screen.queryByText(t().settings.validationSuccess.replace('{latency}', '88'))).toBeNull();
        // Still one check at a time for this opening.
        ui.validate();
        expect(checkProviderHealth).toHaveBeenCalledTimes(2);

        await act(async () => { answers[1]({ success: true, latencyMs: 12 }); });
        expect(screen.getByText(t().settings.validationSuccess.replace('{latency}', '12'))).toBeInTheDocument();
        expect(validateButton()).not.toHaveAttribute('aria-disabled');
      });
    });

    // A check that is out is work in progress: closing the window drops its answer. For an
    // approval the window steps aside, form and check untouched, and comes back.
    describe('when an approval arrives', () => {
      type Answer = (result: { success: boolean; latencyMs: number }) => void;
      const onApprovalAnswer = vi.fn();
      const onSettingsChange = vi.fn();
      const approval = (shown: boolean) => (
        <Dialog
          open={shown}
          onOpenChange={onApprovalAnswer}
          layer="approval"
          role="alertdialog"
          outsidePress="ignore"
          title="Confirm Action"
          footer={<Button>Cancel the command</Button>}
        />
      );
      function openBesideApproval({ insideSettings = false } = {}) {
        onApprovalAnswer.mockReset();
        onSettingsChange.mockReset();
        const onClose = vi.fn();
        const form = <AddProviderModal open onClose={onClose} />;
        const page = (shown: boolean) => (
          <>
            {insideSettings ? <Dialog open onOpenChange={onSettingsChange} title="Settings">{form}</Dialog> : form}
            {approval(shown)}
          </>
        );
        const view = render(page(false), { wrapper: DesignSystemProvider });
        seed([seededDeepSeek]);
        ui.pickProvider('DeepSeek');
        fireEvent.change(ui.keyInput(), { target: { value: FAKE_KEY } });
        ui.pickCuratedModel('DeepSeek V4 Pro');
        return { onClose, arrive: () => view.rerender(page(true)), leave: () => view.rerender(page(false)) };
      }
      function holdChecks(): Answer[] {
        const answers: Answer[] = [];
        vi.mocked(checkProviderHealth).mockImplementation(() => new Promise((resolve) => { answers.push(resolve); }));
        return answers;
      }
      // The box of a window that is in the page, on screen or hidden.
      const box = (title: string) => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
        .find((element) => element.querySelector('h2')?.textContent === title) ?? null;
      const success = (latency: string) => t().settings.validationSuccess.replace('{latency}', latency);

      it('steps aside while a check is out, unasked and unclosed, and returns with its form and the answer that came meanwhile', async () => {
        const answers = holdChecks();
        const { onClose, arrive, leave } = openBesideApproval();
        ui.validate();
        const form = box(t().settings.addService);
        expect(form).not.toBeNull();

        arrive();
        expect(screen.getByRole('alertdialog', { name: 'Confirm Action' })).toBeInTheDocument();
        expect(box(t().settings.addService)).toBe(form);
        expect(form).toHaveAttribute('hidden');
        expect(ui.discardQuestion()).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(onApprovalAnswer).not.toHaveBeenCalled();

        // The endpoint answers while the window stands aside.
        await act(async () => { answers[0]({ success: true, latencyMs: 88 }); });
        expect(onClose).not.toHaveBeenCalled();

        leave();
        expect(box(t().settings.addService)).toBe(form);
        expect(form).not.toHaveAttribute('hidden');
        expect(screen.getByText(success('88'))).toBeInTheDocument();
        expect(ui.keyInput().value).toBe(FAKE_KEY);
        expect(onClose).not.toHaveBeenCalled();
        expect(checkProviderHealth).toHaveBeenCalledTimes(1);
        expect(log).toEqual([]);
        expect(keyOutsideItsInput()).toEqual([]);
      });

      it('returns still checking when the answer has not come, and shows it when it does', async () => {
        const answers = holdChecks();
        const { onClose, arrive, leave } = openBesideApproval();
        ui.validate();
        arrive();
        leave();

        expect(screen.getByText(t().settings.validating)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: t().settings.validateConnection })).toHaveAttribute('aria-disabled', 'true');
        await act(async () => { answers[0]({ success: true, latencyMs: 12 }); });
        expect(screen.getByText(success('12'))).toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(checkProviderHealth).toHaveBeenCalledTimes(1);
      });

      it('takes the window it was opened in aside with it, and both return', async () => {
        const answers = holdChecks();
        const { onClose, arrive, leave } = openBesideApproval({ insideSettings: true });
        ui.validate();
        const settings = box('Settings');
        const form = box(t().settings.addService);

        arrive();
        expect(settings).toHaveAttribute('hidden');
        expect(form).toHaveAttribute('hidden');
        expect(onSettingsChange).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();

        await act(async () => { answers[0]({ success: true, latencyMs: 88 }); });
        leave();
        expect(box('Settings')).toBe(settings);
        expect(box(t().settings.addService)).toBe(form);
        expect(settings).not.toHaveAttribute('hidden');
        expect(form).not.toHaveAttribute('hidden');
        expect(screen.getByText(success('88'))).toBeInTheDocument();
        expect(ui.keyInput().value).toBe(FAKE_KEY);
        expect(onSettingsChange).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
      });

      it('asks about the typed input when no check is out; the approval waits off the page, unanswered', () => {
        const { onClose, arrive } = openBesideApproval();

        arrive();
        expect(ui.discardQuestion()).not.toBeNull();
        expect(box('Confirm Action')).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(onApprovalAnswer).not.toHaveBeenCalled();

        ui.keepEditing();
        expect(box('Confirm Action')).toBeNull();
        expect(ui.keyInput().value).toBe(FAKE_KEY);
        expect(onClose).not.toHaveBeenCalled();
        expect(onApprovalAnswer).not.toHaveBeenCalled();
      });
    });

    it('shows the reason when the check fails', async () => {
      vi.mocked(checkProviderHealth).mockResolvedValue({ success: false, latencyMs: 0, error: 'made-up refusal' });
      fillDeepSeek();
      ui.validate();

      expect(await screen.findByText('made-up refusal')).toBeInTheDocument();
      expect(log).toEqual([]);
    });

    it('shows the general failure words when the check throws', async () => {
      vi.mocked(checkProviderHealth).mockRejectedValue(new Error('network down'));
      fillDeepSeek();
      ui.validate();

      expect(await screen.findByText(t().settings.validationFailed)).toBeInTheDocument();
    });
  });

  describe('key storage problems of the provider being edited', () => {
    it('says the key could not be decrypted', () => {
      seed([ownA]);
      useSettingsStore.setState({ failedSecretKeys: ['provider:own-a'] });
      open(ownA);

      expect(screen.getByText(t().settings.apiKeyDecryptFailed)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.apiKeySaveFailed)).not.toBeInTheDocument();
    });

    it('says the key could not be stored securely', () => {
      seed([ownA]);
      useSettingsStore.setState({ secretWriteFailedKeys: ['provider:own-a'] });
      open(ownA);

      expect(screen.getByText(t().settings.apiKeySaveFailed)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.apiKeyDecryptFailed)).not.toBeInTheDocument();
    });

    it('says only that the key could not be decrypted when both happened', () => {
      seed([ownA]);
      useSettingsStore.setState({ failedSecretKeys: ['provider:own-a'], secretWriteFailedKeys: ['provider:own-a'] });
      open(ownA);

      expect(screen.getByText(t().settings.apiKeyDecryptFailed)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.apiKeySaveFailed)).not.toBeInTheDocument();
    });

    it('says nothing about another provider, or when adding', () => {
      seed([ownA, ownB]);
      useSettingsStore.setState({ failedSecretKeys: ['provider:own-b'], secretWriteFailedKeys: ['provider:own-b'] });
      open(ownA);

      expect(screen.queryByText(t().settings.apiKeyDecryptFailed)).not.toBeInTheDocument();
      expect(screen.queryByText(t().settings.apiKeySaveFailed)).not.toBeInTheDocument();
    });
  });
});

describe('AddProviderModal — failure text of model fetch and Ollama check', () => {
  const FAKE_KEY = 'sk-test-not-a-secret';
  const FAKE_URL_PASSWORD = 'test-password-not-a-secret';
  const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(async () => {
    setLanguage('en-US');
    localStorage.clear();
    useSettingsStore.setState({
      providers: [],
      activeModel: { providerId: '', modelId: '' },
      failedSecretKeys: [],
    });
    const actual = await vi.importActual<typeof import('@/core/llm/modelFetcher')>('@/core/llm/modelFetcher');
    vi.mocked(fetchProviderModels).mockImplementation(actual.fetchProviderModels);
    // This file stubs the Ollama check for its behaviour pins; here the real one runs.
    const actualOllama = await vi.importActual<typeof import('@/core/llm/ollama')>('@/core/llm/ollama');
    vi.mocked(checkOllamaHealth).mockImplementation(actualOllama.checkOllamaHealth);
    mockTransportFetch.mockReset();
    consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  });

  afterEach(() => {
    unmountWindow();
    vi.mocked(fetchProviderModels).mockReset();
    vi.mocked(checkOllamaHealth).mockReset();
    consoleSpies.forEach((spy) => spy.mockRestore());
  });

  /** 界面文字、title、aria-label、store、localStorage、控制台里都不出现给定的值 */
  function expectAbsentEverywhere(secrets: string[]) {
    const attributes = ['title', 'aria-label'].flatMap((attribute) =>
      Array.from(document.querySelectorAll(`[${attribute}]`), (el) => el.getAttribute(attribute)),
    );
    const logged = consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg: unknown) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : JSON.stringify(arg))).join(' '));
    const stored = Array.from({ length: localStorage.length }, (_, i) => localStorage.getItem(localStorage.key(i) as string));
    const haystack = [
      document.body.textContent,
      ...attributes,
      JSON.stringify(useSettingsStore.getState()),
      ...stored,
      ...logged,
    ].join('\n');
    for (const secret of secrets) expect(haystack).not.toContain(secret);
  }

  it('shows a failed model fetch without the key or the URL password the exception carried', async () => {
    mockTransportFetch.mockRejectedValue(
      new TypeError(
        `Request cannot be constructed from a URL that includes credentials: https://user:${FAKE_URL_PASSWORD}@api.deepseek.com/models, header x-api-key ${FAKE_KEY}`,
      ),
    );
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek' }));
    const apiKeyInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: FAKE_KEY } });
    fireEvent.click(screen.getByRole('button', { name: /fetch models/i }));

    expect(
      await screen.findByText(
        'TypeError: Request cannot be constructed from a URL that includes credentials: https://[REDACTED]@api.deepseek.com/models, header x-api-key [REDACTED]',
      ),
    ).toBeInTheDocument();
    expectAbsentEverywhere([FAKE_KEY, FAKE_URL_PASSWORD]);
  });

  it('shows a failed Ollama check without the URL password the exception carried', async () => {
    const baseUrl = `http://user:${FAKE_URL_PASSWORD}@ollama.example.test:11434`;
    mockTransportFetch.mockRejectedValue(
      new TypeError(`Request cannot be constructed from a URL that includes credentials: ${baseUrl}/`),
    );
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: /ollama/i }));
    const baseUrlInput = screen.getByPlaceholderText('http://127.0.0.1:11434');
    fireEvent.change(baseUrlInput, { target: { value: baseUrl } });
    fireEvent.blur(baseUrlInput);

    expect(
      await screen.findByText(
        'Request cannot be constructed from a URL that includes credentials: [REDACTED]/',
      ),
    ).toBeInTheDocument();
    expectAbsentEverywhere([FAKE_URL_PASSWORD]);
  });
});

describe('AddProviderModal — 上下文长度 placeholder', () => {
  beforeEach(() => {
    setLanguage('en-US');
    useSettingsStore.setState({
      providers: [],
      activeModel: { providerId: '', modelId: '' },
      failedSecretKeys: [],
      contextWindowSize: 200000,
    });
  });

  afterEach(() => {
    unmountWindow();
  });

  /** 选自定义 API、填地址、手动加一个模型并展开它的高级配置 */
  function openAdvancedFor(baseUrl: string, modelId: string): HTMLInputElement {
    renderWindow(<AddProviderModal open={true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /select provider/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom API' }));
    fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: baseUrl } });
    fireEvent.click(screen.getByRole('button', { name: /add model/i }));
    const modelInput = screen.getByPlaceholderText('Enter model ID');
    fireEvent.change(modelInput, { target: { value: modelId } });
    fireEvent.keyDown(modelInput, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: t().settings.advancedConfig }));
    return contextLengthInput();
  }

  function contextLengthInput(): HTMLInputElement {
    return screen.getByRole('textbox', { name: 'Context length' }) as HTMLInputElement;
  }

  it('caps the estimate at the global context-window limit the runtime uses', () => {
    // qwen3-max 按名字估计 262144，高于全局上限 200000
    const input = openAdvancedFor('https://api.example.com/v1', 'qwen3-max');
    expect(input).toHaveAttribute('placeholder', 'Not detected; blank means 200K is assumed');
  });

  it('follows the address: a local server gets the local estimate, a cloud one the name-based one', () => {
    const input = openAdvancedFor('http://127.0.0.1:8080/v1', 'qwen3-vl-8b');
    expect(input).toHaveAttribute('placeholder', 'Not detected; blank means 32K is assumed');
    fireEvent.change(screen.getByPlaceholderText('https://...'), { target: { value: 'https://api.example.com/v1' } });
    expect(contextLengthInput()).toHaveAttribute('placeholder', 'Not detected; blank means 128K is assumed');
  });
});
