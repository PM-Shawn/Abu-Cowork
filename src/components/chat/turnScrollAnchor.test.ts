import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  ANCHOR_TOLERANCE_PX,
  CHAPTER_RAIL_BOTTOM_THRESHOLD_PX,
  VIRTUOSO_AT_BOTTOM_THRESHOLD_PX,
  armTurnScrollAnchor,
  canArmTurnScrollAnchor,
  exitTurnScrollAnchor,
  getAnchorScrollCorrection,
  isAtBottomFromGeometry,
  isChapterRailAtBottom,
  reconcileTurnScrollAnchor,
  selectLatestUserAnchor,
  shouldFollowOutput,
} from './turnScrollAnchor';

const BASE_CONTENT_HEIGHT = 1_000;

function arm(overrides: Partial<Parameters<typeof armTurnScrollAnchor>[0]> = {}) {
  return armTurnScrollAnchor({
    conversationId: 'conversation-1',
    messageId: 'user-1',
    anchorTop: 420,
    targetTop: 20,
    distanceToBottom: 0,
    contentHeight: BASE_CONTENT_HEIGHT,
    ...overrides,
  });
}

describe('turn scroll anchor invariants', () => {
  it('keeps correction inside the 2px anchor tolerance at zero', () => {
    expect(ANCHOR_TOLERANCE_PX).toBe(2);
    expect(getAnchorScrollCorrection(20, 21.9)).toBe(0);
    expect(getAnchorScrollCorrection(20, 22.1)).toBeCloseTo(2.1);
    expect(getAnchorScrollCorrection(20, 17)).toBe(-3);
  });

  it('allocates exactly the missing scroll range without a physical measurement reserve', () => {
    expect(arm()).toMatchObject({
      phase: 'armed',
      targetTop: 20,
      initialScrollDelta: 400,
      initialSpacerHeight: 400,
      spacerHeight: 400,
      baselineContentHeight: BASE_CONTENT_HEIGHT,
    });
    expect(arm({ distanceToBottom: 75 })).toMatchObject({
      initialScrollDelta: 400,
      initialSpacerHeight: 325,
    });
  });

  it('absorbs active-tail growth into the footer spacer with zero net list-height change', () => {
    const initial = arm();
    const afterGrowth = reconcileTurnScrollAnchor(initial, {
      contentHeight: 1_120,
      anchorPresent: true,
    });

    expect(afterGrowth.anchor).toMatchObject({ phase: 'armed', spacerHeight: 280 });
    expect(afterGrowth.contentHeight + afterGrowth.spacerHeight).toBe(1_400);
    expect(afterGrowth.handoff).toBe('none');
  });

  it('risk B — counteracts SmoothHeight growth and shrink without spacer oscillation', () => {
    let anchor = arm();
    let spacerHeight = anchor.spacerHeight;

    for (const contentHeight of [1_120, 1_080, 1_160, 1_040, 1_200]) {
      const result = reconcileTurnScrollAnchor(anchor, {
        contentHeight,
        anchorPresent: true,
      });
      anchor = result.anchor;
      spacerHeight = result.spacerHeight;
      expect(contentHeight + spacerHeight).toBe(1_400);
      expect(anchor.phase).toBe('armed');
    }
    expect(spacerHeight).toBe(anchor.spacerHeight);
  });

  it('risk C — requests a same-layout-pass bottom handoff when the spacer exhausts', () => {
    const result = reconcileTurnScrollAnchor(arm(), {
      contentHeight: 1_400,
      anchorPresent: true,
    });

    expect(result.anchor).toMatchObject({ phase: 'exhausted', spacerHeight: 0 });
    expect(result.handoff).toBe('sync-bottom');
    expect(shouldFollowOutput(result.anchor)).toBe('auto');
  });

  it('risk C — an unmounted anchor also requests a synchronous handoff', () => {
    expect(reconcileTurnScrollAnchor(arm(), {
      contentHeight: BASE_CONTENT_HEIGHT,
      anchorPresent: false,
    }).handoff).toBe('sync-bottom');
  });

  it('risk E — never follows content after explicit upward intent and preserves the frozen spacer', () => {
    const anchor = arm();
    const exit = exitTurnScrollAnchor(anchor, 'user-scroll-intent');

    expect(exit).toEqual({
      anchor: null,
      spacerHeight: 400,
      pinned: false,
    });
  });

  it('risk E — clears spacer and restores pinned bottom state for an explicit latest jump', () => {
    expect(exitTurnScrollAnchor(arm(), 'explicit-latest')).toEqual({
      anchor: null,
      spacerHeight: 0,
      pinned: true,
    });
  });

  it.each([
    ['conversation-switch', true],
    ['run-terminal', true],
    ['arm-abandoned', true],
    ['search-jump', false],
    ['chapter-jump', false],
  ] as const)('resets anchor state for %s', (reason, pinned) => {
    expect(exitTurnScrollAnchor(arm(), reason)).toEqual({
      anchor: null,
      spacerHeight: 0,
      pinned,
    });
  });

  it('risk F7 — derives bottom state from geometry instead of forcing false on unpin', () => {
    expect(VIRTUOSO_AT_BOTTOM_THRESHOLD_PX).toBe(100);
    expect(isAtBottomFromGeometry(1)).toBe(true);
    expect(isAtBottomFromGeometry(99.9)).toBe(true);
    expect(isAtBottomFromGeometry(100.1)).toBe(false);
  });

  it('risk F8 — declines a top anchor when the user bubble would consume the viewport', () => {
    expect(canArmTurnScrollAnchor({ anchorHeight: 240, viewportHeight: 600, targetTop: 20 })).toBe(true);
    expect(canArmTurnScrollAnchor({ anchorHeight: 580, viewportHeight: 600, targetTop: 20 })).toBe(false);
  });
});

describe('risk A — chapter rail geometry', () => {
  it('treats an armed pinned spacer as the newest chapter despite its physical distance', () => {
    expect(CHAPTER_RAIL_BOTTOM_THRESHOLD_PX).toBe(24);
    expect(isChapterRailAtBottom(300, arm(), true)).toBe(true);
    expect(isChapterRailAtBottom(300, arm(), false)).toBe(false);
    expect(isChapterRailAtBottom(23.9, null, false)).toBe(true);
    expect(isChapterRailAtBottom(24.1, null, false)).toBe(false);
  });
});

describe('risk D — anchor rebinding', () => {
  it('selects the newest persisted user id even when legacy turns reused one loop id', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'first', timestamp: 1, loopId: 'loop-1' },
      { id: 'assistant-1', role: 'assistant', content: 'answer', timestamp: 2, loopId: 'loop-1' },
      { id: 'user-2', role: 'user', content: 'queued', timestamp: 3, loopId: 'loop-1' },
      { id: 'assistant-2', role: 'assistant', content: '', timestamp: 4, loopId: 'loop-1', isStreaming: true },
    ];

    expect(selectLatestUserAnchor('conversation-1', messages)).toEqual({
      conversationId: 'conversation-1',
      messageId: 'user-2',
    });
    expect(messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
  });
});
