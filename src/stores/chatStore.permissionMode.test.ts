// @vitest-environment happy-dom
// The chat store persists through `window.localStorage` (TESTING.md §6: a
// store with persist opts into a DOM); without it every `set` in this file
// would go through the persist middleware's storage-unavailable branch.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import { PERMISSION_MODES } from '../core/permissions/permissionMode';
import type { ConversationMeta } from '../core/session/conversationStorage';
import { useChatStore, waitForConversationPersistence } from './chatStore';

// The workspace store starts a real skill scan whenever the workspace changes;
// these tests are about the conversation store alone.
vi.mock('./workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({ setWorkspace: vi.fn(), clearWorkspace: vi.fn(), currentPath: null }),
    subscribe: vi.fn(),
  },
}));

/**
 * The conversation's row as the last `index.json` write holds it. The index
 * writer is real; the file system under it is the global `invoke` mock.
 */
async function indexEntryOnDisk(convId: string): Promise<Record<string, unknown> | undefined> {
  await waitForConversationPersistence(convId);
  const { flushIndex } = await import('../core/session/conversationStorage');
  await flushIndex();
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

function seedIndex(entries: Record<string, Partial<ConversationMeta> & Record<string, unknown>>): void {
  const conversationIndex = Object.fromEntries(Object.entries(entries).map(([id, extra]) => [
    id,
    { id, title: 't', createdAt: 1, updatedAt: 1, messageCount: 0, ...extra },
  ]));
  useChatStore.setState({ conversations: {}, conversationIndex } as never);
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(exists).mockResolvedValue(false);
  useChatStore.setState({
    conversations: {},
    conversationIndex: {},
    activeConversationId: null,
    pendingPermissionMode: undefined,
  });
});

describe('permission mode is persisted with the conversation', () => {
  it('the setter writes the conversation, its index entry and index.json', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().setConversationPermissionMode(id, 'autonomous');

    expect(useChatStore.getState().conversations[id].permissionMode).toBe('autonomous');
    expect(useChatStore.getState().conversationIndex[id].permissionMode).toBe('autonomous');
    expect((await indexEntryOnDisk(id))?.permissionMode).toBe('autonomous');
  });

  it('clearing the mode removes the key from the index entry and from index.json', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().setConversationPermissionMode(id, 'smart');
    useChatStore.getState().setConversationPermissionMode(id, undefined);

    expect(useChatStore.getState().conversations[id].permissionMode).toBeUndefined();
    expect('permissionMode' in useChatStore.getState().conversationIndex[id]).toBe(false);
    const onDisk = await indexEntryOnDisk(id);
    expect(onDisk).toBeDefined();
    expect('permissionMode' in onDisk!).toBe(false);
  });

  it('a mode outside the closed set is refused and changes nothing', () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().setConversationPermissionMode(id, 'smart');
    expect(() => useChatStore.getState().setConversationPermissionMode(id, 'strict' as never)).toThrow(TypeError);
    expect(useChatStore.getState().conversations[id].permissionMode).toBe('smart');
    expect(useChatStore.getState().conversationIndex[id].permissionMode).toBe('smart');
  });

  it('the mode picked before the conversation existed lands in its index entry', async () => {
    useChatStore.getState().setPendingPermissionMode('autonomous');
    const id = useChatStore.getState().createConversation(null);
    expect(useChatStore.getState().conversations[id].permissionMode).toBe('autonomous');
    expect(useChatStore.getState().conversationIndex[id].permissionMode).toBe('autonomous');
    expect(useChatStore.getState().pendingPermissionMode).toBeUndefined();
    expect((await indexEntryOnDisk(id))?.permissionMode).toBe('autonomous');
  });

  it('a conversation created in the background takes no pick and leaves it for the user', async () => {
    // The pick belongs to the conversation the user is about to open. A
    // scheduler / trigger / IM / watcher creation passes skipActivate: it
    // would otherwise run — and now keep for ever — an authority the user
    // chose for a conversation of their own.
    useChatStore.getState().setPendingPermissionMode('autonomous');
    const background = useChatStore.getState().createConversation(null, { skipActivate: true });

    expect(useChatStore.getState().conversations[background].permissionMode).toBeUndefined();
    expect('permissionMode' in useChatStore.getState().conversationIndex[background]).toBe(false);
    const onDisk = await indexEntryOnDisk(background);
    expect(onDisk).toBeDefined();
    expect('permissionMode' in onDisk!).toBe(false);
    expect(useChatStore.getState().pendingPermissionMode).toBe('autonomous');
  });

  it('the pick a background creation left alone goes to the next conversation the user opens', () => {
    useChatStore.getState().setPendingPermissionMode('autonomous');
    useChatStore.getState().createConversation(null, { skipActivate: true });

    const mine = useChatStore.getState().createConversation(null);
    expect(useChatStore.getState().conversations[mine].permissionMode).toBe('autonomous');
    expect(useChatStore.getState().conversationIndex[mine].permissionMode).toBe('autonomous');
    expect(useChatStore.getState().pendingPermissionMode).toBeUndefined();
  });

  it('a conversation created without a pick has no mode of its own', () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    expect(useChatStore.getState().conversations[id].permissionMode).toBeUndefined();
    expect('permissionMode' in useChatStore.getState().conversationIndex[id]).toBe(false);
  });

  it('an index entry carrying a mode outside the closed set reaches index.json without it', async () => {
    // The rehydrate merge keeps localStorage rows younger than 60s that have no
    // disk row; those never passed the index reader. Every index write asks the
    // rule, so such a row cannot make a refused mode durable.
    seedIndex({ local: { permissionMode: 'strict', model: { providerId: 'p', modelId: 'm' } } });
    const { updateIndexEntry } = await import('../core/session/conversationStorage');
    await updateIndexEntry(useChatStore.getState().conversationIndex.local);

    const onDisk = await indexEntryOnDisk('local');
    expect(onDisk).toBeDefined();
    expect('permissionMode' in onDisk!).toBe(false);
    expect(onDisk!.model).toEqual({ providerId: 'p', modelId: 'm' });
  });
});

