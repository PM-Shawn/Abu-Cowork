import { beforeEach, describe, expect, it, vi } from 'vitest';

const reportErrorMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/consoleError', () => ({
  reportError: (...args: unknown[]) => reportErrorMock(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  SHELL_CRASH_EVENT,
  handleShellCrashReport,
  subscribeShellCrashReports,
} from './shellCrashReports';

describe('shell crash reports', () => {
  beforeEach(() => {
    reportErrorMock.mockReset();
    listenMock.mockReset();
  });

  it('maps a main-process exception to the main_crash remote type', () => {
    handleShellCrashReport({
      kind: 'main_uncaught_exception',
      errorType: 'typeerror',
      reason: 'uncaughtException',
      message: 'cannot read properties of undefined',
    });

    expect(reportErrorMock).toHaveBeenCalledWith(
      'main_crash',
      'typeerror',
      undefined,
      undefined,
      'cannot read properties of undefined',
    );
  });

  it('maps a renderer death to renderer_crash and falls back to the crash reason', () => {
    handleShellCrashReport({
      kind: 'renderer_process_gone',
      errorType: 'render_process_gone',
      reason: 'oom',
      message: '',
      windowLabel: 'main',
    });

    expect(reportErrorMock).toHaveBeenCalledWith(
      'renderer_crash',
      'render_process_gone',
      undefined,
      undefined,
      'oom',
    );
  });

  it('ignores payloads that are not a known crash kind', () => {
    handleShellCrashReport(null);
    handleShellCrashReport('main_uncaught_exception');
    handleShellCrashReport({ kind: 'renderer_resources_cleared' });
    handleShellCrashReport({ errorType: 'typeerror' });

    expect(reportErrorMock).not.toHaveBeenCalled();
  });

  it('subscribes to the shell crash channel and forwards its payload', async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);

    await expect(subscribeShellCrashReports()).resolves.toBe(unlisten);
    expect(listenMock.mock.calls[0][0]).toBe(SHELL_CRASH_EVENT);

    const handler = listenMock.mock.calls[0][1] as (event: { payload: unknown }) => void;
    handler({ payload: { kind: 'main_unhandled_rejection', errorType: 'error', message: 'nope' } });

    expect(reportErrorMock).toHaveBeenCalledWith('main_crash', 'error', undefined, undefined, 'nope');
  });
});
