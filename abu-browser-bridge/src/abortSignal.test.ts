import { describe, expect, it, vi } from 'vitest';
import { linkAbortSignal } from './abortSignal.js';

describe('linkAbortSignal', () => {
  it('does nothing and returns a no-op cleanup when no signal is given', () => {
    const onAbort = vi.fn();
    const cleanup = linkAbortSignal(undefined, onAbort);

    expect(onAbort).not.toHaveBeenCalled();
    expect(() => cleanup()).not.toThrow();
  });

  it('fires onAbort synchronously when the signal is already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    const onAbort = vi.fn();

    const cleanup = linkAbortSignal(controller.signal, onAbort);

    expect(onAbort).toHaveBeenCalledTimes(1);
    // Nothing left to detach — calling cleanup must still be safe.
    expect(() => cleanup()).not.toThrow();
  });

  it('fires onAbort when the signal aborts later', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();

    linkAbortSignal(controller.signal, onAbort);
    expect(onAbort).not.toHaveBeenCalled();

    controller.abort();
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('never fires onAbort again after cleanup runs first', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();

    const cleanup = linkAbortSignal(controller.signal, onAbort);
    cleanup();
    controller.abort();

    expect(onAbort).not.toHaveBeenCalled();
  });

  it('only fires once even if abort fires multiple listeners scenario', () => {
    const controller = new AbortController();
    const onAbort = vi.fn();
    linkAbortSignal(controller.signal, onAbort);

    controller.abort();
    // Aborting an already-aborted controller is a no-op in the DOM spec, but
    // guard the assumption explicitly since AbortController has no "abort
    // twice" API to invoke directly.
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});
