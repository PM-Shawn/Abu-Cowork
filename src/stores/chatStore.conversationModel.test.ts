// @vitest-environment happy-dom
// The chat store persists through `window.localStorage` (TESTING.md §6: a
// store with persist opts into a DOM).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import { useChatStore, waitForConversationPersistence } from './chatStore';

// The workspace store starts a real skill scan whenever the workspace changes;
// these tests are about the conversation store alone.
vi.mock('./workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ setWorkspace: vi.fn(), clearWorkspace: vi.fn(), currentPath: null }),
    subscribe: vi.fn(),
  },
}));

const MODEL_Y = { providerId: 'provider-y', modelId: 'model-y' };

/**
 * The conversation's row as the last `index.json` write on the mocked file
 * system holds it. Reads only what has already been written — no flush of
 * its own, so it can tell a durable write from a pending one.
 */
function indexEntryFlushedToDisk(convId: string): Record<string, unknown> | undefined {
  const write = vi.mocked(invoke).mock.calls
    .filter(([cmd, args]) => cmd === 'atomic_write_text'
      && String((args as { path?: string } | undefined)?.path).endsWith('index.json'))
    .at(-1);
  if (!write) return undefined;
  const parsed = JSON.parse((write[1] as { content: string }).content) as {
    entries: Record<string, Record<string, unknown>>;
  };
  return parsed.entries[convId];
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(exists).mockResolvedValue(false);
  useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
});

describe('a conversation\'s model is persisted with the conversation', () => {
  it('a picked model is on disk by the time its write reports done', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    await waitForConversationPersistence(id);
    useChatStore.getState().setConversationModel(id, MODEL_Y);

    expect(useChatStore.getState().conversations[id].model).toEqual(MODEL_Y);
    expect(useChatStore.getState().conversationIndex[id].model).toEqual(MODEL_Y);
    await waitForConversationPersistence(id);
    // Read without draining the index writer's debounce: quitting inside that
    // window must not leave the earlier model on disk for the next start.
    expect(indexEntryFlushedToDisk(id)?.model).toEqual(MODEL_Y);
  });

  it('a cleared model is gone from disk by the time its write reports done', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().setConversationModel(id, MODEL_Y);
    await waitForConversationPersistence(id);
    useChatStore.getState().setConversationModel(id, undefined);

    await waitForConversationPersistence(id);
    expect(indexEntryFlushedToDisk(id)?.model).toBeUndefined();
    expect(indexEntryFlushedToDisk(id)).toBeDefined();
  });
});
