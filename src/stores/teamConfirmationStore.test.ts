// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { confirmationKey, pendingFor, useTeamConfirmationStore, type TeamConfirmationInput } from './teamConfirmationStore';

const item: TeamConfirmationInput = { conversationId: 'c1', member: 'A', kind: 'command', detail: 'execute command', identity: { toolName: 'run_command', parametersDigest: 'cwd-a', cwd: '/a', loopId: 'l1', callId: 't1', dispatchId: 'd1', dispatchFingerprint: 'task-a', requestOrdinal: 1 } };
const retry = (overrides: Partial<TeamConfirmationInput> = {}): TeamConfirmationInput => ({ ...item, identity: { ...item.identity!, loopId: 'retry', callId: 'new-call', dispatchId: 'new-dispatch' }, ...overrides });
const store = () => useTeamConfirmationStore.getState();
function select(mode: 'once' | 'run' = 'once') {
  const pending = store().add(item)!;
  const id = store().selectRetry(pending.id, mode)!;
  store().beginRetry('c1', 'retry', id);
  return id;
}

describe('teamConfirmationStore', () => {
  beforeEach(() => useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {}, runRules: {}, retrySelections: {} }));

  it('does not authorize another member, cwd, conversation or script with the same display text (F1)', () => {
    expect(confirmationKey(item)).not.toBe(confirmationKey({ ...item, member: 'B' }));
    expect(confirmationKey(item)).not.toBe(confirmationKey({ ...item, conversationId: 'c2' }));
    expect(confirmationKey(item)).not.toBe(confirmationKey({ ...item, identity: { ...item.identity!, parametersDigest: 'cwd-b', cwd: '/b' } }));
    const browser = { ...item, kind: 'browser' as const };
    expect(confirmationKey(browser)).not.toBe(confirmationKey({ ...browser, identity: { ...item.identity!, parametersDigest: 'different-script' } }));
    expect(confirmationKey(item)).toBe(confirmationKey({ ...item, detail: 'translated label' } as TeamConfirmationInput));
  });

  it('confirmationKey ignores browser authorization payload fields', () => {
    const base = { conversationId: 'c1', member: 'A', kind: 'browser' as const,
      identity: { toolName: 'browser_fill', parametersDigest: 'd1', cwd: '/w', loopId: 'l', callId: 'c', dispatchId: 'x', dispatchFingerprint: 'f', requestOrdinal: 1 } };
    const withPayload = { ...base, browserOrigin: 'http://127.0.0.1:8765', browserOperationClass: 'interactive' as const, allowPersistentGrant: true, level: 'warn' as const };
    expect(confirmationKey(withPayload)).toBe(confirmationKey(base));
    // The payload must survive the store so the strip can offer a site grant.
    const stored = store().add({ ...withPayload, detail: 'fill #q' })!;
    expect(stored.browserOrigin).toBe('http://127.0.0.1:8765');
    expect(stored.browserOperationClass).toBe('interactive');
    expect(stored.allowPersistentGrant).toBe(true);
    expect(stored.level).toBe('warn');
  });

  it('deduplicates only the same originating call; parallel identical calls remain separate', () => {
    const first = store().add(item)!;
    expect(store().add(item)).toBeNull();
    expect(store().add({ ...item, identity: { ...item.identity!, callId: 'other' } })).not.toBeNull();
    expect(store().add({ ...item, member: 'B' })).not.toBeNull();
    store().remove(first.id);
    expect(pendingFor(store().pending, 'c1')).toHaveLength(2);
  });

  it('only the selected retry turn and original dispatch can consume once', () => {
    const pending = store().add(item)!;
    const id = store().selectRetry(pending.id, 'once')!;
    store().beginRetry('c2', 'retry', id);
    expect(store().consumeApproval(retry())).toBe(false);
    store().beginRetry('c1', 'retry', id);
    store().claimDispatch('c1', 'retry', 'sibling', 'another-task', 'A');
    store().claimDispatch('c1', 'retry', 'sibling', 'task-a', 'B');
    expect(store().consumeApproval(retry())).toBe(false);
    store().claimDispatch('c1', 'retry', 'new-dispatch', 'task-a', 'A');
    store().claimDispatch('c1', 'retry', 'later-sibling', 'task-a', 'A');
    for (const wrong of [retry({ member: 'B' }), retry({ conversationId: 'c2' }), retry({ identity: { ...retry().identity!, cwd: '/b' } }), retry({ identity: { ...retry().identity!, loopId: 'another-run' } }), retry({ identity: { ...retry().identity!, dispatchId: 'later-sibling' } })]) {
      expect(store().consumeApproval(wrong)).toBe(false);
    }
    expect(store().consumeApproval(retry())).toBe(true);
    expect(store().consumeApproval(retry())).toBe(false);
  });

  it('run rules require exact identity, can be revoked and expire with their run', () => {
    const id = select('run');
    expect(store().consumeApproval(retry())).toBe(true);
    expect(store().consumeApproval(retry())).toBe(true);
    expect(store().consumeApproval(retry({ identity: { ...retry().identity!, callId: 'another-call', requestOrdinal: 9 } }))).toBe(true);
    expect(store().consumeApproval(retry({ member: 'B' }))).toBe(false);
    expect(store().consumeApproval(retry({ identity: { ...retry().identity!, parametersDigest: 'other-script' } }))).toBe(false);
    store().clearRun('c2', 'retry');
    expect(store().consumeApproval(retry())).toBe(true);
    store().revoke(id);
    expect(store().consumeApproval(retry())).toBe(false);
    select('run');
    store().clearRun('c1', 'retry');
    expect(store().consumeApproval(retry())).toBe(false);
  });

  it('persists refused requests, never selections or grants, and discards legacy tickets on hydrate', async () => {
    select();
    store().add({ ...item, member: 'B' });
    const persisted = JSON.parse(localStorage.getItem('abu-team-confirmations')!).state;
    expect(Object.keys(persisted)).toEqual(['pending']);
    expect(Object.values(persisted.pending)).toHaveLength(1);
    localStorage.setItem('abu-team-confirmations', JSON.stringify({ state: { ...persisted, approvedOnce: { c1: ['command:x'] }, runRules: store().runRules }, version: 0 }));
    await useTeamConfirmationStore.persist.rehydrate();
    expect(store().approvedOnce).toEqual({});
    expect(store().runRules).toEqual({});
    expect(store().retrySelections).toEqual({});
  });

  it('legacy pending records confer no authority; deleting a conversation removes all its state', () => {
    const legacy = store().add({ ...item, identity: undefined })!;
    expect(store().selectRetry(legacy.id, 'once')).toBeUndefined();
    const partial = store().add({ ...item, identity: { ...item.identity!, callId: 'legacy-call', requestOrdinal: undefined as unknown as number } })!;
    expect(store().selectRetry(partial.id, 'once')).toBeUndefined();
    select();
    store().add({ ...item, conversationId: 'c2' });
    store().clearConversation('c1');
    expect(pendingFor(store().pending, 'c1')).toEqual([]);
    expect(pendingFor(store().pending, 'c2')).toHaveLength(1);
    expect(store().approvedOnce).toEqual({});
  });
  it('does not spend approval for the second identical call on the first call of its retry', () => {
    const second = { ...item, identity: { ...item.identity!, callId: 'original-second', requestOrdinal: 2 } };
    const id = store().selectRetry(store().add(second)!.id, 'once');
    store().beginRetry('c1', 'retry', id);
    store().claimDispatch('c1', 'retry', 'new-dispatch', 'task-a', 'A');
    expect(store().consumeApproval(retry({ identity: { ...retry().identity!, requestOrdinal: 1 } }))).toBe(false);
    expect(store().consumeApproval(retry({ identity: { ...retry().identity!, callId: 'retry-second', requestOrdinal: 2 } }))).toBe(true);
  });

});
