// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { createRef } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageSetting, initLanguage, type LanguageSetting } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { ModelSelector } from './ModelSelector';

vi.mock('@/core/llm/managedProviderRefresh', () => ({
  refreshManagedProvider: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/stores/chatStore', () => ({
  useActiveConversation: () => undefined,
  useChatStore: (selector: (state: { setConversationModel: () => void }) => unknown) =>
    selector({ setConversationModel: () => {} }),
}));

const lmstudio: ProviderInstance = {
  id: 'lmstudio',
  source: 'builtin',
  name: 'LM Studio',
  enabled: true,
  apiFormat: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: '',
  models: [
    { id: 'qwen3-vl-8b', label: 'qwen3-vl-8b' },
    { id: 'deepseek-chat', label: 'deepseek-chat' },
    { id: 'gemma-private', label: 'gemma-private', declaredCapabilities: { supportsImages: true } },
  ],
  status: 'verified',
  sortOrder: 0,
};

describe('ModelSelector 能看图 tag', () => {
  let previous: LanguageSetting;

  beforeEach(() => {
    previous = getLanguageSetting();
    initLanguage('zh-CN');
    useSettingsStore.setState({
      providers: [lmstudio],
      activeModel: { providerId: 'lmstudio', modelId: 'deepseek-chat' },
      recentModels: [],
      favoriteModels: [],
    });
    render(<ModelSelector open onClose={() => {}} anchorRef={createRef<HTMLElement>()} />);
  });

  afterEach(() => {
    cleanup();
    initLanguage(previous);
  });

  function rowOf(label: string): HTMLElement {
    return screen.getByText(label).closest('[role="button"]') as HTMLElement;
  }

  it('marks models that can see images', () => {
    expect(rowOf('qwen3-vl-8b')).toHaveTextContent('能看图');
    expect(rowOf('gemma-private')).toHaveTextContent('能看图');
  });

  it('leaves the tag off models that cannot', () => {
    expect(rowOf('deepseek-chat')).not.toHaveTextContent('能看图');
  });

  it('reads the model name and the tag as separate words', () => {
    expect(rowOf('qwen3-vl-8b')).toHaveAccessibleName('qwen3-vl-8b，能看图');
    expect(rowOf('deepseek-chat')).toHaveAccessibleName('deepseek-chat');
    act(() => initLanguage('en-US'));
    expect(rowOf('qwen3-vl-8b')).toHaveAccessibleName('qwen3-vl-8b, can see images');
    expect(rowOf('deepseek-chat')).toHaveAccessibleName('deepseek-chat');
  });
});
