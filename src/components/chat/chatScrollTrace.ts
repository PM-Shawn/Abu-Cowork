export const CHAT_SCROLL_TRACE_EVENT = 'abu:chat-scroll-trace';
export const CHAT_SCROLL_TRACE_RUNTIME_FLAG = '__ABU_CHAT_SCROLL_TRACE__';

export type ChatScrollFollowSource =
  | 'conversation-switch'
  | 'turn-anchor'
  | 'total-list-height'
  // Content the scroller measured itself, rather than a height Virtuoso
  // reported. Distinguishing the two is the point: a correction attributed
  // here is one no list-height callback would have delivered.
  | 'content-resize'
  | 'virtuoso-follow-output';

export type ChatScrollTracePhase = 'decision' | 'scheduled' | 'applied';

export interface ChatScrollTraceDetail {
  source: ChatScrollFollowSource;
  phase: ChatScrollTracePhase;
  atBottom?: boolean;
  totalListHeight?: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
  distanceToBottom?: number;
  scrollDelta?: number;
  anchorTop?: number;
  spacerHeight?: number;
  contentHeight?: number;
  baselineContentHeight?: number;
}

function scrollGeometry(element: HTMLElement | null): Pick<
  ChatScrollTraceDetail,
  'scrollTop' | 'scrollHeight' | 'clientHeight' | 'distanceToBottom'
> {
  if (!element) return {};
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceToBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
  };
}

/**
 * Renderer-observable timing marker for scroll-follow decisions and writes.
 * Electron E2E attaches a listener before app mount so a visible correction can
 * be attributed to the exact caller without enabling production telemetry.
 */
export function emitChatScrollTrace(
  source: ChatScrollFollowSource,
  phase: ChatScrollTracePhase,
  element: HTMLElement | null,
  detail: Omit<ChatScrollTraceDetail, 'source' | 'phase'> = {},
): void {
  if (typeof window === 'undefined') return;
  const traceWindow = window as Window & { __ABU_CHAT_SCROLL_TRACE__?: boolean };
  // Opt-in diagnostics only. This guard intentionally precedes every geometry
  // read so production streaming does not force layout when no one is tracing.
  if (traceWindow[CHAT_SCROLL_TRACE_RUNTIME_FLAG] !== true) return;
  window.dispatchEvent(new CustomEvent<ChatScrollTraceDetail>(CHAT_SCROLL_TRACE_EVENT, {
    detail: {
      source,
      phase,
      ...scrollGeometry(element),
      ...detail,
    },
  }));
}
