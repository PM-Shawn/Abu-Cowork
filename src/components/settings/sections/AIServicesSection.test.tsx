// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AIServicesSection from './AIServicesSection';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { passSettleInterval } from '@/test/dsWindows';

// The real icon button (it mounts a tooltip), with its renders counted by label: a service
// card must stay still while another setting on the page changes.
const iconButtonRenders = vi.hoisted(() => ({ labels: [] as string[] }));
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: Parameters<typeof actual.IconButton>[0]) => {
      iconButtonRenders.labels.push(props.label);
      return <actual.IconButton {...props} />;
    },
  };
});

const FAKE_KEY = 'sk-test-not-a-secret';
const originals = useSettingsStore.getState();

function provider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'own-a',
    source: 'custom',
    name: 'Service A',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://models.example.test/v1',
    apiKey: FAKE_KEY,
    models: [{ id: 'model-a', label: 'Model A' }],
    status: 'unchecked',
    sortOrder: 2,
    userAdded: true,
    ...overrides,
  };
}

function renderSection() {
  return render(<AIServicesSection />, { wrapper: DesignSystemProvider });
}

// One of the actions on an image-generation backend row.
function backendAction(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

const filledButtons = () => screen.getAllByRole('button').filter((button) => button.classList.contains('bg-emphasis'));

describe('AIServicesSection web search status', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useSettingsStore.setState((state) => ({
      providers: state.providers.map((provider) => ({
        ...provider,
        enabled: false,
        apiKey: '',
        userAdded: false,
      })),
      auxiliaryServices: {},
      imageGeneration: { backends: [] },
    }));
  });

  afterEach(cleanup);

  it('updates from custom required to configured as the user enters an API key', async () => {
    const user = userEvent.setup();
    renderSection();

    expect(screen.getByRole('button', { name: /Custom required/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Custom required/ }));
    const apiKeyInput = screen.getByPlaceholderText('Enter search service API Key');
    await user.type(apiKeyInput, 'tavily-api-key');

    expect(screen.getByRole('button', { name: /Configured/ })).toBeInTheDocument();

    await user.clear(apiKeyInput);

    expect(screen.getByRole('button', { name: /Custom required/ })).toBeInTheDocument();
  });

  it('treats a SearXNG service URL as a complete custom configuration', () => {
    useSettingsStore.setState({
      auxiliaryServices: {
        webSearch: {
          provider: 'searxng',
          apiKey: '',
          baseUrl: 'http://localhost:8080',
        },
      },
    });

    renderSection();

    expect(screen.getByRole('button', { name: /Configured/ })).toBeInTheDocument();
  });

  it('says which provider brings web search with it, with nothing to set up', () => {
    useSettingsStore.setState({ providers: [provider({ capabilities: { webSearch: { type: 'parameter', paramName: 'enable_search', paramValue: true } } })] });

    renderSection();

    expect(screen.getByText('Built-in via Service A')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Custom required|Configured/ })).not.toBeInTheDocument();
  });
});

describe('AIServicesSection providers', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useSettingsStore.setState({
      providers: [],
      activeModel: { providerId: '', modelId: '' },
      auxiliaryServices: {},
      imageGeneration: { backends: [] },
    });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState(originals, true);
  });

  it('offers to add a service when there is none', () => {
    renderSection();

    expect(screen.getByText('No AI services yet')).toBeInTheDocument();
    expect(screen.getByText('Add an AI service to get started')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add AI Service' })).toBeInTheDocument();
    expect(screen.queryByText(/enabled$/)).not.toBeInTheDocument();
  });

  it('lists the services the user set up, the ones switched on first, and counts those', () => {
    useSettingsStore.setState({
      providers: [
        provider({ id: 'off', name: 'Service Off', enabled: false, sortOrder: 9 }),
        provider({ id: 'low', name: 'Service Low', sortOrder: 1 }),
        provider({ id: 'high', name: 'Service High', sortOrder: 5 }),
        provider({ id: 'untouched', name: 'Service Untouched', enabled: false, apiKey: '', userAdded: false }),
        provider({ id: 'legacy', name: 'Service Legacy', enabled: false, userAdded: false }),
      ],
    });

    renderSection();

    expect(screen.getAllByText(/^Service /).map((node) => node.textContent)).toEqual([
      'Service High', 'Service Low', 'Service Off', 'Service Legacy',
    ]);
    expect(screen.getByText('2 enabled')).toBeInTheDocument();
    expect(screen.queryByText('No AI services yet')).not.toBeInTheDocument();
  });

  it('marks the service in use with the selected fill, and no other', () => {
    useSettingsStore.setState({
      providers: [provider({ id: 'low', name: 'Service Low', sortOrder: 1 }), provider({ id: 'high', name: 'Service High', sortOrder: 5 })],
      activeModel: { providerId: 'low', modelId: 'model-a' },
    });

    renderSection();

    expect(screen.getByText('Service Low').closest('div.group')).toHaveClass('bg-fill-selected');
    expect(screen.getByText('Service High').closest('div.group')).not.toHaveClass('bg-fill-selected');
  });

  it('has one filled button, with or without services', () => {
    renderSection();
    expect(filledButtons().map((button) => button.textContent)).toEqual(['Add']);
    cleanup();

    useSettingsStore.setState({ providers: [provider()] });
    renderSection();
    expect(filledButtons().map((button) => button.textContent)).toEqual(['Add']);
  });

  it('keeps the service cards still while the user types a search key', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ providers: [provider({ apiKey: '' })] });
    renderSection();
    await user.click(screen.getByRole('button', { name: /Custom required/ }));
    iconButtonRenders.labels = [];

    await user.type(screen.getByPlaceholderText('Enter search service API Key'), 'ab');

    expect(iconButtonRenders.labels.filter((label) => ['Edit', 'Revalidate', 'Delete'].includes(label))).toEqual([]);
  });

  it('groups the two abilities under their heading and says whether each is open', async () => {
    const user = userEvent.setup();
    renderSection();

    expect(screen.getByRole('heading', { level: 4, name: 'Auxiliary Capabilities' })).toBeInTheDocument();
    const search = screen.getByRole('button', { name: /Custom required/ });
    const images = screen.getByRole('button', { name: /Not configured/ });
    expect(search).toHaveAttribute('aria-expanded', 'false');
    expect(images).toHaveAttribute('aria-expanded', 'false');

    await user.click(search);
    await user.click(images);

    expect(search).toHaveAttribute('aria-expanded', 'true');
    expect(images).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('No image-generation backends configured yet')).toBeInTheDocument();
  });
});

