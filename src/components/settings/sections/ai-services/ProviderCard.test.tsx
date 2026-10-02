// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { SECRET_KEYS } from '@/utils/secretStore';
import ProviderCard from './ProviderCard';

// Every store action and the health check write into one log, so a test can read their order.
const log: unknown[][] = [];
const health = vi.hoisted(() => ({ check: vi.fn() }));

vi.mock('@/core/llm/healthCheck', () => ({
  checkProviderHealth: (...args: unknown[]) => {
    log.push(['checkProviderHealth', ...args]);
    return health.check(...args);
  },
}));

const FAKE_KEY = 'sk-test-not-a-secret';
const FAKE_BASE_URL = 'https://models.example.test/v1';
const BUILTIN_SEARCH = { type: 'parameter', paramName: 'enable_search', paramValue: true } as const;
const RECORDED = ['toggleProvider', 'setProviderStatus', 'removeProvider', 'updateProvider', 'selectModel'] as const;
const originals = useSettingsStore.getState();
const t = () => getI18n();

function provider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'own-a',
    source: 'custom',
    name: 'Service A',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: FAKE_BASE_URL,
    apiKey: FAKE_KEY,
    models: [{ id: 'model-a', label: 'Model A' }],
    status: 'unchecked',
    sortOrder: 2,
    userAdded: true,
    ...overrides,
  };
}

// The card as the models page shows it: provider and "is it the one in use" both come from the store.
function StoreCard({ id, onEdit }: { id: string; onEdit: (provider: ProviderInstance) => void }) {
  const current = useSettingsStore((s) => s.providers.find((p) => p.id === id));
  const activeProviderId = useSettingsStore((s) => s.activeModel.providerId);
  if (!current) return null;
  return <ProviderCard provider={current} isActive={activeProviderId === id} onEdit={onEdit} />;
}

function renderCard(providers: ProviderInstance[], activeProviderId = '') {
  const active = providers.find((p) => p.id === activeProviderId);
  useSettingsStore.setState({
    providers,
    activeModel: { providerId: activeProviderId, modelId: active?.models[0]?.id ?? '' },
  });
  log.length = 0;
  const onEdit = vi.fn();
  const view = render(<StoreCard id={providers[0].id} onEdit={onEdit} />, { wrapper: DesignSystemProvider });
  return { ...view, onEdit };
}

