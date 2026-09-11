// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import {
  CHAT_SCROLL_TRACE_EVENT,
  emitChatScrollTrace,
  type ChatScrollTraceDetail,
} from './chatScrollTrace';

describe('chat scroll trace', () => {
  it('is disabled by default and avoids reading layout geometry', () => {
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(CHAT_SCROLL_TRACE_EVENT, listener);
    const element = document.createElement('div');
    const scrollHeight = vi.fn(() => 900);
    Object.defineProperty(element, 'scrollHeight', { configurable: true, get: scrollHeight });

    emitChatScrollTrace('total-list-height', 'applied', element);

    expect(listener).not.toHaveBeenCalled();
    expect(scrollHeight).not.toHaveBeenCalled();
    window.removeEventListener(CHAT_SCROLL_TRACE_EVENT, listener);
  });

  it('marks the exact follow source when the runtime switch is enabled', () => {
    (window as Window & { __ABU_CHAT_SCROLL_TRACE__?: boolean }).__ABU_CHAT_SCROLL_TRACE__ = true;
    const listener = vi.fn<(event: Event) => void>();
    window.addEventListener(CHAT_SCROLL_TRACE_EVENT, listener);
    const element = document.createElement('div');
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 400 },
    });
    element.scrollTop = 440;

    emitChatScrollTrace('total-list-height', 'applied', element, {
      totalListHeight: 880,
      scrollDelta: 56,
    });

    expect(listener).toHaveBeenCalledOnce();
    const event = listener.mock.calls[0][0] as CustomEvent<ChatScrollTraceDetail>;
    expect(event.detail).toEqual({
      source: 'total-list-height',
      phase: 'applied',
      totalListHeight: 880,
      scrollTop: 440,
      scrollHeight: 900,
      clientHeight: 400,
      distanceToBottom: 60,
      scrollDelta: 56,
    });

    window.removeEventListener(CHAT_SCROLL_TRACE_EVENT, listener);
    delete (window as Window & { __ABU_CHAT_SCROLL_TRACE__?: boolean }).__ABU_CHAT_SCROLL_TRACE__;
  });
});