describe('permission mode is restored when a conversation is loaded', () => {
  it('restores a mode of the closed set and leaves a plain conversation without one', async () => {
    seedIndex({ c1: { permissionMode: 'autonomous' }, c2: {} });
    await useChatStore.getState().loadConversation('c1');
    await useChatStore.getState().loadConversation('c2');
    expect(useChatStore.getState().conversations.c1?.permissionMode).toBe('autonomous');
    expect(useChatStore.getState().conversations.c2?.permissionMode).toBeUndefined();
  });

  it('an unloaded conversation comes back with its mode', async () => {
    const ids = Array.from({ length: 7 }, () => useChatStore.getState().createConversation(null, { skipActivate: true }));
    useChatStore.setState((state) => {
      ids.forEach((id, i) => { state.conversations[id].updatedAt = i + 1; });
      state.activeConversationId = ids[6];
    });
    useChatStore.getState().setConversationPermissionMode(ids[0], 'smart');

    useChatStore.getState().unloadOldConversations();
    expect(useChatStore.getState().conversations[ids[0]]).toBeUndefined();

    await useChatStore.getState().loadConversation(ids[0]);
    expect(useChatStore.getState().conversations[ids[0]]?.permissionMode).toBe('smart');
  });

  it('the index row of one conversation never lands on another', async () => {
    const ids = Array.from({ length: 7 }, () => useChatStore.getState().createConversation(null, { skipActivate: true }));
    useChatStore.setState((state) => {
      ids.forEach((id, i) => { state.conversations[id].updatedAt = i + 1; });
      state.activeConversationId = ids[6];
    });
    useChatStore.getState().setConversationPermissionMode(ids[0], 'autonomous');
    useChatStore.getState().setConversationPermissionMode(ids[1], 'smart');

    useChatStore.getState().unloadOldConversations();
    for (const id of ids) await useChatStore.getState().loadConversation(id);

    expect(useChatStore.getState().conversations[ids[0]]?.permissionMode).toBe('autonomous');
    expect(useChatStore.getState().conversations[ids[1]]?.permissionMode).toBe('smart');
    for (const id of ids.slice(2)) {
      expect(useChatStore.getState().conversations[id]?.permissionMode).toBeUndefined();
    }
  });

  it('a conversation whose messages cannot be read still carries and keeps its mode', async () => {
    // The load's failure branch builds the conversation from the index entry
    // alone; the next index write must still hold the mode.
    seedIndex({ 'unreadable-conv': { permissionMode: 'autonomous' } });
    vi.mocked(exists).mockImplementation(async (path: string) => {
      if (String(path).includes('unreadable-conv')) throw new Error('unreadable');
      return false;
    });

    await useChatStore.getState().loadConversation('unreadable-conv');
    expect(useChatStore.getState().conversations['unreadable-conv']?.permissionMode).toBe('autonomous');

    vi.mocked(exists).mockResolvedValue(false);
    useChatStore.getState().addMessage('unreadable-conv', {
      id: 'm1', role: 'user', content: 'hi', timestamp: 1,
    });
    expect((await indexEntryOnDisk('unreadable-conv'))?.permissionMode).toBe('autonomous');
  });

  it('a running conversation keeps the mode its run is executing under', async () => {
    // The gate reads the live conversation. A load never replaces one that is
    // already in memory, so nothing restored mid-run can widen that run.
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().setConversationPermissionMode(id, 'standard');
    useChatStore.setState((state) => {
      state.conversations[id].status = 'running';
      state.conversationIndex[id].permissionMode = 'autonomous';
    });

    await useChatStore.getState().loadConversation(id);
    expect(useChatStore.getState().conversations[id].permissionMode).toBe('standard');

    useChatStore.getState().unloadOldConversations();
    expect(useChatStore.getState().conversations[id]).toBeDefined();
  });

  it('a scheduled task\'s conversation keeps the mode the run stamped on it', async () => {
    // The scheduler's sequence: create in the background, then stamp the task's mode.
    const id = useChatStore.getState().createConversation(null, { scheduledTaskId: 'task-1', skipActivate: true });
    useChatStore.getState().setConversationPermissionMode(id, 'autonomous');
    const onDisk = await indexEntryOnDisk(id);
    expect(onDisk).toMatchObject({ scheduledTaskId: 'task-1', permissionMode: 'autonomous' });

    // After a restart the store holds the index only; the user opens the conversation.
    seedIndex({ [id]: onDisk as Partial<ConversationMeta> });
    await useChatStore.getState().loadConversation(id);
    expect(useChatStore.getState().conversations[id]).toMatchObject({
      scheduledTaskId: 'task-1', permissionMode: 'autonomous',
    });
  });

  const CANDIDATES: unknown[] = [...PERMISSION_MODES, 'strict', 'default', 'auto', 'AUTONOMOUS', '', null, 1, {}, ['autonomous']];
  for (const candidate of CANDIDATES) {
    it(`restores ${JSON.stringify(candidate)} exactly when the setter accepts it`, async () => {
      const live = useChatStore.getState().createConversation(null, { skipActivate: true });
      let setterAccepts = true;
      try {
        useChatStore.getState().setConversationPermissionMode(live, candidate as never);
      } catch {
        setterAccepts = false;
      }

      seedIndex({ restored: { permissionMode: candidate } });
      await useChatStore.getState().loadConversation('restored');
      expect(useChatStore.getState().conversations.restored?.permissionMode)
        .toBe(setterAccepts ? candidate : undefined);
    });
  }
});

