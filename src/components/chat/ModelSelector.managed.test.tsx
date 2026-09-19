// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { createRef } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { ModelSelector } from './ModelSelector';

const mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('@/core/llm/managedProviderRefresh', () => ({
  refreshManagedProvider: (...args: unknown[]) => mockRefresh(...args),
}));

vi.mock('@/stores/chatStore', () => ({
  useActiveConversation: () => undefined,
  useChatStore: (selector: (state: { setConversationModel: () => void }) => unknown) =>
    selector({ setConversationModel: () => {} }),
}));

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
  render(<ModelSelector open onClose={() => {}} anchorRef={createRef<HTMLElement>()} />);
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
