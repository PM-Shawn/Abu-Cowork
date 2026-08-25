import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOOL_NAMES } from '../tools/toolNames';

const runAgentLoopDispatchedMock = vi.fn();
const createAuthorizationScopeMock = vi.fn();
const scopedAuthorizeWorkspaceMock = vi.fn();
const disposeAuthorizationScopeMock = vi.fn();
const createConversationMock = vi.fn();
const renameConversationMock = vi.fn();

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
    }),
  },
}));

vi.mock('../../i18n', () => ({
  format: (template: string, values: Record<string, string>) => Object.entries(values)
    .reduce((result, [key, value]) => result.replaceAll(`{${key}}`, value), template),
  getI18n: () => ({ chatDefaults: { watcherConversationTitle: '{file} {time}' } }),
}));

import { handleWatchTrigger, type FileWatchRule } from './fileWatcher';

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
});
