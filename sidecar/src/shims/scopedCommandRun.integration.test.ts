import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunContext } from '../agentRunContext';

const sendRequestMock = vi.hoisted(() => vi.fn());
vi.mock('../rpcClient', () => ({
  sendRequest: (...args: unknown[]) => sendRequestMock(...args),
}));

// Mirror build-sidecar.mjs's production module redirect. The redirected
// implementation calls the real sidecar invoke shim; only JSON-RPC transport
// is intercepted, so this test never mocks invoke itself.
vi.mock('@/core/tools/helpers/taskCommandInvoke', async () => {
  return import('./taskCommandInvokeRun');
});

import { invokeTaskCommand } from '@/core/tools/helpers/scopedCommand';

function setElectronMarker(enabled: boolean): void {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  if (enabled) {
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
  } else {
    delete runtime.__ABU_SHELL__;
  }
}

describe('sidecar scoped command abort dispatch', () => {
  beforeEach(() => {
    sendRequestMock.mockReset();
    setElectronMarker(true);
  });

  afterEach(() => {
    setElectronMarker(false);
  });

  it('retains the starting run owner when Stop aborts outside its AsyncLocalStorage scope', async () => {
    const controller = new AbortController();
    let resolveCommand!: (value: unknown) => void;
    sendRequestMock.mockImplementation((_method: unknown, rawParams: unknown) => {
      const params = rawParams as { cmd?: string };
      if (params.cmd === 'run_shell_command') {
        return new Promise((resolve) => {
          resolveCommand = resolve;
        });
      }
      return Promise.resolve(true);
    });

    let running!: Promise<unknown>;
    agentRunContext.run({ runId: 'main-run' } as never, () => {
      running = invokeTaskCommand(
        'run_shell_command',
        { command: 'sleep 60' },
        { abortSignal: controller.signal, loopId: 'main-run' },
        { commandIdPrefix: 'stop-regression' },
      );
    });

    const startCall = sendRequestMock.mock.calls.find(([, params]) => (
      params as { cmd?: string }
    ).cmd === 'run_shell_command');
    const commandId = (
      startCall?.[1] as { args?: { commandId?: string } }
    ).args?.commandId;
    expect(commandId).toMatch(/^stop-regression-/);

    try {
      controller.abort();

      expect(sendRequestMock).toHaveBeenCalledWith('native.invoke', {
        runId: 'main-run',
        cmd: 'abort_command',
        args: { commandId },
      });
    } finally {
      resolveCommand({ code: -1, stdout: '', stderr: '[Command aborted]' });
      await running;
    }
  });
});
