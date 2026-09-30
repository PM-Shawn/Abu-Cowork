// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { Menu, MenuItem } from '@/components/ds/menu';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { ModelSelector } from './ModelSelector';

const mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('@/core/llm/managedProviderRefresh', () => ({
  refreshManagedProvider: (...args: unknown[]) => mockRefresh(...args),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: {
    activeConversationId: string | null;
    conversations: Record<string, unknown>;
    setConversationModel: () => void;
  }) => unknown) => selector({ activeConversationId: null, conversations: {}, setConversationModel: () => {} }),
}));

const TRIGGER = 'Pick a model';

// The composer's model button next to another toolbar menu, both inside the app's provider.
function Toolbar({ initiallyOpen }: { initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <DesignSystemProvider>
      <ModelSelector open={open} onOpenChange={setOpen} trigger={<Button>{TRIGGER}</Button>} />
      <Menu trigger={<Button>Add</Button>}>
        <MenuItem>Attach</MenuItem>
      </Menu>
    </DesignSystemProvider>
  );
}

const personal: ProviderInstance = {
  id: 'deepseek',
  source: 'builtin',
  name: 'DeepSeek',
  enabled: true,
  apiFormat: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'sk-personal',
  models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
  status: 'verified',
  sortOrder: 1,
  userAdded: true,
};

function managed(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'org-models',
    source: 'managed',
    name: 'MAZG',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://abu.example.net/api/gateway',
    apiKey: 'sk-virtual',
    models: [{ id: 'deepseek-v3', label: 'deepseek-v3' }],
    status: 'verified',
    sortOrder: Number.MAX_SAFE_INTEGER,
    userAdded: false,
    ...overrides,
  };
}

function open(providers: ProviderInstance[]): void {
  useSettingsStore.setState({
    providers,
    activeModel: { providerId: 'deepseek', modelId: 'deepseek-chat' },
    recentModels: [],
    favoriteModels: [],
  });
  render(<Toolbar initiallyOpen />);
}

function isBefore(first: HTMLElement, second: HTMLElement): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('ModelSelector with a managed provider', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    mockRefresh.mockClear();
  });
  afterEach(cleanup);

  it('lists the organization first, then the user\'s own providers under 我的模型', () => {
    open([managed(), personal]);

    const org = screen.getByText('MAZG');
    const mine = screen.getByText('我的模型');
    const own = screen.getByText('DeepSeek');
    expect(isBefore(org, mine)).toBe(true);
    expect(isBefore(mine, own)).toBe(true);
    expect(screen.getByText('deepseek-v3')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek Chat')).toBeInTheDocument();
  });

  it('looks exactly as before when there is no managed provider', () => {
    open([personal]);

    expect(screen.queryByText('我的模型')).not.toBeInTheDocument();
    expect(screen.getByText('DeepSeek')).toBeInTheDocument();
  });

  it('picking an organization model selects it through the ordinary path', async () => {
    open([managed(), personal]);

    await userEvent.click(screen.getByText('deepseek-v3'));

    expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'org-models', modelId: 'deepseek-v3' });
  });

  it('asks for a fresh list each time it opens', () => {
    open([managed(), personal]);

    expect(mockRefresh).toHaveBeenCalledWith('org-models');
  });

  it('holds the organization\'s place while its list is still loading', () => {
    open([managed({ status: 'checking', models: [] }), personal]);

    expect(screen.getByText('MAZG')).toBeInTheDocument();
    expect(screen.getByText('正在同步可用模型…')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek Chat')).toBeInTheDocument();
  });

  it('says so when the organization cannot be reached, and keeps personal models usable', () => {
    open([managed({ status: 'failed', models: [] }), personal]);

    expect(screen.getByText('暂时连不上 MAZG 的模型服务')).toBeInTheDocument();
    expect(screen.getByText('DeepSeek Chat')).toBeInTheDocument();
  });

  it('hides the organization group when it grants no models', () => {
    open([managed({ status: 'verified', models: [] }), personal]);

    expect(screen.queryByText('MAZG')).not.toBeInTheDocument();
    expect(screen.queryByText('我的模型')).not.toBeInTheDocument();
  });

  it('shows the organization even when the user has no provider of their own', () => {
    open([managed()]);

    expect(screen.getByText('deepseek-v3')).toBeInTheDocument();
    expect(screen.queryByText('我的模型')).not.toBeInTheDocument();
  });
});

describe('ModelSelector as a floating layer', () => {
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  beforeEach(() => {
    initLanguage('zh-CN');
    useSettingsStore.setState({
      providers: [personal],
      activeModel: { providerId: 'deepseek', modelId: 'deepseek-chat' },
      recentModels: [],
      favoriteModels: [],
    });
  });
  afterEach(cleanup);

  it('puts the cursor in the search field when it opens', async () => {
    const user = userEvent.setup();
    render(<Toolbar initiallyOpen={false} />);

    await user.click(screen.getByRole('button', { name: TRIGGER }));

    expect(await screen.findByRole('textbox', { name: '搜索...' })).toHaveFocus();
  });

  it('closes when another menu on the page opens, so only one is ever open', async () => {
    const user = userEvent.setup();
    render(<Toolbar initiallyOpen={false} />);
    await user.click(screen.getByRole('button', { name: TRIGGER }));
    expect(await screen.findByText('DeepSeek Chat')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('menuitem', { name: 'Attach' })).toBeInTheDocument();
    expect(screen.queryByText('DeepSeek Chat')).not.toBeInTheDocument();
  });

  it('closes on Escape and puts focus back on its button', async () => {
    const user = userEvent.setup();
    render(<Toolbar initiallyOpen={false} />);
    const trigger = screen.getByRole('button', { name: TRIGGER });
    await user.click(trigger);
    expect(await screen.findByText('DeepSeek Chat')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByText('DeepSeek Chat')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('marks the model in use as selected with a check', () => {
    open([personal]);

    const row = screen.getByText('DeepSeek Chat').closest('[role="button"]');
    expect(row).toHaveClass('bg-fill-selected');
    // The check, then the favorite star.
    expect(row?.querySelectorAll('svg')).toHaveLength(2);
  });

  it('adds a model to favorites from its row without picking it', async () => {
    const user = userEvent.setup();
    open([personal]);

    await user.click(screen.getByRole('button', { name: 'Favorite' }));

    expect(useSettingsStore.getState().favoriteModels).toEqual([{ providerId: 'deepseek', modelId: 'deepseek-chat' }]);
    expect(screen.getByText('Favorites')).toBeInTheDocument();
  });
});