describe('AIServicesSection image generation', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useSettingsStore.setState({ providers: [], auxiliaryServices: {}, imageGeneration: { backends: [] } });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState(originals, true);
  });

  it('opens the backend form from the row, and counts the backend once it is saved', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.getByRole('button', { name: /Not configured/ })).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Add' }).at(-1)!);
    fireEvent.change(screen.getByPlaceholderText('e.g. Volcano Seedream'), { target: { value: 'Seedream' } });
    fireEvent.change(screen.getByPlaceholderText(/^e\.g\. https:\/\/ark/), { target: { value: 'https://images.example.test/api/v3' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. doubao-seedream-4-5'), { target: { value: 'seedream-test' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByPlaceholderText('e.g. Volcano Seedream')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 backend\(s\) configured/ })).toBeInTheDocument();
  });

  it('shows the backends under the row and opens one for editing', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      imageGeneration: { backends: [{ id: 'backend-a', name: 'Seedream', vendor: 'custom', baseUrl: 'https://images.example.test/api/v3', apiKey: '', model: 'seedream-test' }] },
    });
    renderSection();
    expect(screen.queryByText('seedream-test')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /1 backend\(s\) configured/ }));
    expect(screen.getByText('seedream-test')).toBeInTheDocument();

    await user.click(backendAction('Edit Backend'));

    expect((screen.getByPlaceholderText('e.g. Volcano Seedream') as HTMLInputElement).value).toBe('Seedream');
  });
});

describe('AIServicesSection clearing the saved keys', () => {
  const clearAllStoredKeys = vi.fn();

  beforeEach(() => {
    initLanguage('en-US');
    clearAllStoredKeys.mockReset();
    clearAllStoredKeys.mockImplementation(() => originals.clearAllStoredKeys());
    useSettingsStore.setState({
      clearAllStoredKeys,
      providers: [provider()],
      auxiliaryServices: { webSearch: { provider: 'tavily', apiKey: FAKE_KEY, baseUrl: '' } },
      imageGeneration: { backends: [{ id: 'backend-a', name: 'Seedream', vendor: 'custom', baseUrl: 'https://images.example.test/api/v3', apiKey: FAKE_KEY, model: 'seedream-test' }] },
    });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState(originals, true);
  });

  it('is not offered when no service has a key', () => {
    useSettingsStore.setState({ providers: [provider({ apiKey: '' })] });

    renderSection();

    expect(screen.queryByRole('button', { name: 'Clear all stored keys' })).not.toBeInTheDocument();
  });

  it('asks first, and clears nothing when the user cancels', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Clear all stored keys' }));
    // The question takes no pointer press for a moment after it appears: it has been read.
    passSettleInterval();

    expect(screen.getByRole('alertdialog', { name: 'Clear all stored keys' })).toBeInTheDocument();
    expect(screen.getByText(/^This removes every provider and auxiliary-service API key/)).toBeInTheDocument();
    expect(clearAllStoredKeys).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(clearAllStoredKeys).not.toHaveBeenCalled();
    expect(screen.queryByText(/^This removes every provider/)).not.toBeInTheDocument();
    expect(useSettingsStore.getState().providers[0].apiKey).toBe(FAKE_KEY);
  });

  it('clears every saved key once the user confirms, and keeps the services listed', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Clear all stored keys' }));
    // The question takes no pointer press for a moment after it appears: it has been read.
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(clearAllStoredKeys).toHaveBeenCalledTimes(1);
    expect(clearAllStoredKeys).toHaveBeenCalledWith();
    await waitFor(() => expect(useSettingsStore.getState().providers[0].apiKey).toBe(''));
    const state = useSettingsStore.getState();
    expect(state.auxiliaryServices.webSearch?.apiKey).toBe('');
    expect(state.imageGeneration.backends[0].apiKey).toBe('');
    expect(screen.getByText('Service A')).toBeInTheDocument();
    expect(screen.queryByText(/^This removes every provider/)).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear all stored keys' })).not.toBeInTheDocument());
  });
});
