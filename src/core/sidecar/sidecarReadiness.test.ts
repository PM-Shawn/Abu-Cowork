import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let status = 'running';
const startSidecar = vi.fn(async () => { status = 'starting'; });
const waitForSidecarStatus = vi.fn();
const getSidecarStatus = vi.fn(() => status);
vi.mock('./sidecarManager', () => ({
  getSidecarStatus: () => getSidecarStatus(),
  startSidecar: () => startSidecar(),
  waitForSidecarStatus: (...a: unknown[]) => waitForSidecarStatus(...a),
  onSidecarStatusChange: () => () => {},
}));

import { useSidecarStatusStore } from '@/stores/sidecarStatusStore';
import { isInProcessAgentEnvironment, SIDECAR_READY_TIMEOUT_MS, SidecarUnavailableError, waitForSidecarVenue } from './sidecarReadiness';

type Internals = { __TAURI_INTERNALS__?: unknown };

describe('sidecarReadiness', () => {
  beforeEach(() => {
    status = 'running';
    startSidecar.mockClear();
    getSidecarStatus.mockClear();
    waitForSidecarStatus.mockReset();
    useSidecarStatusStore.setState({ status: 'running', waiting: {} });
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
    await waitForSidecarVenue({ conversationId: 'c1' });
    expect(getSidecarStatus).not.toHaveBeenCalled();
    expect(waitForSidecarStatus).not.toHaveBeenCalled();
    expect(startSidecar).not.toHaveBeenCalled();
    expect(useSidecarStatusStore.getState().waiting).toEqual({});
  });

  it('returns immediately when running', async () => {
    await waitForSidecarVenue({ conversationId: 'c1' });
    expect(waitForSidecarStatus).not.toHaveBeenCalled();
  });

  it('waits up to 60s while starting and marks the conversation as waiting meanwhile', async () => {
    status = 'starting';
    let finish!: (v: string) => void;
    waitForSidecarStatus.mockReturnValue(new Promise((r) => { finish = r; }));
    const waiting = waitForSidecarVenue({ conversationId: 'c1' });
    expect(waitForSidecarStatus).toHaveBeenCalledWith(SIDECAR_READY_TIMEOUT_MS, undefined);
    expect(useSidecarStatusStore.getState().waiting).toEqual({ c1: 1 });
    finish('running');
    await waiting;
    expect(useSidecarStatusStore.getState().waiting).toEqual({});
    expect(startSidecar).not.toHaveBeenCalled();
  });

  it('attempts exactly one start after failed/stopped, then fails visibly', async () => {
    status = 'failed';
    waitForSidecarStatus.mockResolvedValue('failed');
    const err = await waitForSidecarVenue().catch((e: unknown) => e);
    expect(startSidecar).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(SidecarUnavailableError);
    expect(err).toMatchObject({ code: 'sidecar_unavailable', stopReason: 'sidecar_unavailable', reason: 'failed' });
  });

  it('never starts the sidecar itself while it is already starting or restarting', async () => {
    status = 'restarting';
    waitForSidecarStatus.mockResolvedValue('running');
    await waitForSidecarVenue();
    expect(startSidecar).not.toHaveBeenCalled();
  });

  it('maps timeout and abort', async () => {
    status = 'restarting';
    waitForSidecarStatus.mockResolvedValueOnce('timeout');
    await expect(waitForSidecarVenue()).rejects.toMatchObject({ reason: 'timeout' });
    const controller = new AbortController();
    controller.abort(new Error('stop pressed'));
    waitForSidecarStatus.mockResolvedValueOnce('aborted');
    await expect(waitForSidecarVenue({ signal: controller.signal })).rejects.toThrow('stop pressed');
  });

  it('wraps a non-Error abort reason in an AbortError that keeps the text', async () => {
    status = 'starting';
    const controller = new AbortController();
    controller.abort('stop pressed');
    waitForSidecarStatus.mockResolvedValueOnce('aborted');
    const err = await waitForSidecarVenue({ signal: controller.signal, timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect(waitForSidecarStatus).toHaveBeenCalledWith(5_000, controller.signal);
    expect((err as Error).name).toBe('AbortError');
    expect((err as Error).message).toBe('stop pressed');
  });

  it('names a reasonless abort AbortError', async () => {
    status = 'starting';
    const controller = new AbortController();
    controller.abort();
    waitForSidecarStatus.mockResolvedValueOnce('aborted');
    const err = await waitForSidecarVenue({ signal: controller.signal, conversationId: 'c2' }).catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    // The waiting marker must be released even when the wait throws.
    expect(useSidecarStatusStore.getState().waiting).toEqual({});
  });
});
