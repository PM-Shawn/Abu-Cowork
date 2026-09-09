// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import type { Message } from '@/types';
import type { ExpertContact } from '@/types/expertContact';
import * as store from './chatStore';
import { foldMessageLog } from '@/core/session/messageLedger';

const files = new Map<string, string>();
const contact: ExpertContact = { identity: { key: 'team:t1', kind: 'team', name: 'Analysts', avatar: 'icon:chart-bar/blue' }, introduction: 'Who is the report for?' };
let sequence = 0;
const user = (id: string): Message => ({ id: `user-${id}`, role: 'user', content: 'Colleagues', timestamp: 101 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(100 + sequence++);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  files.clear();
  vi.mocked(exists).mockImplementation(async (path) => files.has(String(path)));
  vi.mocked(readTextFile).mockImplementation(async (path) => files.get(String(path)) ?? '');
  vi.mocked(invoke).mockReset().mockImplementation(async (cmd, args) => {
    const { path, data } = (args ?? {}) as { path: string; data: string };
    if (cmd === 'append_file_text') files.set(path, (files.get(path) ?? '') + data);
    return undefined;
  });
  store.useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, pendingAgentName: null, pendingTeamId: undefined, pendingExpertContact: null, stagedExpertContacts: {}, expertContactReceipts: {} });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function prepare(value = contact) {
  const chat = store.useChatStore.getState();
  const id = chat.createConversation(null, { teamId: 't1' });
  chat.stageExpertContact(id, value);
  return id;
}
function persisted(id: string) {
  const raw = [...files.entries()].find(([path]) => path.endsWith(`/${id}/messages.jsonl`))?.[1] ?? '';
  return foldMessageLog(raw.split('\n')).messages;
}

