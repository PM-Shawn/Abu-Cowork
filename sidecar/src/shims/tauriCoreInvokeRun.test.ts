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

  // The real invoke takes (cmd, args?: InvokeArgs, options?: InvokeOptions).
  // The shim took two parameters and a narrower args type, so a third argument
  // vanished and a binary payload would have been JSON-stringified into a
  // numeric-keyed object on the native.invoke wire. Both checks run before the
  // run-context check, so a bad call fails the same way inside or outside a run.
  describe('argument surface', () => {
    it('rejects InvokeOptions, which the native.invoke wire cannot carry', async () => {
      await expect(
        agentRunContext.run({ runId: 'main-run' } as never, () =>
          invoke('noop', {}, { headers: { 'x-a': '1' } }),
        ),
      ).rejects.toThrow(/InvokeOptions/);
      expect(sendRequestMock).not.toHaveBeenCalled();
    });

    it.each([
      ['a byte array', new Uint8Array([1, 2, 3])],
      ['a number array', [1, 2, 3]],
      ['an ArrayBuffer', new ArrayBuffer(3)],
    ])('rejects %s as args rather than mangling it on the wire', async (_name, args) => {
      await expect(
        agentRunContext.run({ runId: 'main-run' } as never, () => invoke('noop', args as never)),
      ).rejects.toThrow(/plain record/);
      expect(sendRequestMock).not.toHaveBeenCalled();
    });
  });
});
