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

describe('approvalBridge — command: single active + FIFO queue, no timeout', () => {
  it('a second concurrent request queues silently (no notify) instead of overwriting', async () => {
    const listener = vi.fn();
    const unsub = subscribe('command', listener);

    const p1 = request('command', { conversationId: 'c1', payload: COMMAND_PAYLOAD });
    expect(listener).toHaveBeenCalledTimes(1); // became active → notify

    const p2 = request('command', { conversationId: 'c2', payload: COMMAND_PAYLOAD });
    expect(listener).toHaveBeenCalledTimes(1); // queued silently — no notify
    expect(getSnapshot('command')?.conversationId).toBe('c1'); // still the first

    resolveActive('command', true); // clears c1, promotes c2 — exactly ONE notify (see module doc)
    expect(listener).toHaveBeenCalledTimes(2);
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

describe('approvalBridge — file-permission: single active + FIFO queue + dequeue re-check', () => {
  it('queues like command (no notify on enqueue)', async () => {
    const listener = vi.fn();
    const unsub = subscribe('file-permission', listener);
    const p1 = request('file-permission', { conversationId: 'c1', payload: FILE_PAYLOAD('/a') });
    expect(listener).toHaveBeenCalledTimes(1);
    const p2 = request('file-permission', { conversationId: 'c2', payload: FILE_PAYLOAD('/b') });
    expect(listener).toHaveBeenCalledTimes(1);

    resolveActive('file-permission', true);
    await p1;
    resolveActive('file-permission', true);
    await p2;
    unsub();
  });

  it('notifies TWICE when a queued request is promoted (clear + activate) — differs from command', async () => {
    const listener = vi.fn();
    const unsub = subscribe('file-permission', listener);
    const p1 = request('file-permission', { conversationId: 'c1', payload: FILE_PAYLOAD('/a') });
    const p2 = request('file-permission', { conversationId: 'c2', payload: FILE_PAYLOAD('/b') });
    listener.mockClear();

    resolveActive('file-permission', true); // clears c1 (notify #1) then promotes c2 (notify #2)
    expect(listener).toHaveBeenCalledTimes(2);
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

describe('approvalBridge — workspace: single active, NO queue (overwrite), 60s timeout', () => {
  it('a second concurrent request overwrites the first — the first promise is abandoned', async () => {
    vi.useFakeTimers();
    let firstSettled = false;
    const p1 = request('workspace', { conversationId: 'c1', payload: { reason: 'r1' } });
    void p1.then(() => { firstSettled = true; });

    const p2 = request('workspace', { conversationId: 'c2', payload: { reason: 'r2' } });
    expect(getSnapshot('workspace')?.conversationId).toBe('c2'); // overwritten, not queued

    resolveActive('workspace', '/picked');
    expect(await p2).toBe('/picked');

    // The first request's own 60s timeout fires but no-ops (identity check
    // fails — it's no longer the active entry) — it stays pending forever.
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    expect(firstSettled).toBe(false);

    // p1 never settles — avoid an unhandled-rejection / hang by not awaiting it further.
    void p1;
  });

  it('auto-resolves to null after 60s when left untouched', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = request('workspace', { conversationId: 'c1', payload: { reason: 'r1' } });
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    expect(await p).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[AgentLoop] Workspace request timed out, auto-cancelling');
    warnSpy.mockRestore();
  });

  it('resolving before the timeout clears the timer (no late no-op warning)', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = request('workspace', { conversationId: 'c1', payload: { reason: 'r1' } });
    resolveActive('workspace', '/picked');
    await p;
    await vi.advanceTimersByTimeAsync(60_000 + 100);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('approvalBridge — user-question: many concurrent, addressed by id, 10min timeout', () => {
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

  it('auto-resolves to null after 10 minutes when left untouched', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = request('user-question', { id: 'tc-timeout', conversationId: 'c1', payload: { payload: { questions: [] } } });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
    expect(await p).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[permissionBridge] UserQuestion timed out, auto-cancelling', 'tc-timeout');
    warnSpy.mockRestore();
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

describe('approvalBridge — drainByLoopId() (forward-looking; not wired to any wrapper today)', () => {
  it('drains only entries tagged with the given loopId, across single-active and multi kinds', async () => {
    const pCmdA = request('command', { conversationId: 'c1', loopId: 'loop-a', payload: COMMAND_PAYLOAD });
    const pQA = request('user-question', { id: 'tc-a', conversationId: 'c1', loopId: 'loop-a', payload: { payload: { questions: [] } } });
    const pQB = request('user-question', { id: 'tc-b', conversationId: 'c2', loopId: 'loop-b', payload: { payload: { questions: [] } } });

    drainByLoopId('loop-a');
    expect(await pCmdA).toBe(false);
    expect(await pQA).toBeNull();
    expect(getSnapshot('user-question')).toHaveLength(1);
    expect(getSnapshot('user-question')[0].id).toBe('tc-b');

    resolve('user-question', 'tc-b', null);
    await pQB;
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
