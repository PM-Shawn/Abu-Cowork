import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunContext } from '../agentRunContext';
import { subagentRunContext } from '../subagentRunContext';

const sendRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../rpcClient', () => ({
  sendRequest: (...args: unknown[]) => sendRequestMock(...args),
}));

import { invoke, invokeCleanupForCapturedRun } from './tauriCoreInvokeRun';

describe('tauriCoreInvokeRun', () => {
  beforeEach(() => {
    sendRequestMock.mockReset();
    sendRequestMock.mockResolvedValue({ ok: true });
  });

  it('attaches the ambient main run owner to native.invoke', async () => {
    await agentRunContext.run({ runId: 'main-run' } as never, () =>
      invoke('run_shell_command', { command: 'pwd' }),
    );

    expect(sendRequestMock).toHaveBeenCalledWith('native.invoke', {
      runId: 'main-run',
      cmd: 'run_shell_command',
      args: { command: 'pwd' },
    });
  });

  it('attaches the ambient top-level subagent run owner to native.invoke', async () => {
    await subagentRunContext.run({ runId: 'sub-run' } as never, () =>
      invoke('get_active_window'),
    );

    expect(sendRequestMock).toHaveBeenCalledWith('native.invoke', {
      runId: 'sub-run',
      cmd: 'get_active_window',
      args: undefined,
    });
  });

  it('fails closed outside a registered run context', async () => {
    await expect(invoke('run_shell_command', { command: 'pwd' })).rejects.toThrow(
      /outside an agent\/subagent run context/,
    );
    expect(sendRequestMock).not.toHaveBeenCalled();
  });

  it('allows an explicitly captured owner to dispatch cleanup outside ALS', async () => {
    await invokeCleanupForCapturedRun('main-run', 'abort_command', { commandId: 'cmd-1' });

    expect(sendRequestMock).toHaveBeenCalledWith('native.invoke', {
      runId: 'main-run',
      cmd: 'abort_command',
      args: { commandId: 'cmd-1' },
    });
  });

  it('rejects explicit owner overrides for non-cleanup commands', async () => {
    await expect(invokeCleanupForCapturedRun('main-run', 'run_shell_command', { command: 'pwd' }))
      .rejects
      .toThrow(/restricted to cleanup commands/);
    expect(sendRequestMock).not.toHaveBeenCalled();
  });
});
