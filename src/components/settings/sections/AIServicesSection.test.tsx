/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AIServicesSection from './AIServicesSection';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';

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
    render(<AIServicesSection />);

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

    render(<AIServicesSection />);

    expect(screen.getByRole('button', { name: /Configured/ })).toBeInTheDocument();
  });
});
