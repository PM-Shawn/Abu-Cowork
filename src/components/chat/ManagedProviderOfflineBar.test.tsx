// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { ManagedProviderOfflineBar } from './ManagedProviderOfflineBar';

let fallback: { providerId: string; modelId: string } | null = null;
const setConversationModel = vi.fn();

vi.mock('@/core/llm/managedProviderRefresh', () => ({
  readManagedProviderPersonalFallback: () => fallback,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { setConversationModel: typeof setConversationModel }) => unknown) =>
    selector({ setConversationModel }),
}));

const managed: ProviderInstance = {
  id: 'org-models',
  source: 'managed',
  name: 'MAZG',
  enabled: true,
  apiFormat: 'openai-compatible',
  baseUrl: 'https://abu.example.net/api/gateway',
  apiKey: 'sk-virtual',
  models: [{ id: 'org-model', label: 'org-model' }],
  status: 'failed',
  sortOrder: Number.MAX_SAFE_INTEGER,
  userAdded: false,
};

function own(id: string, modelIds: string[], overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id,
    source: 'custom',
    name: id,
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: `https://${id}.example.net`,
    apiKey: `sk-${id}`,
    models: modelIds.map((m) => ({ id: m, label: m })),
    status: 'verified',
    sortOrder: 1,
    userAdded: true,
    ...overrides,
  };
}

function renderBar(providers: ProviderInstance[], conversationId: string | null = 'conv-1'): void {
  useSettingsStore.setState({
    providers,
    activeModel: { providerId: 'org-models', modelId: 'org-model' },
    recentModels: [],
  });
  render(<ManagedProviderOfflineBar provider={managed} conversationId={conversationId} />);
}

describe('ManagedProviderOfflineBar', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    fallback = null;
    setConversationModel.mockClear();
  });
  afterEach(cleanup);

  it('names the organization and offers the model used before it took over', async () => {
    fallback = { providerId: 'mine', modelId: 'mine-b' };
    renderBar([managed, own('mine', ['mine-a', 'mine-b'])]);

    expect(screen.getByRole('status')).toHaveTextContent('暂时连不上 MAZG 的模型服务');
    await userEvent.click(screen.getByRole('button', { name: '用我自己的模型' }));

    expect(setConversationModel).toHaveBeenCalledWith('conv-1', { providerId: 'mine', modelId: 'mine-b' });
    expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'org-models', modelId: 'org-model' });
  });

  it('changes the default for new conversations when there is no conversation', async () => {
    fallback = { providerId: 'mine', modelId: 'mine-a' };
    renderBar([managed, own('mine', ['mine-a'])], null);

    await userEvent.click(screen.getByRole('button', { name: '用我自己的模型' }));

    expect(setConversationModel).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().activeModel).toEqual({ providerId: 'mine', modelId: 'mine-a' });
  });

  it('falls back to the first of the user\'s own models when the recorded one is gone', async () => {
    fallback = { providerId: 'gone', modelId: 'gone-model' };
    renderBar([managed, own('other', ['other-a'])]);

    await userEvent.click(screen.getByRole('button', { name: '用我自己的模型' }));

    expect(setConversationModel).toHaveBeenCalledWith('conv-1', { providerId: 'other', modelId: 'other-a' });
  });

  it('shows the notice without a button when the user has no model of their own', () => {
    renderBar([managed, own('off', ['off-a'], { enabled: false })]);

    expect(screen.getByRole('status')).toHaveTextContent('暂时连不上 MAZG 的模型服务');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
