import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { useTeamConfirmationStore } from '@/stores/teamConfirmationStore';
import { decideTeamConfirmation, waitForTeamConfirmation, respondToTeamConfirmation } from './teamConfirmations';

vi.mock('@/utils/notifications', () => ({ notifyTeamConfirmationPending: vi.fn() }));
const identity = { toolName: 'run_command', parametersDigest: 'p', cwd: '/project', loopId: 'run', callId: 'one', dispatchId: 'member:0', dispatchFingerprint: 'task', requestOrdinal: 1 };
const item = { identity, kind: 'command' as const, member: 'Developer', detail: 'npm install' };
function request(callId: string, signal?: AbortSignal, conversationId = 'team') {
  const input = { ...item, identity: { ...identity, callId } };
  decideTeamConfirmation(conversationId, input);
  const answer = waitForTeamConfirmation(conversationId, input, signal);
  const record = Object.values(useTeamConfirmationStore.getState().pending).find((entry) => entry.identity?.callId === callId && entry.conversationId === conversationId)!;
  return { answer, id: record.id };
}

describe('live team approval lifetime and isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
    useTeamConfirmationStore.setState({ pending: {}, waiting: {}, permissionActivity: {}, approvedOnce: {}, runRules: {}, retrySelections: {} });
    useChatStore.setState({ conversations: Object.fromEntries(['team', 'other'].map((id) => [id, { id, teamId: 't', title: id, createdAt: 1, updatedAt: 1, status: 'running', messages: [] }])) });
  });
  afterEach(() => {
    useTeamConfirmationStore.getState().clearConversation('team');
    useTeamConfirmationStore.getState().clearConversation('other');
    vi.useRealTimers();
  });
  it('answers only the selected call, once, without creating authority for another call', async () => {
    const abort = new AbortController();
    const a = request('a', abort.signal);
    const b = request('b', abort.signal);
    expect(useTeamConfirmationStore.getState().selectRetry(a.id, 'once')).toBeUndefined();
    expect(respondToTeamConfirmation(a.id, true)).toBe(true);
    await expect(a.answer).resolves.toBe(true);
    expect(respondToTeamConfirmation(a.id, true)).toBe(false);
    expect(useTeamConfirmationStore.getState().waiting[b.id]).toBe(true);
    expect(useTeamConfirmationStore.getState().approvedOnce).toEqual({});
    respondToTeamConfirmation(b.id, false);
    await expect(b.answer).resolves.toBe(false);
    expect(useTeamConfirmationStore.getState().waiting).toEqual({});
    expect(useTeamConfirmationStore.getState().permissionActivity[JSON.stringify(['team', identity.dispatchId])]?.at).toBe(new Date('2026-09-09T00:00:00Z').getTime());
  });
  it('cancels only the stopped member and makes its old request inert', async () => {
    const abortA = new AbortController();
    const abortB = new AbortController();
    const a = request('a', abortA.signal);
    const b = request('b', abortB.signal);
    const result = expect(a.answer).rejects.toMatchObject({ name: 'AbortError' });
    abortA.abort();
    await result;
    expect(respondToTeamConfirmation(a.id, true)).toBe(false);
    expect(useTeamConfirmationStore.getState().pending[a.id]).toBeDefined();
    expect(useTeamConfirmationStore.getState().waiting[b.id]).toBe(true);
    respondToTeamConfirmation(b.id, true);
    await expect(b.answer).resolves.toBe(true);
  });
  it.each(['clearRun', 'clearConversation', 'remove'] as const)('%s settles affected waiters without releasing another conversation', async (action) => {
    const abort = new AbortController();
    const a = request('a', abort.signal);
    const b = request('b', abort.signal, 'other');
    const result = expect(a.answer).rejects.toMatchObject({ name: 'AbortError' });
    const store = useTeamConfirmationStore.getState();
    if (action === 'clearRun') store.clearRun('team', 'run');
    else if (action === 'remove') store.remove(a.id);
    else store.clearConversation('team');
    await result;
    expect(respondToTeamConfirmation(a.id, true)).toBe(false);
    expect(useTeamConfirmationStore.getState().waiting[b.id]).toBe(true);
    respondToTeamConfirmation(b.id, false);
    await expect(b.answer).resolves.toBe(false);
  });
  it('defers callers without a live signal, duplicate waiters and missing identities instead of returning rejection', async () => {
    const deferred = request('deferred');
    await expect(deferred.answer).rejects.toMatchObject({ name: 'TeamConfirmationPendingError' });
    const abort = new AbortController();
    const live = request('one', abort.signal);
    await expect(waitForTeamConfirmation('team', item, abort.signal)).rejects.toMatchObject({ name: 'TeamConfirmationPendingError' });
    await expect(waitForTeamConfirmation('team', { kind: 'command', detail: 'legacy' }, abort.signal)).rejects.toMatchObject({ name: 'TeamConfirmationPendingError' });
    respondToTeamConfirmation(live.id, true);
    await expect(live.answer).resolves.toBe(true);
    abort.abort();
    const stopped = request('stopped', abort.signal);
    await expect(stopped.answer).rejects.toMatchObject({ name: 'AbortError' });
    expect(respondToTeamConfirmation(deferred.id, true)).toBe(false);
  });
});
