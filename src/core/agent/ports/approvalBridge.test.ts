/**
 * Tests for the unified approval-bridge core (ports/approvalBridge.ts).
 *
 * These exercise the core directly (not through permissionBridge.ts's thin
 * wrappers) so the per-kind queueing-policy fidelity is pinned independent
 * of the wrapper layer. See E-REPORT.md for the full before/after behavior
 * checklist this file is meant to lock down.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  request,
  resolve,
  resolveActive,
  cancelById,
  drainAll,
  drainByConversationId,
  drainByLoopId,
  subscribe,
  getSnapshot,
  setDequeueShortCircuit,
  type ApprovalPayloadMap,
  type ApprovalResultMap,
} from './approvalBridge';

// Drain every kind before/after each test so module-level state never leaks
// across tests (approvalBridge.ts's kindStates are real module singletons).
function drainEverything() {
  drainAll('command');
  drainAll('file-permission');
  drainAll('workspace');
  drainAll('user-question');
}

beforeEach(() => {
  drainEverything();
  // Reset file-permission's dequeue short-circuit to "never short-circuit"
  // between tests (some tests register their own).
  setDequeueShortCircuit('file-permission', () => undefined);
});

afterEach(() => {
  drainEverything();
  vi.useRealTimers();
});

const COMMAND_PAYLOAD: ApprovalPayloadMap['command'] = {
  info: { command: 'rm -rf /tmp/x', level: 'warn', reason: 'test' },
};

const FILE_PAYLOAD = (path: string): ApprovalPayloadMap['file-permission'] => ({
  path,
  capability: 'write',
  toolName: 'write_file',
});

describe('approvalBridge — request/resolve round trip', () => {
  it('keeps an already cancelled request out of the queue', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await request('workspace', { conversationId: 'c1', signal: controller.signal, payload: { reason: 'folder' } })).toBeNull();
    expect(getSnapshot('workspace')).toBeNull();
  });

  it('cancels a waiting request and preserves other requests', async () => {
    const controller = new AbortController();
    const first = request('workspace', { id: 'w1', conversationId: 'c1', signal: controller.signal, payload: { reason: 'folder' } });
    const second = request('workspace', { id: 'w2', conversationId: 'c2', payload: { reason: 'other folder' } });
    controller.abort();
    expect(await first).toBeNull();
    resolve('workspace', 'w1', '/late');
    expect(getSnapshot('workspace', 'c2')?.id).toBe('w2');
    resolve('workspace', 'w2', '/other');
    expect(await second).toBe('/other');
  });

  it('command: suspends until resolveActive, then settles', async () => {
    const p = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD });
    expect(getSnapshot('command')?.conversationId).toBe('c1');
    resolveActive('command', true);
    expect(await p).toBe(true);
    expect(getSnapshot('command')).toBeNull();
  });

  it('file-permission: suspends until resolveActive, then settles', async () => {
    const p = request('file-permission', { conversationId: 'c1', payload: FILE_PAYLOAD('/a') });
    resolveActive('file-permission', false);
    expect(await p).toBe(false);
  });

  it('workspace: suspends until resolveActive, then settles', async () => {
    const p = request('workspace', { conversationId: 'c1', payload: { reason: 'need a folder' } });
    resolveActive('workspace', '/chosen/path');
    expect(await p).toBe('/chosen/path');
  });

  it('user-question: suspends until resolve(id, ...), then settles', async () => {
    const p = request('user-question', {
      id: 'tc-1',
      conversationId: 'c1',
      payload: { payload: { questions: [] } },
    });
    resolve('user-question', 'tc-1', { answers: [] });
    expect(await p).toEqual({ answers: [] });
  });

  it('resolve() on an unknown id does not throw and does not affect the active entry', async () => {
    const p = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD });
    expect(() => resolve('command', 'nonexistent', true)).not.toThrow();
    expect(getSnapshot('command')).not.toBeNull();
    resolveActive('command', true);
    await p;
  });

  it('resolveActive() no-ops when nothing is active', () => {
    expect(() => resolveActive('command', true)).not.toThrow();
    expect(() => resolveActive('file-permission', true)).not.toThrow();
    expect(() => resolveActive('workspace', null)).not.toThrow();
  });
});

describe('approvalBridge — command: per-conversation FIFO queues, no timeout', () => {
  it('notifies when another conversation receives its own active request', async () => {
    const listener = vi.fn();
    const unsub = subscribe('command', listener);

    const p1 = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD });
    expect(listener).toHaveBeenCalledTimes(1); // became active → notify

    const p2 = request('command', { conversationId: 'c2', payload: COMMAND_PAYLOAD });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getSnapshot('command')?.conversationId).toBe('c1'); // still the first

    resolveActive('command', true); // clears c1, promotes c2 — exactly ONE notify per settle() (see module doc)
    expect(listener).toHaveBeenCalledTimes(3);
    expect(await p1).toBe(true);
    expect(getSnapshot('command')?.conversationId).toBe('c2');

    resolveActive('command', false);
    expect(await p2).toBe(false);
    unsub();
  });

  it('preserves FIFO order across three queued requests', async () => {
    const order: string[] = [];
    const p1 = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD }).then(() => order.push('c1'));
    const p2 = request('command', { conversationId: 'c2', payload: COMMAND_PAYLOAD }).then(() => order.push('c2'));
    const p3 = request('command', { conversationId: 'c3', payload: COMMAND_PAYLOAD }).then(() => order.push('c3'));

    expect(getSnapshot('command')?.conversationId).toBe('c1');
    resolveActive('command', true);
    expect(getSnapshot('command')?.conversationId).toBe('c2');
    resolveActive('command', true);
    expect(getSnapshot('command')?.conversationId).toBe('c3');
    resolveActive('command', true);

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(['c1', 'c2', 'c3']);
  });

  it('has no timeout — stays pending indefinitely without a resolve', async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD });
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 hour — nothing should fire
    expect(settled).toBe(false);
    resolveActive('command', true);
    await p;
    expect(settled).toBe(true);
  });
});

describe('approvalBridge — file-permission: per-conversation FIFO and permission re-check', () => {
  it('notifies each conversation when its first request arrives', async () => {
    const listener = vi.fn();
    const unsub = subscribe('file-permission', listener);
    const p1 = request('file-permission', { conversationId: 'c1', payload: FILE_PAYLOAD('/a') });
    expect(listener).toHaveBeenCalledTimes(1);
    const p2 = request('file-permission', { conversationId: 'c2', payload: FILE_PAYLOAD('/b') });
    expect(listener).toHaveBeenCalledTimes(2);

    resolveActive('file-permission', true);
    await p1;
    resolveActive('file-permission', true);
    await p2;
    unsub();
  });

  it('notifies exactly ONCE when a queued request is promoted — same as command; notify count is an implementation detail, only the snapshot value is the contract', async () => {
    const listener = vi.fn();
    const unsub = subscribe('file-permission', listener);
    const p1 = request('file-permission', { conversationId: 'c1', payload: FILE_PAYLOAD('/a') });
    const p2 = request('file-permission', { conversationId: 'c2', payload: FILE_PAYLOAD('/b') });
    listener.mockClear();

    resolveActive('file-permission', true); // clears c1 and promotes c2 in one settle() — one notify
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSnapshot('file-permission')?.conversationId).toBe('c2');

    resolveActive('file-permission', true);
    await Promise.all([p1, p2]);
    unsub();
  });

  it('notifies ONCE when resolving with an empty queue (no promotion)', async () => {
    const listener = vi.fn();
    const unsub = subscribe('file-permission', listener);
    const p1 = request('file-permission', { conversationId: 'c1', payload: FILE_PAYLOAD('/a') });
    listener.mockClear();
    resolveActive('file-permission', true);
    expect(listener).toHaveBeenCalledTimes(1);
    await p1;
    unsub();
  });

  it('dequeue short-circuit resolves a queued candidate immediately without activating it', async () => {
    // Simulates "another tool call already got this exact permission granted
    // while this request sat in the queue" — the real permissionBridge.ts
    // wires this to usePermissionStore.hasPermission(); here we fake it.
    setDequeueShortCircuit('file-permission', (payload) => (payload.path === '/already-granted' ? true : undefined));

    const p1 = request('file-permission', { conversationId: 'c1', payload: FILE_PAYLOAD('/a') });
    const p2 = request('file-permission', {
      conversationId: 'c2',
      payload: FILE_PAYLOAD('/already-granted'),
    });
    const p3 = request('file-permission', { conversationId: 'c3', payload: FILE_PAYLOAD('/c') });

    resolveActive('file-permission', false); // clears c1; dequeue tries c2 → short-circuits to true, skips to c3
    expect(await p2).toBe(true); // resolved via short-circuit, not a real dialog
    expect(getSnapshot('file-permission')?.conversationId).toBe('c3'); // c3 is now active, not c2

    resolveActive('file-permission', true);
    await Promise.all([p1, p3]);
  });

  it('has no timeout — stays pending indefinitely without a resolve', async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = request('file-permission', { conversationId: 'c1', payload: FILE_PAYLOAD('/a') });
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(settled).toBe(false);
    resolveActive('file-permission', true);
    await p;
  });
});

describe('approvalBridge — workspace: requests retain their identities', () => {
  it('answers concurrent conversations independently', async () => {
    const p1 = request('workspace', { id: 'w1', conversationId: 'c1', payload: { reason: 'r1' } });
    const p2 = request('workspace', { id: 'w2', conversationId: 'c2', payload: { reason: 'r2' } });
    expect(getSnapshot('workspace', 'c1')?.id).toBe('w1');
    expect(getSnapshot('workspace', 'c2')?.id).toBe('w2');
    resolve('workspace', 'w2', '/second');
    expect(await p2).toBe('/second');
    expect(getSnapshot('workspace', 'c1')?.id).toBe('w1');
    resolve('workspace', 'w1', '/first');
    expect(await p1).toBe('/first');
  });

  it('presents requests in order within one conversation', async () => {
    const p1 = request('workspace', { id: 'w1', conversationId: 'c1', payload: { reason: 'r1' } });
    const p2 = request('workspace', { id: 'w2', conversationId: 'c1', payload: { reason: 'r2' } });
    expect(getSnapshot('workspace', 'c1')?.id).toBe('w1');
    resolve('workspace', 'w1', '/first');
    expect(getSnapshot('workspace', 'c1')?.id).toBe('w2');
    resolve('workspace', 'w2', '/second');
    expect(await Promise.all([p1, p2])).toEqual(['/first', '/second']);
  });

  it('cancels every request in one conversation and preserves the other', async () => {
    const p1 = request('workspace', { id: 'w1', conversationId: 'c1', payload: { reason: 'r1' } });
    const p2 = request('workspace', { id: 'w2', conversationId: 'c1', payload: { reason: 'r2' } });
    const p3 = request('workspace', { id: 'w3', conversationId: 'c2', payload: { reason: 'r3' } });
    drainByConversationId('workspace', 'c1');
    resolve('workspace', 'w1', '/late');
    expect(await Promise.all([p1, p2])).toEqual([null, null]);
    expect(getSnapshot('workspace', 'c2')?.id).toBe('w3');
    resolve('workspace', 'w3', '/other');
    expect(await p3).toBe('/other');
  });

  it('cancels queued requests by loop without cancelling another loop', async () => {
    const p1 = request('command', { id: 'first', loopId: 'l1', conversationId: 'c1', payload: COMMAND_PAYLOAD });
    const p2 = request('command', { id: 'second', loopId: 'l2', conversationId: 'c2', payload: COMMAND_PAYLOAD });
    const p3 = request('command', { id: 'third', loopId: 'l1', conversationId: 'c1', payload: COMMAND_PAYLOAD });
    drainByLoopId('command', 'l1');
    expect(await Promise.all([p1, p3])).toEqual([false, false]);
    expect(getSnapshot('command')?.id).toBe('second');
    resolve('command', 'second', true);
    expect(await p2).toBe(true);
  });

  it('has no timeout — stays pending indefinitely until answered or drained', async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = request('workspace', { conversationId: 'c1', payload: { reason: 'r1' } });
    void p.then(() => { settled = true; });
    // A long wait with nothing settling — the dialog must NOT vanish on its own.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(settled).toBe(false);
    expect(getSnapshot('workspace')?.conversationId).toBe('c1');
    // Settles only on the user's explicit answer.
    resolveActive('workspace', '/picked');
    await p;
    expect(settled).toBe(true);
  });
});

describe('approvalBridge — user-question: many concurrent, addressed by id, no timeout', () => {
  it('supports multiple simultaneously-active entries (no single-slot contention)', async () => {
    const p1 = request('user-question', { id: 'tc-1', conversationId: 'c1', payload: { payload: { questions: [] } } });
    const p2 = request('user-question', { id: 'tc-2', conversationId: 'c2', payload: { payload: { questions: [] } } });
    expect(getSnapshot('user-question')).toHaveLength(2);

    resolve('user-question', 'tc-2', { answers: [] });
    expect(await p2).toEqual({ answers: [] });
    expect(getSnapshot('user-question')).toHaveLength(1);
    expect(getSnapshot('user-question')[0].id).toBe('tc-1');

    resolve('user-question', 'tc-1', null);
    expect(await p1).toBeNull();
  });

  it('has no timeout — stays pending until answered or drained, even after 10 minutes', async () => {
    vi.useFakeTimers();
    let settled = false;
    const p = request('user-question', { id: 'tc-long', conversationId: 'c1', payload: { payload: { questions: [] } } });
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 hour — nothing should auto-resolve
    expect(settled).toBe(false);
    resolve('user-question', 'tc-long', { answers: [] });
    await p;
    expect(settled).toBe(true);
  });
});

describe('approvalBridge — drainAll()', () => {
  it('command: drains queued entries silently, then the active one with exactly one notify', async () => {
    const listener = vi.fn();
    const unsub = subscribe('command', listener);
    const p1 = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD });
    const p2 = request('command', { conversationId: 'c2', payload: COMMAND_PAYLOAD });
    listener.mockClear();

    drainAll('command');
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
    expect(getSnapshot('command')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it('workspace: drains the active entry to null with one notify; no-op when nothing pending', () => {
    const listener = vi.fn();
    const unsub = subscribe('workspace', listener);
    drainAll('workspace'); // nothing pending → no notify
    expect(listener).not.toHaveBeenCalled();

    request('workspace', { conversationId: 'c1', payload: { reason: 'r' } });
    listener.mockClear();
    drainAll('workspace');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSnapshot('workspace')).toBeNull();
    unsub();
  });

  it('user-question: drains all concurrently-active entries with exactly one batched notify; no-op when empty', async () => {
    const listener = vi.fn();
    const unsub = subscribe('user-question', listener);
    drainAll('user-question');
    expect(listener).not.toHaveBeenCalled(); // matches the original's early-return-on-empty

    const p1 = request('user-question', { id: 'tc-1', conversationId: 'c1', payload: { payload: { questions: [] } } });
    const p2 = request('user-question', { id: 'tc-2', conversationId: 'c2', payload: { payload: { questions: [] } } });
    listener.mockClear();

    drainAll('user-question');
    expect(await p1).toBeNull();
    expect(await p2).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSnapshot('user-question')).toHaveLength(0);
    unsub();
  });
});

describe('approvalBridge — drainByConversationId()', () => {
  it('only drains user-question entries belonging to the given conversation', async () => {
    const pA = request('user-question', { id: 'tc-a', conversationId: 'conv-target', payload: { payload: { questions: [] } } });
    const pB = request('user-question', { id: 'tc-b', conversationId: 'conv-other', payload: { payload: { questions: [] } } });

    drainByConversationId('user-question', 'conv-target');
    expect(await pA).toBeNull();
    expect(getSnapshot('user-question')).toHaveLength(1);
    expect(getSnapshot('user-question')[0].id).toBe('tc-b');

    resolve('user-question', 'tc-b', null);
    await pB;
  });
});

describe('approvalBridge — request ownership', () => {
  it.each(['command', 'file-permission'] as const)('answers %s independently across conversations and preserves each FIFO', async kind => {
    const payload = kind === 'command' ? COMMAND_PAYLOAD : FILE_PAYLOAD('/target');
    const first = request(kind, { id: 'a1', conversationId: 'a', payload });
    const queued = request(kind, { id: 'a2', conversationId: 'a', payload });
    const other = request(kind, { id: 'b1', conversationId: 'b', payload });
    const otherId = getSnapshot(kind, 'b')!.requestId;
    resolve(kind, otherId, true);
    expect(await other).toBe(true);
    expect(getSnapshot(kind, 'b')).toBeNull();
    expect(getSnapshot(kind, 'a')?.id).toBe('a1');
    resolve(kind, 'a2', true);
    expect(getSnapshot(kind, 'a')?.id).toBe('a1');
    resolve(kind, 'a1', false);
    expect(await first).toBe(false);
    expect(getSnapshot(kind, 'a')?.id).toBe('a2');
    resolve(kind, 'a2', true);
    expect(await queued).toBe(true);
  });

  it('cancels and answers duplicate provider IDs by their host request identities', async () => {
    const controller = new AbortController();
    const payload = { payload: { questions: [] } };
    const first = request('user-question', { id: 'call_0', conversationId: 'a', payload });
    const cancelled = request('user-question', { id: 'call_0', conversationId: 'b', payload, signal: controller.signal });
    const last = request('user-question', { id: 'call_0', conversationId: 'b', payload });
    const [a, , b] = getSnapshot('user-question');
    controller.abort();
    expect(await cancelled).toBeNull();
    expect(getSnapshot('user-question')).toEqual([a, b]);
    const answer = { answers: [] };
    resolve('user-question', b.requestId, answer);
    expect(await last).toEqual(answer);
    expect(getSnapshot('user-question')).toEqual([a]);
    resolve('user-question', a.requestId, answer);
    expect(await first).toEqual(answer);
  });
});

describe('approvalBridge — cancelById()', () => {
  const info = { command: 'x', level: 'warn' as const, reason: 'r' };

  it('cancels the ACTIVE entry and promotes the next one', async () => {
    const first = request('command', { id: 'first', conversationId: 'c1', payload: { info } });
    const second = request('command', { id: 'second', conversationId: 'c1', payload: { info } });
    expect(getSnapshot('command')?.id).toBe('first');

    cancelById('command', 'first');

    expect(await first).toBe(false);
    // The slot must free up, or every later confirmation queues forever.
    expect(getSnapshot('command')?.id).toBe('second');
    resolveActive('command', true);
    expect(await second).toBe(true);
  });

  it('cancels a QUEUED entry without disturbing the active one', async () => {
    const active = request('command', { id: 'active', conversationId: 'c1', payload: { info } });
    const queued = request('command', { id: 'queued', conversationId: 'c1', payload: { info } });

    cancelById('command', 'queued');
    expect(await queued).toBe(false);
    expect(getSnapshot('command')?.id).toBe('active');

    resolveActive('command', true);
    expect(await active).toBe(true);
    expect(getSnapshot('command')).toBeNull();
  });

  it('is a no-op for an unknown id', async () => {
    const p = request('command', { id: 'only', conversationId: 'c1', payload: { info } });
    cancelById('command', 'nope');
    expect(getSnapshot('command')?.id).toBe('only');
    resolveActive('command', true);
    expect(await p).toBe(true);
  });
});

describe('approvalBridge — getSnapshot() referential stability (useSyncExternalStore contract)', () => {
  it('single-active kinds: same object reference across repeated calls while unchanged', async () => {
    const p = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD });
    const s1 = getSnapshot('command');
    const s2 = getSnapshot('command');
    expect(s1).toBe(s2); // referential equality, not just deep equality
    resolveActive('command', true);
    await p;
    expect(getSnapshot('command')).toBeNull();
  });

  it('single-active kinds: reference changes when a new entry becomes active', async () => {
    const p1 = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD });
    const before = getSnapshot('command');
    const p2 = request('command', { conversationId: 'c2', payload: COMMAND_PAYLOAD });
    expect(getSnapshot('command')).toBe(before); // c2 queued — c1 still active, same ref
    resolveActive('command', true);
    const after = getSnapshot('command');
    expect(after).not.toBe(before);
    expect(after?.conversationId).toBe('c2');
    resolveActive('command', true);
    await Promise.all([p1, p2]);
  });

  it('multi kind (user-question): same array reference until add/remove/drain', async () => {
    const arr1 = getSnapshot('user-question');
    const arr2 = getSnapshot('user-question');
    expect(arr1).toBe(arr2);

    const p1 = request('user-question', { id: 'tc-1', conversationId: 'c1', payload: { payload: { questions: [] } } });
    const arr3 = getSnapshot('user-question');
    expect(arr3).not.toBe(arr1); // mutated on add

    const arr4 = getSnapshot('user-question');
    expect(arr4).toBe(arr3); // stable again until next mutation

    resolve('user-question', 'tc-1', null);
    await p1;
    const arr5 = getSnapshot('user-question');
    expect(arr5).not.toBe(arr3); // mutated on remove
  });
});

describe('approvalBridge — payload/result type map sanity', () => {
  it('command/file-permission results are boolean, workspace/user-question allow null', () => {
    // Compile-time check only — exercised at runtime via the round-trip tests above.
    const _cmd: ApprovalResultMap['command'] = false;
    const _file: ApprovalResultMap['file-permission'] = true;
    const _ws: ApprovalResultMap['workspace'] = null;
    const _uq: ApprovalResultMap['user-question'] = null;
    expect([_cmd, _file, _ws, _uq]).toBeDefined();
  });
});
