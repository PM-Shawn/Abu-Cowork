import type { Message } from '@/types';

export const ANCHOR_TOLERANCE_PX = 2;
export const CHAPTER_RAIL_BOTTOM_THRESHOLD_PX = 24;
export const VIRTUOSO_AT_BOTTOM_THRESHOLD_PX = 100;

export interface TurnAnchorCandidate {
  conversationId: string;
  messageId: string;
}

export interface TurnScrollAnchor extends TurnAnchorCandidate {
  phase: 'armed' | 'exhausted';
  targetTop: number;
  initialScrollDelta: number;
  initialSpacerHeight: number;
  spacerHeight: number;
  baselineContentHeight: number;
}

export interface TurnScrollAnchorExit {
  anchor: null;
  spacerHeight: number;
  pinned: boolean;
}

export type TurnScrollAnchorExitReason =
  | 'user-scroll-intent'
  | 'explicit-latest'
  | 'conversation-switch'
  | 'run-terminal'
  | 'arm-abandoned'
  | 'search-jump'
  | 'chapter-jump';

function nonNegative(value: number): number {
  return Math.max(0, value);
}

export function selectLatestUserAnchor(
  conversationId: string,
  messages: readonly Message[],
): TurnAnchorCandidate | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      return { conversationId, messageId: messages[index].id };
    }
  }
  return null;
}

export function findUserMessageAnchor(root: ParentNode, messageId: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (element.dataset.messageId === messageId) return element;
  }
  return null;
}

export function armTurnScrollAnchor(input: {
  conversationId: string;
  messageId: string;
  anchorTop: number;
  targetTop: number;
  distanceToBottom: number;
  contentHeight: number;
}): TurnScrollAnchor {
  const initialScrollDelta = nonNegative(input.anchorTop - input.targetTop);
  const existingScrollRange = nonNegative(input.distanceToBottom);
  // The spacer is real scrollable geometry, so every pixel must correspond to
  // range that is actually missing. A former +96px measurement reserve left a
  // matching blind gap and merely delayed the hard return to bottom.
  const initialSpacerHeight = nonNegative(initialScrollDelta - existingScrollRange);
  return {
    conversationId: input.conversationId,
    messageId: input.messageId,
    phase: initialSpacerHeight > 0 ? 'armed' : 'exhausted',
    targetTop: input.targetTop,
    initialScrollDelta,
    initialSpacerHeight,
    spacerHeight: initialSpacerHeight,
    baselineContentHeight: input.contentHeight,
  };
}

export function reconcileTurnScrollAnchor(
  anchor: TurnScrollAnchor,
  input: {
    contentHeight: number;
    anchorPresent: boolean;
  },
): {
  anchor: TurnScrollAnchor;
  contentHeight: number;
  spacerHeight: number;
  handoff: 'none' | 'sync-bottom';
} {
  const contentHeight = input.contentHeight;
  const contentDelta = contentHeight - anchor.baselineContentHeight;
  const computedSpacerHeight = nonNegative(anchor.initialSpacerHeight - contentDelta);
  const spacerHeight = input.anchorPresent ? computedSpacerHeight : 0;
  const phase = spacerHeight > 0 ? 'armed' : 'exhausted';
  return {
    anchor: { ...anchor, phase, spacerHeight },
    contentHeight,
    spacerHeight,
    handoff: phase === 'exhausted' ? 'sync-bottom' : 'none',
  };
}

export function canArmTurnScrollAnchor(input: {
  anchorHeight: number;
  viewportHeight: number;
  targetTop: number;
}): boolean {
  if (input.anchorHeight <= 0 || input.viewportHeight <= 0) return false;
  // Keep one target-sized breathing band below the user bubble. Otherwise a
  // viewport-height prompt anchored at the top hides the assistant response.
  return input.anchorHeight <= input.viewportHeight - (input.targetTop * 2);
}

export function getAnchorScrollCorrection(targetTop: number, currentTop: number): number {
  const delta = currentTop - targetTop;
  return Math.abs(delta) <= ANCHOR_TOLERANCE_PX ? 0 : delta;
}

export function shouldFollowOutput(anchor: TurnScrollAnchor | null): 'auto' | false {
  return anchor?.phase === 'armed' ? false : 'auto';
}

export function isChapterRailAtBottom(
  distanceToBottom: number,
  anchor: TurnScrollAnchor | null,
  pinned: boolean,
): boolean {
  if (anchor?.phase === 'armed' && pinned) return true;
  return distanceToBottom <= CHAPTER_RAIL_BOTTOM_THRESHOLD_PX;
}

export function isAtBottomFromGeometry(distanceToBottom: number): boolean {
  return distanceToBottom <= VIRTUOSO_AT_BOTTOM_THRESHOLD_PX;
}

export function exitTurnScrollAnchor(
  anchor: TurnScrollAnchor | null,
  reason: TurnScrollAnchorExitReason,
): TurnScrollAnchorExit {
  if (reason === 'user-scroll-intent') {
    return {
      anchor: null,
      spacerHeight: anchor?.spacerHeight ?? 0,
      pinned: false,
    };
  }
  if (reason === 'search-jump' || reason === 'chapter-jump') {
    return {
      anchor: null,
      spacerHeight: 0,
      pinned: false,
    };
  }
  return {
    anchor: null,
    spacerHeight: 0,
    pinned: true,
  };
}
