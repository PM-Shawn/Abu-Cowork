// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exists } from '@tauri-apps/plugin-fs';
import type { ConversationBranchOrigin } from '@/types';
import { flushIndex } from '@/core/session/conversationStorage';
import { useChatStore, waitForConversationPersistence } from './chatStore';

const branchOrigin: ConversationBranchOrigin = {
  version: 1, sourceConversationId: 'parent', sourceMessageId: 'parent-answer',
  sourceTitle: 'Parent title', inheritedThroughMessageId: 'child-answer',
};

function entry(id: string) {
  return { id, title: id, createdAt: 1, updatedAt: 1, messageCount: 0 };
}

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  vi.mocked(exists).mockResolvedValue(false);
  useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
});

describe('branch history metadata across the store and writer', () => {
  it('persists a conversation MCP selection through eviction and reload', async () => {
    useChatStore.setState({ conversationIndex: { 'mcp-branch': { ...entry('mcp-branch'), branchOrigin } } });
    await useChatStore.getState().loadConversation('mcp-branch');
    useChatStore.getState().toggleMCPServer('mcp-branch', 'selected-server');
    await waitForConversationPersistence('mcp-branch');
    expect(useChatStore.getState().conversationIndex['mcp-branch'].enabledMCPServers).toEqual(['selected-server']);
    useChatStore.setState({ conversations: {} });
    await useChatStore.getState().loadConversation('mcp-branch');
    expect(useChatStore.getState().conversations['mcp-branch'].enabledMCPServers).toEqual(['selected-server']);
    useChatStore.getState().renameMCPServerReferences('selected-server', 'renamed-server');
    await waitForConversationPersistence('mcp-branch');
    expect(useChatStore.getState().conversationIndex['mcp-branch'].enabledMCPServers).toEqual(['renamed-server']);
  });

  it('clears the initial-open marker without changing its origin', async () => {
    useChatStore.setState({ conversationIndex: { 'first-open': { ...entry('first-open'), branchOrigin, branchInitialOpenPending: true } } });
    await useChatStore.getState().loadConversation('first-open');
    useChatStore.getState().completeBranchInitialOpen('first-open');
    await waitForConversationPersistence('first-open');
    expect(useChatStore.getState().conversationIndex['first-open']).toMatchObject({ branchOrigin });
    expect(useChatStore.getState().conversationIndex['first-open'].branchInitialOpenPending).toBeUndefined();
  });

  it('turns an edited inherited user message into a new ordinary turn', async () => {
    const id = useChatStore.getState().importConversation(JSON.stringify({ ...entry('edited'), status: 'idle', branchOrigin,
      messages: [{ id: 'inherited-question', role: 'user', content: 'Original', timestamp: 1, inheritedFromBranch: true }] }));
    await waitForConversationPersistence(id);
    useChatStore.getState().editMessage(id, 'inherited-question', 'Revised');
    expect(useChatStore.getState().conversations[id].messages[0]).toMatchObject({ content: 'Revised' });
    expect(useChatStore.getState().conversations[id].messages[0].inheritedFromBranch).toBeUndefined();
  });
  it('loads a branch from the index, evicts it, and restores its origin without changing another conversation', async () => {
    const conversationIndex = Object.fromEntries(Array.from({ length: 7 }, (_, i) => {
      const id = `branch-cache-${i}`;
      return [id, { ...entry(id), updatedAt: i + 1, ...(i === 0 ? { branchOrigin, branchInitialOpenPending: true as const } : {}) }];
    }));
    useChatStore.setState({ conversationIndex, activeConversationId: 'branch-cache-6' });
    for (const id of Object.keys(conversationIndex)) await useChatStore.getState().loadConversation(id);
    expect(useChatStore.getState().conversations['branch-cache-0']).toMatchObject({ branchOrigin, branchInitialOpenPending: true });
    useChatStore.getState().unloadOldConversations();
    expect(useChatStore.getState().conversations['branch-cache-0']).toBeUndefined();
    await useChatStore.getState().loadConversation('branch-cache-0');
    expect(useChatStore.getState().conversations['branch-cache-0']).toMatchObject({ branchOrigin, branchInitialOpenPending: true });
    expect(useChatStore.getState().conversations['branch-cache-6']).not.toHaveProperty('branchOrigin');
    expect(useChatStore.getState().conversations['branch-cache-6']).not.toHaveProperty('branchInitialOpenPending');
  });

  it('preserves branch metadata and inherited history through undo-delete persistence and reload', async () => {
    const restoredId = useChatStore.getState().importConversation(JSON.stringify({
      ...entry('deleted-branch'), status: 'idle', branchOrigin, branchInitialOpenPending: true,
      messages: [
        { id: 'child-user', role: 'user', content: 'Question', timestamp: 1, inheritedFromBranch: true },
        { id: 'child-answer', role: 'assistant', content: 'Answer', timestamp: 2, streamEnded: true, inheritedFromBranch: true },
      ],
    }), { restoringDeleted: true });
    expect(restoredId).toBeTypeOf('string');
    await waitForConversationPersistence(restoredId!);
    await flushIndex();
    expect(useChatStore.getState().conversationIndex[restoredId!]).toMatchObject({ branchOrigin, branchInitialOpenPending: true });
    const write = vi.mocked(invoke).mock.calls.filter(([command, args]) => command === 'atomic_write_text'
      && String((args as { path?: string })?.path).endsWith('index.json')).at(-1)!;
    const disk = JSON.parse((write[1] as { content: string }).content);
    expect(disk.entries[restoredId!]).toMatchObject({ branchOrigin, branchInitialOpenPending: true });
    expect(useChatStore.getState().conversations[restoredId!].messages.every(message => message.inheritedFromBranch)).toBe(true);
    useChatStore.setState({ conversations: {} });
    await useChatStore.getState().loadConversation(restoredId!);
    expect(useChatStore.getState().conversations[restoredId!]).toMatchObject({ branchOrigin, branchInitialOpenPending: true });
  });

  it('migrates a version 17 cache without adding branch fields to ordinary conversations', async () => {
    const cached = { conversationIndex: { plain: entry('plain'), branch: { ...entry('branch'), branchOrigin } } };
    const migrated = await useChatStore.persist.getOptions().migrate!(cached, 17);
    expect(migrated).toEqual(cached);
    useChatStore.setState(migrated as Parameters<typeof useChatStore.setState>[0]);
    await useChatStore.getState().loadConversation('plain');
    await useChatStore.getState().loadConversation('branch');
    expect(useChatStore.getState().conversations.plain).not.toHaveProperty('branchOrigin');
    expect(useChatStore.getState().conversations.branch.branchOrigin).toEqual(branchOrigin);
    expect(useChatStore.getState().conversations.branch).not.toHaveProperty('branchInitialOpenPending');
  });
});