describe('first contact persistence', () => {
  it('opening and leaving a greeting creates no history or completed receipt', () => {
    const chat = store.useChatStore.getState();
    chat.setPendingExpertContact(contact);
    expect(store.useChatStore.getState().conversationIndex).toEqual({});
    chat.startNewConversation();
    expect(store.useChatStore.getState().pendingExpertContact).toBeNull();
    expect(store.useChatStore.getState().expertContactReceipts).toEqual({});
  });

  it('writes the frozen greeting before the first user row and confirms only after persistence', async () => {
    const id = prepare();
    store.useChatStore.getState().addMessage(id, user(id));
    expect(store.useChatStore.getState().expertContactReceipts['team:t1'].confirmed).toBe(false);
    await store.waitForConversationPersistence(id);
    const messages = persisted(id);
    expect(messages.map((m) => m.id)).toEqual([`expert-introduction:${id}`, `user-${id}`]);
    expect(messages[0]).toMatchObject({ introduction: contact.identity, content: contact.introduction });
    expect(store.useChatStore.getState().expertContactReceipts['team:t1'].confirmed).toBe(true);
    // A crash after JSONL but before the confirmed localStorage update recovers from the real ledger.
    store.useChatStore.setState({ expertContactReceipts: { 'team:t1': { conversationId: id, confirmed: false } } });
    await store.useChatStore.getState().recoverExpertContacts();
    expect(store.useChatStore.getState().expertContactReceipts['team:t1'].confirmed).toBe(true);
  });

  it('direct attachment entry records contact without adding a greeting', async () => {
    const id = prepare({ identity: contact.identity });
    store.useChatStore.getState().addMessage(id, { ...user(id), content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'image' } }] });
    await store.waitForConversationPersistence(id);
    expect(persisted(id)).toHaveLength(1);
    expect(persisted(id)[0].expertContactKey).toBe('team:t1');
  });

  it('preserves a shown greeting when another conversation confirms contact before this reply', async () => {
    const id = prepare();
    const earlierReceipt = { conversationId: 'earlier-conversation', confirmed: true };
    store.useChatStore.setState({ expertContactReceipts: { 'team:t1': earlierReceipt } });
    store.useChatStore.getState().addMessage(id, user(id));
    await store.waitForConversationPersistence(id);
    const messages = persisted(id);
    expect(messages.map((m) => m.id)).toEqual([`expert-introduction:${id}`, `user-${id}`]);
    expect(messages[0]).toMatchObject({ introduction: contact.identity, content: contact.introduction });
    expect(store.useChatStore.getState().expertContactReceipts['team:t1']).toEqual(earlierReceipt);
  });

  it('does not consume first contact when disk persistence fails, nor recover a greeting without a user receipt', async () => {
    const id = prepare();
    vi.mocked(invoke).mockRejectedValue(new Error('disk full'));
    store.useChatStore.getState().addMessage(id, user(id));
    await expect(store.waitForConversationPersistence(id)).rejects.toThrow('disk full');
    expect(store.useChatStore.getState().expertContactReceipts['team:t1'].confirmed).toBe(false);
    await store.useChatStore.getState().recoverExpertContacts();
    expect(store.useChatStore.getState().expertContactReceipts).toEqual({});
  });

  it('confirms a durable first reply even when an overlapping recovery read saw only its greeting', async () => {
    const id = prepare();
    const diskWrite = vi.mocked(invoke).getMockImplementation()!;
    let releaseUser!: () => void;
    let noteUserWrite!: () => void;
    const userWriting = new Promise<void>((resolve) => { noteUserWrite = resolve; });
    const held = new Promise<void>((resolve) => { releaseUser = resolve; });
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === 'append_file_text' && String((args as { data: string }).data).includes(user(id).id)) {
        noteUserWrite();
        await held;
      }
      return diskWrite(cmd, args);
    });
    store.useChatStore.getState().addMessage(id, user(id));
    await userWriting;
    // Models startup recovery overlapping the first reply to an old,
    // greeting-only ledger. Recovery has no durable user receipt yet.
    await store.useChatStore.getState().recoverExpertContacts();
    releaseUser();
    await store.waitForConversationPersistence(id);
    expect(persisted(id)).toHaveLength(2);
    expect(store.useChatStore.getState().expertContactReceipts['team:t1']).toMatchObject({ confirmed: true });
  });

  it('repairs a failed first append on retry and does not duplicate the greeting', async () => {
    const id = prepare();
    const diskWrite = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockRejectedValue(new Error('disk full'));
    store.useChatStore.getState().addMessage(id, user(id));
    await expect(store.waitForConversationPersistence(id)).rejects.toThrow();
    vi.mocked(invoke).mockImplementation(diskWrite);
    store.useChatStore.getState().updateUserMessageRun(id, user(id).id, { state: 'running' });
    await store.waitForConversationPersistence(id);
    expect(persisted(id).map((m) => m.id)).toEqual([`expert-introduction:${id}`, `user-${id}`]);
    expect(store.useChatStore.getState().expertContactReceipts['team:t1'].confirmed).toBe(true);
    store.useChatStore.getState().updateUserMessageRun(id, user(id).id, { state: 'completed' });
    await store.waitForConversationPersistence(id);
    expect(persisted(id)).toHaveLength(2);
  });

  it('keeps a pending receipt after a transient recovery read failure', async () => {
    store.useChatStore.setState({ expertContactReceipts: { 'team:t1': { conversationId: 'c1', confirmed: false } } });
    vi.mocked(exists).mockResolvedValue(true);
    vi.mocked(readTextFile).mockRejectedValue(new Error('offline'));
    await store.useChatStore.getState().recoverExpertContacts();
    expect(store.useChatStore.getState().expertContactReceipts['team:t1'].confirmed).toBe(false);
  });

  it('does not apply foreground greeting state to scheduled work or another identity', async () => {
    const chat = store.useChatStore.getState();
    const foreground = chat.createConversation();
    chat.setPendingAgent('analyst');
    chat.setPendingExpertContact(contact);
    vi.setSystemTime(500);
    const background = chat.createConversation(null, { skipActivate: true, scheduledTaskId: 's1', teamId: 't1' });
    chat.stageExpertContact(background, contact);
    chat.addMessage(background, user(background));
    await store.waitForConversationPersistence(background);
    expect(store.useChatStore.getState().pendingAgentName).toBe('analyst');
    expect(store.useChatStore.getState().pendingExpertContact).toEqual(contact);
    expect(persisted(background)[0].expertContactKey).toBeUndefined();
    chat.stageExpertContact(foreground, contact);
    expect(store.useChatStore.getState().stagedExpertContacts).toEqual({});
    chat.setPendingTeamId('other');
    expect(store.useChatStore.getState().pendingExpertContact).toBeNull();
  });
});
