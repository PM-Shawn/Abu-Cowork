import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from '../tools/toolNames';

const runAgentLoopDispatchedMock = vi.fn();
const createAuthorizationScopeMock = vi.fn();
const scopedAuthorizeWorkspaceMock = vi.fn();
const disposeAuthorizationScopeMock = vi.fn();
const createConversationMock = vi.fn();
const renameConversationMock = vi.fn();
const addMessageMock = vi.fn();
const emitBrowserRunReportMock = vi.fn();

vi.mock('./agentLoopRunner', () => ({
  runAgentLoopDispatched: (...args: unknown[]) => runAgentLoopDispatchedMock(...args),
}));

vi.mock('../tools/pathSafety', () => ({
  createAuthorizationScope: () => createAuthorizationScopeMock(),
  scopedAuthorizeWorkspace: (...args: unknown[]) => scopedAuthorizeWorkspaceMock(...args),
  disposeAuthorizationScope: (...args: unknown[]) => disposeAuthorizationScopeMock(...args),
}));

vi.mock('../../stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      createConversation: createConversationMock,
      renameConversation: renameConversationMock,
      addMessage: addMessageMock,
    }),
  },
}));

// U7 review / B6 — the third unattended entry point now emits a run report
// like the scheduler and the trigger engine do. Mocked here so these cases
// assert the CALL (conversation, window, outcome) without dragging the chat
// store in.
vi.mock('../observability/browserRunReportEmitter', () => ({
  emitBrowserRunReport: (...args: unknown[]) => emitBrowserRunReportMock(...args),
}));

vi.mock('../../i18n', () => ({
  format: (template: string, values: Record<string, string>) => Object.entries(values)
    .reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), template),
  getI18n: () => ({
    chatDefaults: { watcherConversationTitle: '{file} {time}' },
    chat: { automationRunFailed: 'failed: {error}' },
  }),
}));

import { handleWatchTrigger, type FileWatchRule } from './fileWatcher';
import { BROWSER_DENIAL_ABORT_CAUSE } from './browserDenialTracker';