describe('a raw conversation JSON', () => {
  const RAW = {
    id: 'old',
    title: 'T',
    createdAt: 1,
    updatedAt: 2,
    status: 'idle',
    messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    permissionMode: 'autonomous',
  };

  it('from a file sets no permission mode, in memory or on disk', async () => {
    const newId = useChatStore.getState().importConversation(JSON.stringify(RAW))!;
    expect(useChatStore.getState().conversations[newId].permissionMode).toBeUndefined();
    expect('permissionMode' in useChatStore.getState().conversations[newId]).toBe(false);
    expect('permissionMode' in useChatStore.getState().conversationIndex[newId]).toBe(false);

    await vi.waitFor(async () => expect(await indexEntryOnDisk(newId)).toBeDefined());
    expect('permissionMode' in (await indexEntryOnDisk(newId))!).toBe(false);
  });

  it('from the undo of a delete keeps an accepted mode', async () => {
    const newId = useChatStore.getState().importConversation(JSON.stringify(RAW), { keepPermissionMode: true })!;
    expect(useChatStore.getState().conversations[newId].permissionMode).toBe('autonomous');
    expect(useChatStore.getState().conversationIndex[newId].permissionMode).toBe('autonomous');
    await vi.waitFor(async () => expect((await indexEntryOnDisk(newId))?.permissionMode).toBe('autonomous'));
  });

  it('a kept mode still passes the rule', () => {
    const newId = useChatStore.getState().importConversation(
      JSON.stringify({ ...RAW, permissionMode: 'strict' }),
      { keepPermissionMode: true },
    )!;
    expect('permissionMode' in useChatStore.getState().conversations[newId]).toBe(false);
    expect('permissionMode' in useChatStore.getState().conversationIndex[newId]).toBe(false);
  });
});
