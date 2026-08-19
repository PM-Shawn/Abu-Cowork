import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

// Real Tauri API mocks are already installed globally by src/test/setup.ts
// (@tauri-apps/api/core, /event). '@tauri-apps/plugin-global-shortcut' is
// NOT globally mocked — setupAbortListener() already wraps that dynamic
// import in try/catch, so it degrades harmlessly in tests.

import {
  setComputerUseActive,
  incrementComputerUseStep,
  setCurrentAction,
  isSessionWindowHidden,
  setSessionWindowHidden,
  pauseComputerUseStatus,
  checkCUSessionLimits,
  getCUStatusSnapshot,
  subscribeCUStatus,
} from './computerUseStatus';

describe('computerUseStatus — per-conversation session table', () => {
  beforeEach(() => {
    // Best-effort reset: end whatever session might still be "active" from a
    // previous test (module-level state persists across tests in the same file).
    setComputerUseActive(false);
  });

  it('reports idle when no conversation has an active session', () => {
    expect(getCUStatusSnapshot().status).toBe('idle');
  });

  it('activates a session scoped to the given conversationId', () => {
    setComputerUseActive(true, 'conv-A');
    const snap = getCUStatusSnapshot();
    expect(snap.status).toBe('active');
    expect(snap.activeConversationId).toBe('conv-A');
    expect(snap.stepCount).toBe(0);
  });

  it('returns the SAME idle object reference across calls when nothing changed (useSyncExternalStore requirement)', () => {
    const first = getCUStatusSnapshot();
    const second = getCUStatusSnapshot();
    expect(first).toBe(second);
  });

  // ── The contamination bug this fix closes ──
  describe('ownership guard on setComputerUseActive(false, id)', () => {
    it('a stale deactivate from a conversation that is no longer the owner does NOT clobber the conversation that owns the session now', () => {
      setComputerUseActive(true, 'conv-A');
      incrementComputerUseStep('click');
      // conv-A's session ends normally...
      setComputerUseActive(false, 'conv-A');
      // ...conv-B starts a fresh session...
      setComputerUseActive(true, 'conv-B');
      incrementComputerUseStep('type');

      // ...then a LATE/stale cleanup call for conv-A arrives (e.g. a delayed
      // async cleanup from agentLoop.ts's error path). Before the ownership
      // guard, this unconditionally reset the single shared `state` object,
      // silently ending conv-B's session and losing its step count.
      setComputerUseActive(false, 'conv-A');

      const snap = getCUStatusSnapshot();
      expect(snap.status).toBe('active');
      expect(snap.activeConversationId).toBe('conv-B');
      expect(snap.stepCount).toBe(1);
    });

    it('the legitimate owner CAN still end its own session', () => {
      setComputerUseActive(true, 'conv-A');
      setComputerUseActive(false, 'conv-A');
      expect(getCUStatusSnapshot().status).toBe('idle');
    });

    it('a deactivate with no conversationId trusts the caller and clears whatever is active (documented fail-open fallback)', () => {
      setComputerUseActive(true, 'conv-A');
      setComputerUseActive(false);
      expect(getCUStatusSnapshot().status).toBe('idle');
    });
  });

  describe('per-owner bookkeeping (step count / window-hidden / session limits)', () => {
    it('a fresh session for a new conversation starts with its own zeroed bookkeeping, not leaked from the previous owner', () => {
      setComputerUseActive(true, 'conv-A');
      incrementComputerUseStep('click');
      incrementComputerUseStep('click');
      setSessionWindowHidden(true);
      setComputerUseActive(false, 'conv-A');

      setComputerUseActive(true, 'conv-B');
      const snap = getCUStatusSnapshot();
      expect(snap.stepCount).toBe(0);
      expect(isSessionWindowHidden()).toBe(false);
    });

    it('checkCUSessionLimits reports the CURRENT owner step count, unaffected by a different conversation racing in between', () => {
      setComputerUseActive(true, 'conv-A');
      for (let i = 0; i < 29; i++) incrementComputerUseStep('click');
      expect(checkCUSessionLimits()).toBeNull(); // 29 < 30

      // conv-B's late deactivate for a DIFFERENT (already-ended) session must
      // not affect conv-A's live step count.
      setComputerUseActive(false, 'conv-B');
      expect(getCUStatusSnapshot().stepCount).toBe(29);

      incrementComputerUseStep('click'); // 30th step
      expect(checkCUSessionLimits()).toContain('已达上限');
    });

    // RB-04, renderer mirror. toolExecutor re-activates at the top of EVERY
    // computer batch; a task normally spans several. Rebuilding the row on
    // each one reset the count to 0 and the clock to now, so the caps could
    // never be reached and the UI restarted at step 1 mid-task.
    it('a same-owner re-activation continues the session budget instead of resetting it', () => {
      setComputerUseActive(true, 'conv-A');
      for (let i = 0; i < 29; i++) incrementComputerUseStep('click');
      const startedAt = getCUStatusSnapshot().sessionStartTime;

      // Next batch in the same task.
      setComputerUseActive(true, 'conv-A');

      expect(getCUStatusSnapshot().stepCount).toBe(29);
      expect(getCUStatusSnapshot().sessionStartTime).toBe(startedAt);
      incrementComputerUseStep('click');
      expect(checkCUSessionLimits()).toContain('已达上限');
    });

    it('a different conversation taking over is a new session and still starts at zero', () => {
      setComputerUseActive(true, 'conv-A');
      for (let i = 0; i < 5; i++) incrementComputerUseStep('click');

      setComputerUseActive(true, 'conv-B');

      expect(getCUStatusSnapshot().stepCount).toBe(0);
    });

    it('setCurrentAction/pauseComputerUseStatus are harmless no-ops when idle (no phantom entry created)', () => {
      setCurrentAction('click');
      pauseComputerUseStatus();
      expect(getCUStatusSnapshot().status).toBe('idle');
    });
  });

  // ── Regression: the window-hidden flag is a GLOBAL (one real OS window) ──
  // toolExecutor.ts hides the window and calls setSessionWindowHidden(true)
  // BEFORE setComputerUseActive(true, id) — i.e. before any owner exists. If
  // that flag lives only inside the per-conversation CUState, the write is a
  // silent no-op and the following activation overwrites it, so `wasHidden`
  // is false at teardown and window_show/hide_screen_border NEVER run: the
  // app window stays hidden and the Stop overlay stays on screen forever.
  describe('sessionWindowHidden survives activation (window restore on teardown)', () => {
    it('setSessionWindowHidden(true) called BEFORE activation survives it — toolExecutor.ts\'s real call order', () => {
      expect(isSessionWindowHidden()).toBe(false);
      setSessionWindowHidden(true);
      setComputerUseActive(true, 'conv-A');
      expect(isSessionWindowHidden()).toBe(true);
    });

    it('re-activating for the next CU batch in the same loop does not wipe the flag', () => {
      setComputerUseActive(true, 'conv-A');
      setSessionWindowHidden(true);
      setComputerUseActive(true, 'conv-A');
      expect(isSessionWindowHidden()).toBe(true);
    });

    it('ending the session restores the window and hides the overlay, then clears the flag', async () => {
      // Global mock returns undefined; the production code chains
      // `.catch()` on invoke's promise, so give it a real resolved promise.
      vi.mocked(invoke).mockReset();
      vi.mocked(invoke).mockResolvedValue(undefined);
      setSessionWindowHidden(true);
      setComputerUseActive(true, 'conv-A');
      setComputerUseActive(false, 'conv-A');
      // The restore invokes live behind a dynamic import() — settle it
      // deterministically (no timers, no real clock).
      await vi.dynamicImportSettled();
      const calls = vi.mocked(invoke).mock.calls.map((c) => c[0]);
      expect(calls).toContain('window_show');
      expect(calls).toContain('hide_screen_border');
      expect(isSessionWindowHidden()).toBe(false);
    });

    it('a REJECTED stale deactivate leaves the owner\'s hidden window alone', async () => {
      setSessionWindowHidden(true);
      setComputerUseActive(true, 'conv-B');
      vi.mocked(invoke).mockClear();
      setComputerUseActive(false, 'conv-A'); // stale, not the owner
      await vi.dynamicImportSettled();
      expect(vi.mocked(invoke).mock.calls.map((c) => c[0])).not.toContain('window_show');
      expect(isSessionWindowHidden()).toBe(true);
      setComputerUseActive(false, 'conv-B');
    });
  });

  describe('React integration', () => {
    it('notifies subscribers on activate/deactivate', () => {
      const listener = vi.fn();
      const unsubscribe = subscribeCUStatus(listener);
      setComputerUseActive(true, 'conv-A');
      expect(listener).toHaveBeenCalled();
      listener.mockClear();
      setComputerUseActive(false, 'conv-A');
      expect(listener).toHaveBeenCalled();
      unsubscribe();
    });
  });
});
