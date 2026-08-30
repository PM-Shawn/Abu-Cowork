// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import TaskBlock, { generateSummary, type UnifiedStep } from './TaskBlock';
import { getI18n, getLocale, format } from '@/i18n';
import type { ExecutionStep } from '@/types/execution';

function thinkingStep(duration?: number): UnifiedStep {
  return { id: 't1', type: 'thinking', label: '思考中...', status: 'completed', duration } as UnifiedStep;
}

describe('generateSummary — thinking-only block', () => {
  const t = getI18n();
  const locale = getLocale();
  it('shows "思考了 N 秒" when the thinking step has a duration', () => {
    expect(generateSummary([thinkingStep(5)], t, locale, false)).toBe(format(t.task.thoughtFor, { seconds: 5 }));
  });
  it('falls back to "思考过程" when no duration (settled block)', () => {
    expect(generateSummary([thinkingStep(undefined)], t, locale, false)).toBe(t.chat.thinkingProcess);
  });
  it('says "思考中" while live — continuing the placeholder dots row it replaces', () => {
    expect(generateSummary([thinkingStep(undefined)], t, locale, true)).toBe(t.chat.thinking);
  });
  it('uses the stopped terminal instead of completed action summaries', () => {
    expect(generateSummary([thinkingStep(5)], t, locale, false, true)).toBe(t.task.stopped);
  });
});

function execThinkingStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id: 'exec-t1',
    executionId: 'exec-1',
    type: 'thinking',
    label: '思考中...',
    detail: 'reasoning tokens streaming in',
    status: 'running',
    toolName: '',
    toolInput: {},
    source: 'agent',
    detailBlocks: [],
    ...overrides,
  };
}

// The expand-on-mount wrappers exist so that the timeline / streaming thinking
// pane appearing mid-stream grows its height over ~200ms instead of landing in
// one frame — with the chat pinned to the bottom, a one-frame height jump used
// to shift the whole view up in a single visible hop (the "思考中 → thinking
// block" placeholder jump). These tests pin the class placement, and — just as
// important — that settled blocks mount WITHOUT the animated wrapper, so rows
// remounting during history scrolling never animate their height.
describe('TaskBlock — expand-on-mount wrappers', () => {
  afterEach(() => cleanup());

  it('live block: timeline and streaming thinking pane both mount inside expand wrappers', () => {
    const { container } = render(
      <TaskBlock executionSteps={[execThinkingStep()]} isActive />,
    );
    const wrappers = container.querySelectorAll('.block-expand-enter');
    // One around the flow timeline, one on the running thinking pane itself.
    expect(wrappers.length).toBe(2);
    expect(wrappers[0].querySelector('.flow-timeline')).not.toBeNull();
    expect(container.querySelector('.flow-timeline .block-expand-enter')).not.toBeNull();
  });

  it('settled block mounts collapsed with no expand wrapper (no height animation on history remounts)', () => {
    const { container } = render(
      <TaskBlock
        executionSteps={[execThinkingStep({ status: 'completed', duration: 3 })]}
        isActive={false}
      />,
    );
    expect(container.querySelector('.block-expand-enter')).toBeNull();
  });

  it('auto-collapse keeps the timeline mounted and rolls it up (closed + inert), not unmounted', () => {
    const { container, rerender } = render(
      <TaskBlock executionSteps={[execThinkingStep()]} isActive />,
    );
    expect(container.querySelector('.block-expand-open')).not.toBeNull();
    // The answer starts streaming: steps complete, the block goes inactive →
    // auto-collapse. The timeline must stay in the DOM at grid-rows 0fr so the
    // close is a roll-up, not a one-frame blink-away.
    rerender(
      <TaskBlock
        executionSteps={[execThinkingStep({ status: 'completed', duration: 3 })]}
        isActive={false}
      />,
    );
    const wrapper = container.querySelector('.block-expand-closed');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector('.flow-timeline')).not.toBeNull();
    expect(wrapper!.hasAttribute('inert')).toBe(true);
    expect(wrapper!.getAttribute('aria-hidden')).toBe('true');
  });
});

