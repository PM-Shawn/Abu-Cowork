// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import TaskBlock, { convertExecutionStep, generateSummary, type UnifiedStep } from './TaskBlock';
import { ThinkingStatusLine } from './ThinkingStatusLine';
import { getI18n, getLocale, format } from '@/i18n';
import { snapshotExecutionSteps, snapshotToExecutionSteps } from '@/core/agent/executionSnapshot';
import { usePreviewStore } from '@/stores/previewStore';
import type { ExecutionStep } from '@/types/execution';
import type { FileChange } from '@/types/fileChange';

function thinkingStep(duration?: number): UnifiedStep {
  return { id: 't1', type: 'thinking', label: '思考中...', status: 'completed', duration } as UnifiedStep;
}

describe('generateSummary — presenting files', () => {
  const t = getI18n();
  const locale = getLocale();

  function toolStep(id: string, toolName: string, type: UnifiedStep['type']): UnifiedStep {
    return { id, type, label: toolName, status: 'completed', toolName } as UnifiedStep;
  }

  it('names the present_files step as presenting files, apart from other tool calls', () => {
    const steps = [
      toolStep('s1', 'write_file', 'file-create'),
      toolStep('s2', 'present_files', 'tool'),
    ];
    const summary = generateSummary(steps, t, locale, false);
    expect(summary).toContain(t.task.presentedFiles);
    expect(summary).toContain(t.task.createdFile);
    expect(summary).not.toContain(t.task.calledTool);
  });

  it('keeps the tool-call wording for a group without present_files', () => {
    const summary = generateSummary([toolStep('s1', 'report_plan', 'tool')], t, locale, false);
    expect(summary).toBe(t.task.calledTool);
  });
});

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

function execCommandStep(id: string, label: string, overrides: Partial<ExecutionStep> = {}): ExecutionStep {
  return {
    id,
    executionId: 'exec-1',
    type: 'command',
    label,
    status: 'running',
    toolName: '',
    toolInput: {},
    source: 'agent',
    detailBlocks: [],
    ...overrides,
  };
}