describe('handleWatchTrigger background authorization', () => {
  const rule: FileWatchRule = {
    id: 'watch-r3-5',
    path: '/Users/testuser/Inbox',
    event: 'any',
    prompt: 'Process {fileName} at {filePath}',
    enabled: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T10:00:00Z'));
    runAgentLoopDispatchedMock.mockReset();
    runAgentLoopDispatchedMock.mockResolvedValue({ reason: 'completed' });
    createAuthorizationScopeMock.mockReset();
    createAuthorizationScopeMock.mockReturnValue('watch-scope-1');
    scopedAuthorizeWorkspaceMock.mockReset();
    disposeAuthorizationScopeMock.mockReset();
    createConversationMock.mockReset();
    createConversationMock.mockReturnValue('watch-conversation-1');
    renameConversationMock.mockReset();
    addMessageMock.mockReset();
    emitBrowserRunReportMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs in an isolated strict scope and denies interactive expansion paths', async () => {
    await handleWatchTrigger(rule, `${rule.path}/invoice.pdf`);

    expect(createAuthorizationScopeMock).toHaveBeenCalledTimes(1);
    expect(scopedAuthorizeWorkspaceMock).toHaveBeenCalledWith(
      'watch-scope-1',
      rule.path,
      ['read', 'write'],
    );
    expect(runAgentLoopDispatchedMock).toHaveBeenCalledWith(
      'watch-conversation-1',
      expect.stringContaining('invoice.pdf'),
      expect.objectContaining({
        authorizationScopeId: 'watch-scope-1',
        blockedTools: [TOOL_NAMES.REQUEST_WORKSPACE],
        commandConfirmCallback: expect.any(Function),
        filePermissionCallback: expect.any(Function),
      }),
    );
    const options = runAgentLoopDispatchedMock.mock.calls[0][2] as {
      commandConfirmCallback: (input: unknown) => Promise<boolean>;
      filePermissionCallback: (input: unknown) => Promise<boolean>;
    };
    await expect(options.commandConfirmCallback({})).resolves.toBe(false);
    await expect(options.filePermissionCallback({})).resolves.toBe(false);
    expect(disposeAuthorizationScopeMock).toHaveBeenCalledWith('watch-scope-1');
  });

  /**
   * #549 — a watcher run is unattended, so its conversation must be created as
   * a background one. The store reads `skipActivate` to decide that the
   * permission mode the user picked on the new-task page is not this
   * conversation's: under 「完全自主」 the auto-deny callback above is never
   * even consulted.
   */
  it('#549: the watcher conversation is created in the background', async () => {
    await handleWatchTrigger({ ...rule, id: 'watch-background-create' }, `${rule.path}/b.txt`);

    expect(createConversationMock).toHaveBeenCalledWith(null, { skipActivate: true });
  });

  /**
   * #549 — a watcher rule has no run log of its own. Its hidden conversation
   * is the only place the failure can be read, and a run that never reached
   * the sidecar wrote nothing into it at all.
   */
  it('#549: an error result leaves a visible note in the watcher conversation', async () => {
    runAgentLoopDispatchedMock.mockResolvedValue({
      reason: 'error',
      error: '这段对话太长',
      messageTaken: true,
      stopReason: 'payload_too_large',
    });

    // A fresh rule id: handleWatchTrigger debounces per rule, and the suite's
    // clock is frozen.
    await handleWatchTrigger({ ...rule, id: 'watch-failed-note' }, `${rule.path}/a.txt`);

    expect(addMessageMock).toHaveBeenCalledWith('watch-conversation-1', expect.objectContaining({
      // Prefix only: the id carries a random suffix so two failures in the
      // same millisecond cannot collide.
      id: expect.stringMatching(/^watch-failed-/),
      role: 'assistant',
      content: 'failed: 这段对话太长',
      isSystem: true,
      isRecoveryNotice: true,
    }));
  });

  it('#549: a completed run adds no failure note', async () => {
    await handleWatchTrigger({ ...rule, id: 'watch-ok-no-note' }, `${rule.path}/b.txt`);

    expect(runAgentLoopDispatchedMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  it('disposes the scope when the background run rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    runAgentLoopDispatchedMock.mockRejectedValue(new Error('runner failed'));
    try {
      await handleWatchTrigger({ ...rule, id: 'watch-r3-5-reject' }, `${rule.path}/failed.pdf`);
      expect(disposeAuthorizationScopeMock).toHaveBeenCalledWith('watch-scope-1');
    } finally {
      errorSpy.mockRestore();
    }
  });
  // U7 review / B6. A watcher rule can drive the browser exactly like a
  // scheduled task can, and until now it produced no card at all — the same
  // "it did nothing all night and nobody said why" failure the card exists to
  // prevent, just on a third entry point.
  describe('browser run report', () => {
    it('emits a card for the run, scoped to this run\'s conversation', async () => {
      await handleWatchTrigger({ ...rule, id: 'watch-report-ok' }, `${rule.path}/a.pdf`);

      expect(emitBrowserRunReportMock).toHaveBeenCalledTimes(1);
      expect(emitBrowserRunReportMock.mock.calls[0][0]).toMatchObject({
        conversationId: 'watch-conversation-1',
        outcome: 'completed',
      });
      // The window boundary is a cursor taken before the run, never a clock.
      expect(typeof emitBrowserRunReportMock.mock.calls[0][0].sinceSeq).toBe('number');
    });

    it('reports an honest outcome when the run threw', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      runAgentLoopDispatchedMock.mockRejectedValue(new Error('runner failed'));
      try {
        await handleWatchTrigger({ ...rule, id: 'watch-report-throw' }, `${rule.path}/b.pdf`);
      } finally {
        errorSpy.mockRestore();
      }

      // A run that blew up is exactly the one worth reporting.
      expect(emitBrowserRunReportMock.mock.calls[0][0]).toMatchObject({ outcome: 'error' });
    });

    it('names the consecutive-denial abort', async () => {
      runAgentLoopDispatchedMock.mockResolvedValue({
        reason: 'aborted',
        abortCause: BROWSER_DENIAL_ABORT_CAUSE,
      });

      await handleWatchTrigger({ ...rule, id: 'watch-report-denials' }, `${rule.path}/c.pdf`);

      expect(emitBrowserRunReportMock.mock.calls[0][0]).toMatchObject({
        outcome: 'aborted-denials',
      });
    });
  });
});
