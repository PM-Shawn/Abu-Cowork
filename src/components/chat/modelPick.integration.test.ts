// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import { useChatStore, waitForConversationPersistence } from '@/stores/chatStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { applyModelPick } from './modelPick';

const MODEL_A = { providerId: 'provider-a', modelId: 'model-a' };
const MODEL_B = { providerId: 'provider-b', modelId: 'model-b' };

function pick(activeConversationId: string | null | undefined, model = MODEL_B) {
  applyModelPick({ activeConversationId, ...model }, {
    selectModel: useSettingsStore.getState().selectModel,
    setConversationModel: useChatStore.getState().setConversationModel,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  vi.stubGlobal('navigator', { locks: { request: (_name: string, callback: () => unknown) => Promise.resolve(callback()) } });
  vi.mocked(invoke).mockClear();
  vi.mocked(exists).mockResolvedValue(false);
  useEnterpriseStore.setState({ initialized: true });
  useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
  useSettingsStore.setState({ activeModel: MODEL_A, recentModels: [] });
});

afterEach(async () => {
  await Promise.all(Object.keys(useChatStore.getState().conversations).map(waitForConversationPersistence));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('composer model selections across conversations', () => {
  it('remembers the latest pick for new conversations and preserves every existing selection', async () => {
    const chat = useChatStore.getState();
    const first = chat.createConversation(null, { skipActivate: true });
    const second = chat.createConversation(null, { skipActivate: true });
    pick(second);
    const third = chat.createConversation(null, { skipActivate: true });

    expect(useChatStore.getState().conversations[first].model).toEqual(MODEL_A);
    expect(useChatStore.getState().conversations[second].model).toEqual(MODEL_B);
    expect(useChatStore.getState().conversations[third].model).toEqual(MODEL_B);

    await chat.switchConversation(first);
    expect(useSettingsStore.getState().activeModel).toEqual(MODEL_B);
    expect(useSettingsStore.getState().recentModels).toEqual([MODEL_B]);

    const sameIdOnAnotherProvider = { ...MODEL_B, providerId: MODEL_A.providerId };
    pick(first, sameIdOnAnotherProvider);
    expect(useSettingsStore.getState().activeModel).toEqual(sameIdOnAnotherProvider);
    expect(useSettingsStore.getState().recentModels).toEqual([sameIdOnAnotherProvider, MODEL_B]);
    expect(useChatStore.getState().conversations[second].model).toEqual(MODEL_B);
    expect(useChatStore.getState().conversations[third].model).toEqual(MODEL_B);

    await waitForConversationPersistence(first);
    const indexWrite = vi.mocked(invoke).mock.calls.filter(([command, args]) =>
      command === 'atomic_write_text' && String((args as { path?: string })?.path).endsWith('index.json'),
    ).at(-1);
    expect(indexWrite).toBeDefined();
    const index = JSON.parse((indexWrite![1] as { content: string }).content);
    expect(index.entries[first].model).toEqual(sameIdOnAnotherProvider);
    expect(index.entries[second].model).toEqual(MODEL_B);
    const settings = JSON.parse(window.localStorage.getItem('abu-settings')!);
    expect(settings.state.activeModel).toEqual(sameIdOnAnotherProvider);
  });

  it.each([null, undefined])('remembers a new-task pick with conversation id %s', (conversationId) => {
    const chat = useChatStore.getState();
    const existing = chat.createConversation(null, { skipActivate: true });
    pick(conversationId);
    const next = chat.createConversation(null, { skipActivate: true });
    expect(useSettingsStore.getState().activeModel).toEqual(MODEL_B);
    expect(useChatStore.getState().conversations[existing].model).toEqual(MODEL_A);
    expect(useChatStore.getState().conversations[next].model).toEqual(MODEL_B);
  });
});
