// @vitest-environment happy-dom
// N6/A2 — the run-scoped half of browser view teardown.
//
// A subagent run's tabs are owned by the pair {conversationId, runKey} and are
// listed to nobody else, so when the run ends there is no other path that could
// ever close them: they would sit in main until the whole conversation is
// deleted. This is the command that releases them, and its two guards matter as
// much as the call — a missing runKey here would silently widen a per-run
// release into "reap the conversation", killing the user's own pane work and
// every sibling delegation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { disposeOwnedBrowserViews, disposeRunBrowserViews } from './browserViewLifecycle';

const invokeMock = vi.mocked(invoke);
const runtimeWindow = (globalThis as unknown as { window: Record<string, unknown> }).window;

describe('disposeRunBrowserViews', () => {
  let previousInternals: unknown;

  beforeEach(() => {
    // Every host command is guarded by `isTauriEnv()`; the desktop shell is the
    // only place these views exist (same seam chatStore.test.ts uses).
    previousInternals = runtimeWindow.__TAURI_INTERNALS__;
    runtimeWindow.__TAURI_INTERNALS__ = {};
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    runtimeWindow.__TAURI_INTERNALS__ = previousInternals;
    invokeMock.mockReset();
  });

  it('stays silent outside the desktop shell', () => {
    runtimeWindow.__TAURI_INTERNALS__ = undefined;

    disposeRunBrowserViews('conv-1', 'sar-abc');

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('asks the host to reap exactly one run of one conversation', () => {
    disposeRunBrowserViews('conv-1', 'sar-abc');

    expect(invokeMock).toHaveBeenCalledWith('browser_dispose_owner', {
      conversationId: 'conv-1',
      runKey: 'sar-abc',
    });
  });

  it('does nothing without a run key, rather than widening into a conversation-wide reap', () => {
    disposeRunBrowserViews('conv-1', undefined);
    disposeRunBrowserViews('conv-1', '');

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does nothing without a conversation id', () => {
    disposeRunBrowserViews(undefined, 'sar-abc');

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('never rejects when the host command fails — cleanup must not fail a run', async () => {
    invokeMock.mockRejectedValue(new Error('host is gone'));

    expect(() => disposeRunBrowserViews('conv-1', 'sar-abc')).not.toThrow();
    await Promise.resolve();
  });

  it('leaves the conversation-wide command untouched (no runKey on the delete cascade)', () => {
    disposeOwnedBrowserViews('conv-1');

    expect(invokeMock).toHaveBeenCalledWith('browser_dispose_owner', {
      conversationId: 'conv-1',
    });
  });
});