// One spinner per place: the block's header carries the only moving indicator;
// every step running inside it shows the same loading glyph standing still.
describe('TaskBlock — one spinner per block', () => {
  afterEach(() => cleanup());

  const stepRow = (label: string) => screen.getByText(label).closest('.flex.items-start') as HTMLElement;

  it('shows a single status spinner in the header while two steps run', () => {
    render(
      <TaskBlock
        executionSteps={[execCommandStep('s1', 'Step one'), execCommandStep('s2', 'Step two')]}
        isActive
      />,
    );
    const statuses = screen.getAllByRole('status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].querySelector('[data-ds-spinner]')).not.toBeNull();
    expect(statuses[0].closest('button')).not.toBeNull();
    for (const label of ['Step one', 'Step two']) {
      const row = stepRow(label);
      expect(row.querySelector('svg.lucide-loader-circle')).not.toBeNull();
      expect(row.querySelector('[data-ds-spinner]')).toBeNull();
    }
  });

  it('starts its header text in the same column as the rows it replaces', () => {
    render(<TaskBlock executionSteps={[execCommandStep('s1', 'Step one')]} isActive />);
    const header = screen.getAllByRole('button')[0];
    expect(header.className).not.toMatch(/(^|\s)px-/);
    expect(header.className).not.toMatch(/(^|\s)pl-/);
    expect(header).toHaveClass('text-label-secondary');
    expect(header).toHaveClass('hover:text-label');
  });

  // The words start after the spinner icon plus the same gap-2, so equal icon widths
  // mean the status line's 「思考中」 and the header's words start in the same column.
  it('draws the same spinner width as the status line it follows', () => {
    const { container: line } = render(<ThinkingStatusLine label="思考中" />);
    const { container: block } = render(<TaskBlock executionSteps={[execCommandStep('s1', 'Step one')]} isActive />);
    const lineIcon = line.querySelector('[data-ds-spinner] svg');
    const headerIcon = block.querySelector('.task-block > button [data-ds-spinner] svg');
    expect(headerIcon).not.toBeNull();
    expect(lineIcon?.getAttribute('width')).toBe(headerIcon?.getAttribute('width'));
  });

  it('marks finished steps with a check and failed steps with a cross', () => {
    render(
      <TaskBlock
        executionSteps={[
          execCommandStep('s1', 'Step done', { status: 'completed' }),
          execCommandStep('s2', 'Step failed', { status: 'error' }),
        ]}
        isActive={false}
      />,
    );
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(stepRow('Step done').querySelector('svg.lucide-circle-check')).not.toBeNull();
    expect(stepRow('Step done').querySelector('svg.text-success')).not.toBeNull();
    expect(stepRow('Step failed').querySelector('svg.lucide-circle-x')).not.toBeNull();
    expect(stepRow('Step failed').querySelector('svg.text-danger')).not.toBeNull();
    expect(document.querySelector('[data-ds-spinner]')).toBeNull();
  });
});

describe('TaskBlock — file change of a step', () => {
  const t = getI18n();
  const originalOpenPreview = usePreviewStore.getState().openPreview;
  const openPreview = vi.fn();

  beforeEach(() => {
    openPreview.mockReset();
    usePreviewStore.setState({ openPreview });
  });

  afterEach(() => {
    cleanup();
    usePreviewStore.setState({ openPreview: originalOpenPreview });
  });

  const editChange: FileChange = {
    path: '/w/plan.md',
    kind: 'modify',
    added: 3,
    deleted: 3,
    hunks: [{
      oldStart: 2,
      oldLines: 9,
      newStart: 2,
      newLines: 9,
      lines: [
        ' line 2', ' line 3', ' line 4',
        '-line 5', '-line 6', '-line 7',
        '+five', '+six', '+seven',
        ' line 8', ' line 9', ' line 10',
      ],
    }],
  };

  function fileStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
    return {
      id: 'step-edit',
      executionId: 'exec-1',
      toolCallId: 'tc-edit',
      type: 'file-write',
      label: 'Edit plan.md',
      status: 'completed',
      toolName: 'edit_file',
      toolInput: { path: '/w/plan.md', old_content: 'a', new_content: 'b' },
      toolResult: 'Successfully edited /w/plan.md: replaced 3 line(s) with 3 line(s)',
      source: 'agent',
      detailBlocks: [],
      ...overrides,
    };
  }

  function renderOpen(steps: ExecutionStep[], fileChanges?: Map<string, FileChange>) {
    const view = render(<TaskBlock executionSteps={steps} isActive={false} fileChanges={fileChanges} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
    return view;
  }

  const diffRows = (container: HTMLElement) => container.querySelectorAll('[data-diff-row]');
  const fileButton = (name: string) =>
    screen.queryByRole('button', { name: format(t.chat.openFileInPreview, { name }) });
  const countsToggle = (added: number, deleted: number) =>
    screen.queryByRole('button', { name: `+${added} −${deleted}` });

  it('shows the added and deleted line counts on the step row', () => {
    renderOpen([fileStep()], new Map([['tc-edit', editChange]]));

    expect(screen.getByText('+3')).toHaveClass('text-success');
    expect(screen.getByText('−3')).toHaveClass('text-danger');
  });

  it('opens the file in the side preview when its name is pressed', () => {
    renderOpen([fileStep()], new Map([['tc-edit', editChange]]));

    const name = fileButton('plan.md')!;
    expect(name).toHaveTextContent(/^plan\.md$/);
    expect(name.parentElement).toHaveTextContent(/^Edit plan\.md/);
    fireEvent.click(name);

    expect(openPreview).toHaveBeenCalledTimes(1);
    expect(openPreview).toHaveBeenCalledWith('/w/plan.md');
  });

  it('shows the diff folded to five and four rows once the counts are pressed, then all of it', () => {
    const { container } = renderOpen([fileStep()], new Map([['tc-edit', editChange]]));
    const toggle = countsToggle(3, 3)!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(diffRows(container)).toHaveLength(0);

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(diffRows(container)).toHaveLength(9);
    expect(container.querySelectorAll('[data-diff-row="deleted"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-diff-row="added"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: format(t.chat.showAllDiffLines, { count: 12 }) }));

    expect(diffRows(container)).toHaveLength(12);
    expect(container.querySelectorAll('[data-diff-row="deleted"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-diff-row="added"]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-diff-row="context"]')).toHaveLength(6);

    fireEvent.click(toggle);
    expect(diffRows(container)).toHaveLength(0);
  });

  it('closes a cut diff with the note once all saved rows are shown', () => {
    renderOpen([fileStep()], new Map([['tc-edit', { ...editChange, cut: true }]]));
    fireEvent.click(countsToggle(3, 3)!);
    expect(screen.queryByText(t.chat.diffCut)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: format(t.chat.showAllDiffLines, { count: 12 }) }));

    expect(screen.getByText(t.chat.diffCut)).toBeInTheDocument();
  });

  it('shows a new file as added lines', () => {
    const created: FileChange = {
      path: '/w/outline.md',
      kind: 'create',
      added: 2,
      deleted: 0,
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+# Title', '+Body'] }],
    };
    const { container } = renderOpen(
      [fileStep({ toolCallId: 'tc-write', toolName: 'write_file', label: 'Write outline.md', toolInput: { path: '/w/outline.md', content: '# Title\nBody\n' } })],
      new Map([['tc-write', created]]),
    );

    expect(fileButton('outline.md')).not.toBeNull();
    fireEvent.click(countsToggle(2, 0)!);

    expect(container.querySelectorAll('[data-diff-row="added"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-diff-row="deleted"]')).toHaveLength(0);
    expect(screen.getByText('# Title')).toBeInTheDocument();
  });

  it('shows counts without a diff toggle when the change holds no hunks', () => {
    renderOpen([fileStep()], new Map([['tc-edit', { path: '/w/plan.md', kind: 'modify', added: 3, deleted: 3, cut: true }]]));

    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('−3')).toBeInTheDocument();
    expect(countsToggle(3, 3)).toBeNull();
  });

  it('shows only the file name for a change that has no line counts', () => {
    renderOpen([fileStep()], new Map([['tc-edit', { path: '/w/plan.md', kind: 'modify' }]]));

    expect(fileButton('plan.md')).not.toBeNull();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
    expect(screen.queryByText(/^−\d+$/)).toBeNull();
  });

  it('names a deleted file without making it a preview button', () => {
    renderOpen(
      [fileStep({ toolCallId: 'tc-delete', type: 'tool', toolName: 'delete_file', label: 'Call delete_file', toolInput: { path: '/w/draft.md' } })],
      new Map([['tc-delete', { path: '/w/draft.md', kind: 'delete', added: 0, deleted: 4 }]]),
    );

    expect(screen.getByText('draft.md')).toBeInTheDocument();
    expect(fileButton('draft.md')).toBeNull();
    expect(screen.getByText('+0')).toBeInTheDocument();
    expect(screen.getByText('−4')).toBeInTheDocument();
  });

  it('reads the change for a step restored from a saved snapshot', () => {
    const restored = snapshotToExecutionSteps(snapshotExecutionSteps([fileStep()]));
    expect(restored[0].toolInput).toEqual({});

    const { container } = renderOpen(restored, new Map([['tc-edit', editChange]]));

    expect(fileButton('plan.md')).not.toBeNull();
    fireEvent.click(countsToggle(3, 3)!);
    expect(diffRows(container)).toHaveLength(9);
  });

  it('reads the change for a legacy step by its tool call id', () => {
    render(
      <TaskBlock
        steps={[{
          id: 'tc-edit',
          type: 'file-write',
          label: 'Edit plan.md',
          status: 'completed',
          timestamp: 1,
          toolName: 'edit_file',
          toolInput: { path: '/w/plan.md' },
        }]}
        isActive={false}
        fileChanges={new Map([['tc-edit', editChange]])}
      />,
    );
    fireEvent.click(screen.getAllByRole('button')[0]);

    expect(countsToggle(3, 3)).not.toBeNull();
    expect(fileButton('plan.md')).not.toBeNull();
  });

  it('shows a step without a file change as plain text', () => {
    renderOpen([fileStep()]);

    expect(screen.getByText('Edit plan.md')).toBeInTheDocument();
    expect(fileButton('plan.md')).toBeNull();
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it('shows no counts and no file button on the steps of a subagent', () => {
    const child = fileStep({ id: 'child-edit', toolCallId: 'tc-child', label: 'Edit plan.md' });
    const delegate = fileStep({
      id: 'step-delegate',
      toolCallId: 'tc-delegate',
      type: 'delegate',
      toolName: 'delegate_to_agent',
      label: 'Delegate',
      toolInput: { task: 'edit the plan' },
      toolResult: undefined,
      childSteps: [child],
    });

    renderOpen([delegate], new Map([['tc-child', editChange], ['tc-edit', editChange]]));

    expect(screen.getByText('Edit plan.md')).toBeInTheDocument();
    expect(fileButton('plan.md')).toBeNull();
    expect(screen.queryByText('+3')).toBeNull();
  });
});

describe('convertExecutionStep label (persisted snapshots keep their label)', () => {
  const base = { id: 's', executionId: 'e', type: 'command' as const, status: 'completed' as const, source: 'agent' as const, detailBlocks: [] };
  it('keeps the stored label when the snapshot has no toolInput, recomputes when it does', () => {
    expect(convertExecutionStep({ ...base, toolName: 'run_command', toolInput: {}, label: '执行 sleep 180' } as never, 'zh-CN').label).toBe('执行 sleep 180');
    expect(convertExecutionStep({ ...base, toolName: 'run_command', toolInput: { command: 'ls -la' }, label: 'stale' } as never, 'zh-CN').label).not.toBe('stale');
  });
});

describe('TaskBlock — whole tool results', () => {
  const t = getI18n();
  afterEach(() => cleanup());

  function commandStep(overrides: Partial<ExecutionStep> = {}): ExecutionStep {
    return {
      id: 'step-1', executionId: '', toolCallId: 'call-1', type: 'command', label: 'Ran a command', status: 'completed',
      toolName: 'run_command', toolInput: {}, source: 'agent',
      detailBlocks: [{
        id: 'step-1-result', stepId: 'step-1', type: 'result', label: 'Result', labelKey: 'result',
        content: 'line 1', isTruncated: true, fullContentLength: 500, isExpanded: true,
      }],
      ...overrides,
    };
  }
  const sixty = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
  const showAll = () => screen.queryByRole('button', { name: format(t.chat.toolResultShowAllLines, { count: 60 }) });

  it('hands each step the whole result stored under its tool call id', () => {
    render(<TaskBlock executionSteps={[commandStep()]} isActive={false} toolResults={new Map([['call-1', sixty]])} />);
    fireEvent.click(screen.getAllByRole('button')[0]);

    fireEvent.click(showAll()!);
    expect(screen.getByText(/line 30/)).toBeInTheDocument();
  });

  it('switches from the partial block to the whole result once it arrives', () => {
    const { rerender } = render(<TaskBlock executionSteps={[commandStep()]} isActive toolResults={new Map()} />);
    expect(screen.getByText(t.chat.toolResultFullUnavailable)).toBeInTheDocument();

    rerender(<TaskBlock executionSteps={[commandStep()]} isActive toolResults={new Map([['call-1', sixty]])} />);
    expect(showAll()).not.toBeNull();
    expect(screen.queryByText(t.chat.toolResultFullUnavailable)).toBeNull();
  });

  it('keeps the nested steps of an expert as they were', () => {
    const child = commandStep({ id: 'child', toolCallId: 'call-child' });
    const delegate = commandStep({
      id: 'd', toolCallId: 'call-d', type: 'delegate', toolName: 'delegate_to_agent', detailBlocks: [], childSteps: [child],
    });
    render(<TaskBlock executionSteps={[delegate]} isActive toolResults={new Map([['call-child', sixty]])} />);

    expect(screen.getByText('line 1')).toBeInTheDocument();
    expect(showAll()).toBeNull();
    expect(screen.queryByText(t.chat.toolResultFullUnavailable)).toBeNull();
  });
});
