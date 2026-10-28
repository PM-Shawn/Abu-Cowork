// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConversationModel } from './useConversationModel';

const first = { providerId: 'first-provider', modelId: 'first-model' };
const second = { providerId: 'second-provider', modelId: 'second-model' };
const latest = { providerId: 'latest-provider', modelId: 'latest-model' };

beforeEach(() => {
  useChatStore.setState({
    activeConversationId: 'first',
    conversations: {
      first: { id: 'first', title: 'First', messages: [], createdAt: 1, updatedAt: 1, status: 'idle', model: first },
    },
    conversationIndex: {
      second: { id: 'second', title: 'Second', createdAt: 1, updatedAt: 1, messageCount: 0, lastUserMessageAt: null, model: second },
    },
  });
  useSettingsStore.setState({ activeModel: latest });
});

afterEach(() => {
  cleanup();
  useChatStore.setState({ activeConversationId: null, conversations: {}, conversationIndex: {} });
});

describe('useConversationModel', () => {
  it('follows the open conversation and retains its selection across changes to the new-task default', () => {
    const { result } = renderHook(() => useConversationModel());
    expect(result.current).toEqual(first);
    act(() => useSettingsStore.setState({ activeModel: second }));
    expect(result.current).toEqual(first);
    act(() => useChatStore.setState({ activeConversationId: 'second' }));
    expect(result.current).toEqual(second);
    act(() => useChatStore.setState({ activeConversationId: null }));
    expect(result.current).toEqual(second);
  });

  it('keeps a requesting task selected while another conversation opens', () => {
    const { result } = renderHook(() => useConversationModel('second'));
    expect(result.current).toEqual(second);
    act(() => useChatStore.setState({ activeConversationId: null }));
    expect(result.current).toEqual(second);
  });

  it('uses the latest default for the new-task page and a task without a saved model', () => {
    const { result, rerender } = renderHook(({ id }: { id: string | null }) => useConversationModel(id), {
      initialProps: { id: null } as { id: string | null },
    });
    expect(result.current).toEqual(latest);
    rerender({ id: 'legacy' });
    expect(result.current).toEqual(latest);
  });
});