// One of the three actions on a card.
function action(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

const card = () => screen.getByText('Service A').closest<HTMLElement>('div.group')!;

const storeCalls = () => log.filter(([name]) => name !== 'checkProviderHealth');

describe('ProviderCard for a provider the user added', () => {
  beforeEach(() => {
    initLanguage('en-US');
    health.check.mockReset();
    const recorded = Object.fromEntries(RECORDED.map((name) => [name, (...args: unknown[]) => {
      log.push([name, ...args]);
      return (originals[name] as (...values: unknown[]) => unknown)(...args);
    }]));
    useSettingsStore.setState({ ...recorded, failedSecretKeys: [], secretWriteFailedKeys: [] });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useSettingsStore.setState(originals, true);
  });

  it('switches the provider on and off through toggleProvider', async () => {
    renderCard([provider()]);

    await userEvent.click(screen.getByRole('switch'));

    expect(log).toEqual([['toggleProvider', 'own-a']]);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });

  it('hands the provider to onEdit', async () => {
    const { onEdit } = renderCard([provider()]);

    await userEvent.click(action(t().settings.editProvider));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0]).toMatchObject({ id: 'own-a', name: 'Service A' });
    expect(log).toEqual([]);
  });

  it('shows no verification state until the user asks for one', () => {
    renderCard([provider({ status: 'verified', statusLatency: 88 })]);

    expect(screen.queryByText('88ms')).not.toBeInTheDocument();
    expect(screen.queryByText(t().settings.statusUnchecked)).not.toBeInTheDocument();
  });

  it('verifies again: checking, the health check, then the latency, which goes away after five seconds', async () => {
    vi.useFakeTimers();
    let finish: (result: { success: boolean; latencyMs: number }) => void = () => {};
    health.check.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderCard([provider()]);
    const asked = useSettingsStore.getState().providers[0];

    fireEvent.click(action(t().settings.revalidate));

    expect(log).toEqual([['setProviderStatus', 'own-a', 'checking'], ['checkProviderHealth', asked]]);
    expect(screen.getByText(t().settings.validating)).toBeInTheDocument();
    expect(action(t().settings.revalidate)).toBeDisabled();

    await act(async () => { finish({ success: true, latencyMs: 123 }); });

    expect(storeCalls()).toEqual([
      ['setProviderStatus', 'own-a', 'checking'],
      ['setProviderStatus', 'own-a', 'verified', undefined, 123],
    ]);
    expect(screen.getByText('123ms')).toBeInTheDocument();
    expect(action(t().settings.revalidate)).toBeEnabled();

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(screen.queryByText('123ms')).not.toBeInTheDocument();
  });

  it('reports a failed verification with its reason', async () => {
    vi.useFakeTimers();
    health.check.mockResolvedValue({ success: false, latencyMs: 5, error: 'HTTP 401' });
    renderCard([provider()]);

    fireEvent.click(action(t().settings.revalidate));
    await act(async () => {});

    expect(storeCalls()).toEqual([
      ['setProviderStatus', 'own-a', 'checking'],
      ['setProviderStatus', 'own-a', 'failed', 'HTTP 401'],
    ]);
    expect(screen.getByTitle('HTTP 401')).toHaveTextContent(t().settings.statusFailed);
  });

  it('says Connected when a verified provider reports no latency', async () => {
    vi.useFakeTimers();
    health.check.mockResolvedValue({ success: true, latencyMs: 0 });
    renderCard([provider()]);

    fireEvent.click(action(t().settings.revalidate));
    await act(async () => {});

    expect(screen.getByText(t().settings.statusConnected)).toBeInTheDocument();
  });

  it('says Unchecked when the result is reset while it is still on show', async () => {
    vi.useFakeTimers();
    health.check.mockResolvedValue({ success: true, latencyMs: 40 });
    renderCard([provider()]);

    fireEvent.click(action(t().settings.revalidate));
    await act(async () => {});
    act(() => { originals.updateProvider('own-a', { status: 'unchecked' }); });

    expect(screen.getByText(t().settings.statusUnchecked)).toBeInTheDocument();
    expect(screen.queryByText('40ms')).not.toBeInTheDocument();
  });

  it('removes a custom provider only after the user confirms', async () => {
    renderCard([provider(), provider({ id: 'own-b', name: 'Service B', sortOrder: 1 })]);

    await userEvent.click(action(t().settings.deleteProvider));
    expect(log).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: t().common.cancel }));
    expect(log).toEqual([]);
    expect(screen.queryByRole('button', { name: t().common.confirm })).not.toBeInTheDocument();

    await userEvent.click(action(t().settings.deleteProvider));
    await userEvent.click(screen.getByRole('button', { name: t().common.confirm }));

    expect(log).toEqual([['removeProvider', 'own-a']]);
    expect(useSettingsStore.getState().providers.map((p) => p.id)).toEqual(['own-b']);
  });

  it('hides a built-in provider instead of removing it', async () => {
    renderCard([provider({ id: 'builtin-a', source: 'builtin' })]);

    await userEvent.click(action(t().settings.deleteProvider));
    await userEvent.click(screen.getByRole('button', { name: t().common.confirm }));

    expect(log).toEqual([
      ['updateProvider', 'builtin-a', { enabled: false, apiKey: '', status: 'unchecked', userAdded: false }],
    ]);
  });

  it('moves to the next enabled provider when the one in use is deleted', async () => {
    renderCard([
      provider(),
      provider({ id: 'own-off', name: 'Service Off', enabled: false, models: [{ id: 'model-off', label: 'Model Off' }] }),
      provider({ id: 'own-b', name: 'Service B', models: [{ id: 'model-b', label: 'Model B' }, { id: 'model-b2', label: 'Model B2' }] }),
    ], 'own-a');

    await userEvent.click(action(t().settings.deleteProvider));
    await userEvent.click(screen.getByRole('button', { name: t().common.confirm }));

    expect(log).toEqual([['removeProvider', 'own-a'], ['selectModel', 'own-b', 'model-b']]);
    expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'own-b', modelId: 'model-b' });
  });

  it('leaves the model in use alone when another provider is deleted', async () => {
    renderCard([provider(), provider({ id: 'own-b', name: 'Service B', models: [{ id: 'model-b', label: 'Model B' }] })], 'own-b');

    await userEvent.click(action(t().settings.deleteProvider));
    await userEvent.click(screen.getByRole('button', { name: t().common.confirm }));

    expect(log).toEqual([['removeProvider', 'own-a']]);
    expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'own-b', modelId: 'model-b' });
  });

  it('asks about the provider by name before deleting it', async () => {
    renderCard([provider()]);

    await userEvent.click(action(t().settings.deleteProvider));

    const question = screen.getByRole('alertdialog', { name: t().settings.deleteProviderConfirm });
    expect(within(question).getByText('Service A')).toBeInTheDocument();
    expect(within(question).getByRole('button', { name: t().common.confirm })).toBeInTheDocument();
  });

  it('does nothing when the provider went away while the question was open', async () => {
    renderCard([provider(), provider({ id: 'own-b', name: 'Service B', models: [{ id: 'model-b', label: 'Model B' }] })], 'own-a');

    await userEvent.click(action(t().settings.deleteProvider));
    act(() => { useSettingsStore.setState((s) => ({ providers: s.providers.filter((p) => p.id !== 'own-a') })); });
    await userEvent.click(screen.getByRole('button', { name: t().common.confirm }));

    expect(log).toEqual([]);
    expect(useSettingsStore.getState().providers.map((p) => p.id)).toEqual(['own-b']);
    expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'own-a', modelId: 'model-a' });
  });

  it('decides whether the provider is the one in use when the user answers', async () => {
    renderCard([provider(), provider({ id: 'own-b', name: 'Service B', models: [{ id: 'model-b', label: 'Model B' }] })], 'own-b');

    await userEvent.click(action(t().settings.deleteProvider));
    act(() => { useSettingsStore.setState({ activeModel: { providerId: 'own-a', modelId: 'model-a' } }); });
    await userEvent.click(screen.getByRole('button', { name: t().common.confirm }));

    expect(log).toEqual([['removeProvider', 'own-a'], ['selectModel', 'own-b', 'model-b']]);
  });

  it('shows one spinner while verifying and keeps the button icon still', async () => {
    vi.useFakeTimers();
    health.check.mockReturnValue(new Promise(() => {}));
    renderCard([provider()]);

    fireEvent.click(action(t().settings.revalidate));

    expect(card().querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(t().settings.validating);
    expect(action(t().settings.revalidate).querySelector('[data-ds-spinner]')).toBeNull();
    expect(action(t().settings.revalidate).querySelector('.animate-spin')).toBeNull();
  });

  it('marks the provider in use with the selected fill', () => {
    renderCard([provider()], 'own-a');
    expect(card()).toHaveClass('bg-fill-selected');
    cleanup();

    renderCard([provider()]);
    expect(card()).not.toHaveClass('bg-fill-selected');
  });

  it('dims a provider that is switched off', () => {
    renderCard([provider({ enabled: false })]);

    expect(card()).toHaveClass('opacity-50');
  });

  it('keeps a provider whose key cannot be read at full strength even when it is switched off', () => {
    renderCard([provider({ enabled: false })]);
    act(() => { useSettingsStore.setState({ failedSecretKeys: [SECRET_KEYS.provider('own-a')] }); });

    expect(card()).not.toHaveClass('opacity-50');
    expect(screen.getByRole('alert')).toHaveTextContent(t().settings.apiKeyDecryptFailed);
  });

  it('names the switch after the provider', () => {
    renderCard([provider()]);

    expect(screen.getByRole('switch', { name: 'Service A' })).toBeInTheDocument();
  });

  it('shows the three actions under the pointer and when the keyboard reaches the card', () => {
    renderCard([provider()]);
    const actions = action(t().settings.editProvider).parentElement!;

    expect(actions).toContainElement(action(t().settings.revalidate));
    expect(actions).toContainElement(action(t().settings.deleteProvider));
    expect(actions).toHaveClass('opacity-0');
    expect(actions).toHaveClass('group-hover:opacity-100');
    expect(actions).toHaveClass('group-focus-within:opacity-100');
  });

  it('tells the user when the saved key could not be decrypted', () => {
    renderCard([provider()]);
    act(() => { useSettingsStore.setState({ failedSecretKeys: [SECRET_KEYS.provider('own-a')] }); });

    expect(screen.getByText(t().settings.apiKeyDecryptFailed)).toBeInTheDocument();
    expect(screen.queryByText(t().settings.apiKeySaveFailed)).not.toBeInTheDocument();
  });

  it('tells the user when the key could not be saved securely', () => {
    renderCard([provider()]);
    act(() => { useSettingsStore.setState({ secretWriteFailedKeys: [SECRET_KEYS.provider('own-a')] }); });

    expect(screen.getByText(t().settings.apiKeySaveFailed)).toBeInTheDocument();
    expect(screen.queryByText(t().settings.apiKeyDecryptFailed)).not.toBeInTheDocument();
  });

  it('shows only the decryption notice when both went wrong', () => {
    renderCard([provider()]);
    act(() => {
      useSettingsStore.setState({
        failedSecretKeys: [SECRET_KEYS.provider('own-a')],
        secretWriteFailedKeys: [SECRET_KEYS.provider('own-a')],
      });
    });

    expect(screen.getByText(t().settings.apiKeyDecryptFailed)).toBeInTheDocument();
    expect(screen.queryByText(t().settings.apiKeySaveFailed)).not.toBeInTheDocument();
  });

  it('never puts the key or the endpoint on the page', async () => {
    renderCard([provider({ capabilities: { webSearch: BUILTIN_SEARCH } })]);

    expect(document.body.innerHTML).toContain('Service A');
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
    expect(document.body.innerHTML).not.toContain('models.example.test');

    await userEvent.click(action(t().settings.deleteProvider));

    expect(screen.getByRole('button', { name: t().common.confirm })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(FAKE_KEY);
    expect(document.body.innerHTML).not.toContain('models.example.test');
  });

  it('lists the first two models, how many more there are, and the built-in abilities', () => {
    renderCard([provider({
      models: [{ id: 'm1', label: 'One' }, { id: 'm2', label: '' }, { id: 'm3', label: 'Three' }, { id: 'm4', label: 'Four' }],
      capabilities: { webSearch: BUILTIN_SEARCH, imageGen: true },
    })]);

    expect(screen.getByText('One, m2 +2')).toBeInTheDocument();
    expect(screen.getByText(`${t().settings.capabilityWebSearch}, ${t().settings.capabilityImageGen}`)).toBeInTheDocument();
  });
});
