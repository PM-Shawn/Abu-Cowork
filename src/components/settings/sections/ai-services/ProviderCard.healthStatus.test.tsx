// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n } from '@/i18n';
import { classifyError } from '@/core/llm/adapter';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import ProviderCard from './ProviderCard';

const mocks = vi.hoisted(() => ({ chat: vi.fn() }));

// 只替换发出网络请求的 adapter；checkProviderHealth 与 classifyError 运行真实实现
vi.mock('@/core/llm/openai-compatible', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/llm/openai-compatible')>()),
  OpenAICompatibleAdapter: class {
    chat = mocks.chat;
  },
}));

const FAKE_KEY = 'sk-test-not-a-secret';
const FAKE_UPSTREAM_TOKEN = 'test-bearer-token-not-a-secret';
const PROVIDER_ID = 'custom-health';

const failingProvider: ProviderInstance = {
  id: PROVIDER_ID,
  source: 'custom',
  name: 'Health',
  enabled: true,
  apiFormat: 'openai-compatible',
  baseUrl: 'https://llm.example.test/v1',
  apiKey: FAKE_KEY,
  models: [{ id: 'model-a', label: 'model-a' }],
  status: 'unchecked',
  sortOrder: 0,
  userAdded: true,
};

function StoreBackedCard() {
  const provider = useSettingsStore((s) => s.providers.find((p) => p.id === PROVIDER_ID));
  return provider ? <ProviderCard provider={provider} isActive={false} onEdit={vi.fn()} /> : null;
}

/** Presses the card's re-check button and returns the element that carries the failure text as its `title`. */
async function recheckAndFindFailure(): Promise<HTMLElement> {
  render(<StoreBackedCard />, { wrapper: DesignSystemProvider });
  fireEvent.click(screen.getByRole('button', { name: getI18n().settings.revalidate }));
  const badge = await screen.findByText(getI18n().settings.statusFailed);
  const holder = badge.closest<HTMLElement>('[title]');
  if (!holder) throw new Error('the failed status carries no title');
  return holder;
}

const CONSOLE_METHODS =['log', 'info', 'warn', 'error', 'debug'] as const;

describe('ProviderCard after a failed health check', () => {
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    mocks.chat.mockReset();
    useSettingsStore.setState({ providers: [failingProvider], failedSecretKeys: [], secretWriteFailedKeys: [] });
    consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('never exposes an echoed key in title, aria-label, text, the store or logs', async () => {
    mocks.chat.mockRejectedValue(
      classifyError(
        401,
        JSON.stringify({
          error: {
            message: `Incorrect API key provided: ${FAKE_KEY}; sent Authorization: Bearer ${FAKE_UPSTREAM_TOKEN}`,
          },
        }),
      ),
    );
    const badge = await recheckAndFindFailure();

    expect(badge).toHaveAttribute('title', 'Incorrect API key provided: [REDACTED]; sent Authorization: [REDACTED]');

    const secrets = [FAKE_KEY, FAKE_UPSTREAM_TOKEN];
    const titles = Array.from(document.querySelectorAll('[title]'), (el) => el.getAttribute('title') ?? '');
    const ariaLabels = Array.from(document.querySelectorAll('[aria-label]'), (el) => el.getAttribute('aria-label') ?? '');
    const stored = useSettingsStore.getState().providers.find((p) => p.id === PROVIDER_ID)?.statusMessage ?? '';
    const logged = consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((args) => args.map((arg: unknown) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : JSON.stringify(arg))).join(' '))
      .join('\n');

    for (const secret of secrets) {
      expect(titles.join('\n')).not.toContain(secret);
      expect(ariaLabels.join('\n')).not.toContain(secret);
      expect(document.body.textContent).not.toContain(secret);
      expect(document.body.innerHTML).not.toContain(secret);
      expect(stored).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(stored).toBe('Incorrect API key provided: [REDACTED]; sent Authorization: [REDACTED]');
  });

  it('caps a long response body before it reaches the title', async () => {
    mocks.chat.mockRejectedValue(classifyError(502, 'gateway dump '.repeat(1000)));
    const badge = await recheckAndFindFailure();

    expect(badge.getAttribute('title')).toHaveLength(500);
  });
});
