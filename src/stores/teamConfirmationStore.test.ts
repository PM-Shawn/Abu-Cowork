import { describe, it, expect, beforeEach } from 'vitest';
import { confirmationKey, pendingFor, useTeamConfirmationStore } from './teamConfirmationStore';

describe('teamConfirmationStore', () => {
  beforeEach(() => useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {} }));

  it('records a pending confirmation once per conversation + kind + detail', () => {
    const store = useTeamConfirmationStore.getState();
    const first = store.add({ conversationId: 'c1', kind: 'command', detail: 'npm publish', member: 'zz发布员' });
    expect(first).not.toBeNull();
    expect(store.add({ conversationId: 'c1', kind: 'command', detail: 'npm publish', member: 'zz发布员' })).toBeNull();
    expect(store.add({ conversationId: 'c2', kind: 'command', detail: 'npm publish' })).not.toBeNull();
    expect(pendingFor(useTeamConfirmationStore.getState().pending, 'c1').map((i) => i.detail)).toEqual(['npm publish']);
    store.remove(first!.id);
    expect(pendingFor(useTeamConfirmationStore.getState().pending, 'c1')).toEqual([]);
  });

  it('one-shot approvals are consumed by exactly one identical request', () => {
    const store = useTeamConfirmationStore.getState();
    const key = confirmationKey({ kind: 'command', detail: 'npm publish' });
    expect(store.consumeApproval('c1', key)).toBe(false);
    store.approveOnce('c1', key);
    expect(store.consumeApproval('c2', key)).toBe(false);
    expect(store.consumeApproval('c1', key)).toBe(true);
    expect(store.consumeApproval('c1', key)).toBe(false);
  });

  it('clearConversation drops both pending items and approvals of that conversation', () => {
    const store = useTeamConfirmationStore.getState();
    store.add({ conversationId: 'c1', kind: 'file', detail: '/tmp/a', path: '/tmp/a', capability: 'write' });
    store.add({ conversationId: 'c2', kind: 'file', detail: '/tmp/b', path: '/tmp/b', capability: 'write' });
    store.approveOnce('c1', 'command:x');
    store.clearConversation('c1');
    const state = useTeamConfirmationStore.getState();
    expect(pendingFor(state.pending, 'c1')).toEqual([]);
    expect(pendingFor(state.pending, 'c2')).toHaveLength(1);
    expect(state.approvedOnce.c1).toBeUndefined();
  });
});
