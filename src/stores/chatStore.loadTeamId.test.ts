import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from './chatStore';

vi.mock('../core/session/conversationStorage', async () => {
  const actual = await vi.importActual<typeof import('../core/session/conversationStorage')>('../core/session/conversationStorage');
  return { ...actual, loadMessages: vi.fn(async () => []), replaceMessageById: vi.fn(async () => undefined) };
});

/**
 * Acceptance E1 (2026-09-06): after a restart the team conversation lost its
 * pin because loadConversation rebuilt the record from the index without
 * teamId — auto-resume, member bar and leader route all key on it.
 */
describe('chatStore.loadConversation keeps the team pin', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: {},
      conversationIndex: {
        c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0, teamId: 'team-1', workspacePath: '/ws' },
        c2: { id: 'c2', title: 'p', createdAt: 1, updatedAt: 1, messageCount: 0 },
      },
    } as never);
  });

  it('copies teamId from the index entry (and leaves it undefined for plain conversations)', async () => {
    await useChatStore.getState().loadConversation('c1');
    await useChatStore.getState().loadConversation('c2');
    expect(useChatStore.getState().conversations.c1?.teamId).toBe('team-1');
    expect(useChatStore.getState().conversations.c1?.workspacePath).toBe('/ws');
    expect(useChatStore.getState().conversations.c2?.teamId).toBeUndefined();
  });
});
