import { beforeEach, describe, expect, it, vi } from 'vitest';

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

    it('setCurrentAction/pauseComputerUseStatus are harmless no-ops when idle (no phantom entry created)', () => {
      setCurrentAction('click');
      pauseComputerUseStatus();
      expect(getCUStatusSnapshot().status).toBe('idle');
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
