import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let status = 'running';
const startSidecar = vi.fn(async () => { status = 'starting'; });
const waitForSidecarStatus = vi.fn();
const getSidecarStatus = vi.fn(() => status);
vi.mock('./sidecarManager', () => ({
  getSidecarStatus: () => getSidecarStatus(),
  startSidecar: () => startSidecar(),
  waitForSidecarStatus: (...a: unknown[]) => waitForSidecarStatus(...a),
}));

import { isInProcessAgentEnvironment, SIDECAR_READY_TIMEOUT_MS, SidecarUnavailableError, waitForSidecarVenue } from './sidecarReadiness';

type Internals = { __TAURI_INTERNALS__?: unknown };

describe('sidecarReadiness', () => {
  beforeEach(() => {
    status = 'running';
    startSidecar.mockClear();
    getSidecarStatus.mockClear();
    waitForSidecarStatus.mockReset();
    (globalThis as { window?: unknown }).window = globalThis;
    (globalThis as Internals).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    delete (globalThis as Internals).__TAURI_INTERNALS__;
    delete (globalThis as { window?: unknown }).window;
  });

  it('treats a missing Electron/Tauri bridge as the in-process environment', () => {
    expect(isInProcessAgentEnvironment()).toBe(false);
    delete (globalThis as Internals).__TAURI_INTERNALS__;
    expect(isInProcessAgentEnvironment()).toBe(true);
  });

  it('resolves immediately in the in-process environment without touching the sidecar', async () => {
    delete (globalThis as Internals).__TAURI_INTERNALS__;
    status = 'failed';
    await waitForSidecarVenue();
    expect(getSidecarStatus).not.toHaveBeenCalled();
    expect(waitForSidecarStatus).not.toHaveBeenCalled();
    expect(startSidecar).not.toHaveBeenCalled();
  });

  it('returns immediately when running', async () => {
    await waitForSidecarVenue();
    expect(waitForSidecarStatus).not.toHaveBeenCalled();
  });

  it('waits up to 60s while starting', async () => {
    status = 'starting';
    let finish!: (v: string) => void;
    waitForSidecarStatus.mockReturnValue(new Promise((r) => { finish = r; }));
    const waiting = waitForSidecarVenue();
    expect(waitForSidecarStatus).toHaveBeenCalledWith(SIDECAR_READY_TIMEOUT_MS, undefined);
    finish('running');
    await waiting;
    expect(startSidecar).not.toHaveBeenCalled();
  });

  it('attempts exactly one start after failed/stopped with allowRestart, then fails visibly', async () => {
    status = 'failed';
    waitForSidecarStatus.mockResolvedValue('failed');
    const err = await waitForSidecarVenue({ allowRestart: true }).catch((e: unknown) => e);
    expect(startSidecar).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(SidecarUnavailableError);
    expect(err).toMatchObject({ code: 'sidecar_unavailable', stopReason: 'sidecar_unavailable', reason: 'failed' });
  });

  it.each(['failed', 'stopped'])(
    'never restarts a %s sidecar by default — headless dispatchers must not re-arm the crash-loop window',
    async (dead) => {
      status = dead;
      const err = await waitForSidecarVenue().catch((e: unknown) => e);
      expect(startSidecar).not.toHaveBeenCalled();
      expect(waitForSidecarStatus).not.toHaveBeenCalled();
      expect(err).toBeInstanceOf(SidecarUnavailableError);
      expect(err).toMatchObject({ reason: 'failed', lastStatus: dead });
    },
  );

  it('still waits (without restarting) for a starting sidecar when allowRestart is false', async () => {
    status = 'starting';
    waitForSidecarStatus.mockResolvedValue('running');
    await waitForSidecarVenue();
    expect(startSidecar).not.toHaveBeenCalled();
    expect(waitForSidecarStatus).toHaveBeenCalledTimes(1);
  });

  it('throws the abort reason at entry without restarting or waiting', async () => {
    status = 'failed';
    const controller = new AbortController();
    controller.abort(new Error('stop pressed'));
    await expect(waitForSidecarVenue({ signal: controller.signal, allowRestart: true }))
      .rejects.toThrow('stop pressed');
    expect(startSidecar).not.toHaveBeenCalled();
    expect(waitForSidecarStatus).not.toHaveBeenCalled();
  });

  it('never starts the sidecar itself while it is already starting or restarting', async () => {
    status = 'restarting';
    waitForSidecarStatus.mockResolvedValue('running');
    await waitForSidecarVenue();
    expect(startSidecar).not.toHaveBeenCalled();
  });

  /** Abort that arrives mid-wait (Stop pressed while the send is still waiting). */
  function abortDuringWait(controller: AbortController, reason?: unknown): void {
    waitForSidecarStatus.mockImplementationOnce(async () => {
      controller.abort(reason);
      return 'aborted';
    });
  }

  it('maps timeout and abort', async () => {
    status = 'restarting';
    waitForSidecarStatus.mockResolvedValueOnce('timeout');
    await expect(waitForSidecarVenue()).rejects.toMatchObject({ reason: 'timeout' });
    const controller = new AbortController();
    abortDuringWait(controller, new Error('stop pressed'));
    await expect(waitForSidecarVenue({ signal: controller.signal })).rejects.toThrow('stop pressed');
  });

  it('wraps a non-Error abort reason in an AbortError that keeps the text', async () => {
    status = 'starting';
    const controller = new AbortController();
    abortDuringWait(controller, 'stop pressed');
    const err = await waitForSidecarVenue({ signal: controller.signal, timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect(waitForSidecarStatus).toHaveBeenCalledWith(5_000, controller.signal);
    expect((err as Error).name).toBe('AbortError');
    expect((err as Error).message).toBe('stop pressed');
  });

  it('names a reasonless abort AbortError', async () => {
    status = 'starting';
    const controller = new AbortController();
    abortDuringWait(controller);
    const err = await waitForSidecarVenue({ signal: controller.signal }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
  });
});