// The thinking pane's running and completed states share one skeleton so the
// running → completed swap is a class mutation on mounted nodes, not a subtree
// replacement — the old two-structure swap landed a ~24px height change
// (toggle button + gap) in one frame, below SmoothHeight's threshold.
describe('TaskBlock — thinking pane running → completed', () => {
  afterEach(() => cleanup());

  const t = getI18n();
  const findThinkingToggle = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(t.chat.thinkingProcess),
    );
  // The button's own animated slot (button → .pb-2 → slot). `closest` would
  // walk past it up to the timeline wrapper, which is also a .block-expand.
  const toggleSlot = (toggle: HTMLElement) => toggle.parentElement!.parentElement!;

  it('keeps the streamed content mounted and animates the toggle button in', () => {
    const { container, rerender } = render(
      <TaskBlock executionSteps={[execThinkingStep()]} isActive />,
    );
    // Running: pane content present, no toggle button yet.
    expect(container.textContent).toContain('reasoning tokens streaming in');
    expect(findThinkingToggle(container)).toBeUndefined();

    rerender(
      <TaskBlock
        executionSteps={[execThinkingStep({ status: 'completed', duration: 3 })]}
        isActive={false}
      />,
    );
    // Completed: the content pre is still mounted, inside an OPEN panel
    // (thinkingExpanded persists across the transition)…
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('reasoning tokens streaming in');
    expect(pre!.closest('.block-expand')!.classList.contains('block-expand-open')).toBe(true);
    // …and the toggle button grows in through an animated slot instead of
    // landing its height in one frame.
    const toggle = findThinkingToggle(container);
    expect(toggle).toBeDefined();
    expect(toggleSlot(toggle!).classList.contains('block-expand')).toBe(true);
    expect(toggleSlot(toggle!).classList.contains('block-expand-enter')).toBe(true);
  });

  it('keeps long live thinking inside the max-h-48 scroll pane and follows its internal bottom', () => {
    const { container, rerender } = render(
      <TaskBlock executionSteps={[execThinkingStep()]} isActive />,
    );
    const pane = container.querySelector<HTMLElement>('.max-h-48.overflow-y-auto');
    expect(pane).not.toBeNull();
    Object.defineProperty(pane!, 'scrollHeight', { configurable: true, value: 480 });
    pane!.scrollTop = 0;

    rerender(
      <TaskBlock
        executionSteps={[execThinkingStep({ detail: 'reasoning tokens streaming in\nnext line' })]}
        isActive
      />,
    );

    expect(pane!.classList.contains('max-h-48')).toBe(true);
    expect(pane!.classList.contains('overflow-y-auto')).toBe(true);
    expect(pane!.scrollTop).toBe(480);
  });

  it('collapse via the toggle rolls the panel up (closed + inert), not unmounted; history mounts render the button statically', () => {
    const { container } = render(
      <TaskBlock
        executionSteps={[execThinkingStep({ status: 'completed', duration: 3 })]}
        isActive={false}
      />,
    );
    // Fresh settled mount: the timeline only mounts when the user opens the
    // summary header, so expand it first.
    fireEvent.click(container.querySelector('button')!);
    // Toggle button present but NOT inside an enter-animated slot (history
    // remounts must not animate), panel starts collapsed.
    const toggle = findThinkingToggle(container);
    expect(toggle).toBeDefined();
    expect(toggleSlot(toggle!).classList.contains('block-expand')).toBe(true);
    expect(toggleSlot(toggle!).classList.contains('block-expand-enter')).toBe(false);
    const panel = container.querySelector('pre')!.closest('.block-expand')!;
    expect(panel.classList.contains('block-expand-closed')).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(true);

    fireEvent.click(toggle!);
    expect(panel.classList.contains('block-expand-open')).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(false);

    fireEvent.click(toggle!);
    // Roll-up: still mounted, clipped closed.
    expect(panel.classList.contains('block-expand-closed')).toBe(true);
    expect(container.querySelector('pre')?.textContent).toContain(
      'reasoning tokens streaming in',
    );
  });
});
