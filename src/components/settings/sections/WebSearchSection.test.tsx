// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { WebSearchForm } from './WebSearchSection';

const shell = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shell.open }));

const FAKE_KEY = 'sk-test-not-a-secret';
const originals = useSettingsStore.getState();
const saved: unknown[] = [];
const t = () => getI18n();

function renderForm() {
  return render(<WebSearchForm />, { wrapper: DesignSystemProvider });
}

const keyInput = () => screen.getByPlaceholderText(t().settings.webSearchApiKeyPlaceholder) as HTMLInputElement;

// The button that shows or hides the key.
function revealButton(): HTMLElement {
  return screen.getByRole('button', { name: /^(Show key|Hide key)$/ });
}

const engineSelect = () => screen.getByRole('combobox', { name: t().settings.webSearchProvider });

async function chooseEngine(user: ReturnType<typeof userEvent.setup>, current: string, next: string) {
  expect(engineSelect()).toHaveTextContent(current);
  await user.click(engineSelect());
  await user.click(screen.getByRole('option', { name: next }));
}

describe('WebSearchForm', () => {
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    initLanguage('en-US');
    shell.open.mockReset();
    saved.length = 0;
    useSettingsStore.setState({
      auxiliaryServices: {},
      setAuxiliaryWebSearch: (config) => {
        saved.push(config);
        originals.setAuxiliaryWebSearch(config);
      },
    });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState(originals, true);
  });

  it('hides the key until the user asks to see it, and hides it again', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(keyInput()).toHaveAttribute('type', 'password');

    await user.click(revealButton());
    expect(keyInput()).toHaveAttribute('type', 'text');

    await user.click(revealButton());
    expect(keyInput()).toHaveAttribute('type', 'password');
  });

  it('saves the key on every change, next to the engine and the address', () => {
    renderForm();

    fireEvent.change(keyInput(), { target: { value: FAKE_KEY } });

    expect(saved).toEqual([{ provider: 'tavily', apiKey: FAKE_KEY, baseUrl: '' }]);
    expect(keyInput().value).toBe(FAKE_KEY);
  });

  it('shows a saved key as the hidden value of the field, with nothing standing in for it', () => {
    useSettingsStore.setState({ auxiliaryServices: { webSearch: { provider: 'brave', apiKey: FAKE_KEY, baseUrl: '' } } });
    renderForm();

    expect(keyInput().value).toBe(FAKE_KEY);
    expect(keyInput()).toHaveAttribute('type', 'password');
    expect(document.body.textContent).not.toContain(FAKE_KEY);
  });

  it('swaps the key field for the address field when SearXNG is chosen', async () => {
    const user = userEvent.setup();
    renderForm();
    expect(screen.queryByPlaceholderText(t().settings.webSearchBaseUrlPlaceholder)).not.toBeInTheDocument();

    await chooseEngine(user, t().settings.webSearchProviderTavily, t().settings.webSearchProviderSearXNG);

    expect(saved).toEqual([{ provider: 'searxng', apiKey: '', baseUrl: '' }]);
    expect(screen.queryByPlaceholderText(t().settings.webSearchApiKeyPlaceholder)).not.toBeInTheDocument();
    const address = screen.getByPlaceholderText(t().settings.webSearchBaseUrlPlaceholder) as HTMLInputElement;
    expect(address).toHaveAttribute('type', 'text');
    expect(screen.getByText(t().settings.webSearchBaseUrlDesc)).toBeInTheDocument();

    fireEvent.change(address, { target: { value: 'http://localhost:8080' } });

    expect(saved[1]).toEqual({ provider: 'searxng', apiKey: '', baseUrl: 'http://localhost:8080' });
  });

  it('keeps the key field for every engine that needs a key', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ auxiliaryServices: { webSearch: { provider: 'searxng', apiKey: '', baseUrl: 'http://localhost:8080' } } });
    renderForm();

    await chooseEngine(user, t().settings.webSearchProviderSearXNG, t().settings.webSearchProviderBing);

    expect(saved).toEqual([{ provider: 'bing', apiKey: '', baseUrl: 'http://localhost:8080' }]);
    expect(keyInput()).toHaveAttribute('type', 'password');
    expect(screen.getByText(t().settings.webSearchApiKeyDesc)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(t().settings.webSearchBaseUrlPlaceholder)).not.toBeInTheDocument();
  });

  it('changes the engine only on a choice, never on an arrow key', async () => {
    const user = userEvent.setup();
    renderForm();

    engineSelect().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(saved).toEqual([]);

    await user.keyboard('{Escape}');

    expect(saved).toEqual([]);
    expect(engineSelect()).toHaveTextContent(t().settings.webSearchProviderTavily);
  });

  it('names the key and address fields after their labels', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.getByLabelText(t().settings.webSearchApiKey)).toBe(keyInput());

    await chooseEngine(user, t().settings.webSearchProviderTavily, t().settings.webSearchProviderSearXNG);

    expect(screen.getByLabelText(t().settings.webSearchBaseUrl)).toBe(screen.getByPlaceholderText(t().settings.webSearchBaseUrlPlaceholder));
  });

  it('opens the page of the chosen engine from the link under the list', async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.getByRole('button', { name: 'Get API Key' })).toBeInTheDocument();
    await user.click(screen.getByText('Get API Key'));
    expect(shell.open).toHaveBeenCalledWith('https://tavily.com/');

    await chooseEngine(user, t().settings.webSearchProviderTavily, t().settings.webSearchProviderSearXNG);
    await user.click(screen.getByText('SearXNG Docs'));
    expect(shell.open).toHaveBeenLastCalledWith('https://docs.searxng.org/');
  });
});
