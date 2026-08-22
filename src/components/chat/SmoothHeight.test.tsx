// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SmoothHeight from './SmoothHeight';

// jsdom has no ResizeObserver; install a controllable stub so tests can drive
// the resize callback by hand with fixed heights (determinism rule: no real
// layout, no real timers beyond vitest's fake clock).
type ROCallback = (entries: { contentRect: { height: number } }[]) => void;
let roCallback: ROCallback | null = null;
let observed: Element | null = null;

class ResizeObserverStub {
  constructor(cb: ROCallback) {
    roCallback = cb;
  }
  observe(el: Element) {
    observed = el;
  }
  disconnect() {
    roCallback = null;
    observed = null;
  }
}

function fireResize(height: number) {
  roCallback?.([{ contentRect: { height } }]);
}

describe('SmoothHeight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    roCallback = null;
    observed = null;
  });

  function renderWrapper() {
    const { container } = render(
      <SmoothHeight>
        <span>content</span>
      </SmoothHeight>,
    );
    const outer = container.firstElementChild as HTMLDivElement;
    return outer;
  }

  it('observes the inner content element', () => {
    const outer = renderWrapper();
    expect(observed).toBe(outer.firstElementChild);
  });

  it('never animates the first measure after mount (virtualized remounts must not dance)', () => {
    const outer = renderWrapper();
    fireResize(500);
    expect(outer.style.height).toBe('');
    expect(outer.style.transition).toBe('');
  });

  it('leaves small (streaming-token-sized) height changes instant', () => {
    const outer = renderWrapper();
    fireResize(100);
    fireResize(120); // +20px ≤ threshold
    expect(outer.style.height).toBe('');
    expect(outer.style.transition).toBe('');
  });

  it('animates a large shrink (the completion-fold swap) and settles back to auto', async () => {
    const outer = renderWrapper();
    fireResize(300);
    fireResize(100); // -200px > threshold
    expect(outer.style.height).toBe('100px');
    expect(outer.style.transition).toContain('height');
    expect(outer.style.overflow).toBe('hidden');
    // After the transition window (280ms + 50ms settle margin) the inline
    // overrides are cleared → auto.
    await vi.advanceTimersByTimeAsync(330);
    expect(outer.style.height).toBe('');
    expect(outer.style.transition).toBe('');
    expect(outer.style.overflow).toBe('');
  });

  it('retargets to the newest height when content changes mid-animation', async () => {
    const outer = renderWrapper();
    fireResize(300);
    fireResize(100); // starts an animation toward 100px
    fireResize(140); // small delta, but an animation is in flight → retarget
    expect(outer.style.height).toBe('140px');
    await vi.advanceTimersByTimeAsync(330);
    expect(outer.style.height).toBe('');
  });

  it('does not animate when prefers-reduced-motion is set', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true }),
    );
    const outer = renderWrapper();
    fireResize(300);
    fireResize(100);
    expect(outer.style.height).toBe('');
    expect(outer.style.transition).toBe('');
  });

  it('observes nothing when disabled (settled history groups)', () => {
    render(
      <SmoothHeight enabled={false}>
        <span>content</span>
      </SmoothHeight>,
    );
    expect(observed).toBeNull();
  });

  it('renders inert without ResizeObserver (jsdom safety)', () => {
    vi.unstubAllGlobals();
    // @ts-expect-error — simulate an environment without ResizeObserver
    delete globalThis.ResizeObserver;
    const { container } = render(
      <SmoothHeight>
        <span>content</span>
      </SmoothHeight>,
    );
    expect(container.textContent).toBe('content');
  });
});
