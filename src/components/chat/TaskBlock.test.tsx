// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import TaskBlock, { convertExecutionStep, generateSummary, type UnifiedStep } from './TaskBlock';
import { ThinkingStatusLine } from './ThinkingStatusLine';
import RowMountProvider from './RowMountProvider';
import { getI18n, getLocale, format, initLanguage } from '@/i18n';
import { snapshotExecutionSteps, snapshotToExecutionSteps } from '@/core/agent/executionSnapshot';
import { DesignSystemProvider } from '@/components/ds/provider';
import { usePreviewStore } from '@/stores/previewStore';
import { getToolLabel } from '@/utils/toolLabels';
import type { DetailBlock, ExecutionStep } from '@/types/execution';
import type { WorkflowStep } from '@/utils/workflowExtractor';
import type { FileChange } from '@/types/fileChange';
import type { ToolViewRecord } from './toolViews/toolViewRecords';

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
  it('names the phase alone when no duration was saved (settled block)', () => {
    expect(generateSummary([thinkingStep(undefined)], t, locale, false)).toBe(t.task.thinkingDone);
  });
  it('says "思考中" while live — continuing the placeholder dots row it replaces', () => {
    expect(generateSummary([{ ...thinkingStep(undefined), status: 'running' }], t, locale, true)).toBe(t.chat.thinking);
  });
  it('uses the stopped terminal instead of completed action summaries', () => {
    expect(generateSummary([thinkingStep(5)], t, locale, false, true)).toBe(t.task.stopped);
  });
});

function workStep(id: string, type: UnifiedStep['type'], status: UnifiedStep['status'], toolName: string): UnifiedStep {
  return { id, type, label: `${toolName} ${id}`, status, toolName } as UnifiedStep;
}

// The header names the kind of work and the rows name the specifics, so a
// header never repeats a row's own label.
describe('generateSummary — live block names what is happening now', () => {
  const t = getI18n();
  const locale = getLocale();

  it('names the kind of work of the latest running step', () => {
    expect(generateSummary([
      workStep('s1', 'file-read', 'completed', 'read_file'),
      workStep('s2', 'command', 'running', 'run_command'),
    ], t, locale, true)).toBe(t.task.nowRunningCommand);
    expect(generateSummary([
      workStep('s1', 'command', 'running', 'run_command'),
      workStep('s2', 'file-read', 'running', 'read_file'),
    ], t, locale, true)).toBe(t.task.nowReadingFile);
    expect(generateSummary([workStep('s1', 'file-write', 'running', 'edit_file')], t, locale, true)).toBe(t.task.nowModifyingFile);
    expect(generateSummary([workStep('s1', 'file-create', 'running', 'write_file')], t, locale, true)).toBe(t.task.nowCreatingFile);
    expect(generateSummary([workStep('s1', 'search', 'running', 'search_files')], t, locale, true)).toBe(t.task.nowSearching);
    expect(generateSummary([workStep('s1', 'delegate', 'running', 'delegate_to_agent')], t, locale, true)).toBe(t.task.nowDelegating);
    expect(generateSummary([workStep('s1', 'mcp', 'running', 'server__tool')], t, locale, true)).toBe(t.task.nowCallingTool);
    expect(generateSummary([workStep('s1', 'tool', 'running', 'present_files')], t, locale, true)).toBe(t.task.nowPresentingFiles);
    expect(generateSummary([workStep('s1', 'tool', 'running', 'ask_user_question')], t, locale, true)).toBe(t.userQuestion.waitingForAnswer);
  });

  it('names the wait for an answer even without the live signal, over the finished counts', () => {
    const steps = [
      workStep('s1', 'file-read', 'completed', 'read_file'),
      workStep('s2', 'file-read', 'completed', 'read_file'),
      workStep('s3', 'tool', 'running', 'ask_user_question'),
    ];
    expect(generateSummary(steps, t, locale, false)).toBe(t.userQuestion.waitingForAnswer);
  });

  it('names a running skill by its kind, apart from the row that names the skill', () => {
    const steps = [workStep('s1', 'skill', 'running', 'use_skill')];
    expect(generateSummary(steps, t, locale, true)).toBe(t.task.nowUsingSkill);
    expect(generateSummary(steps, t, locale, true)).not.toBe(steps[0].label);
  });

  it('says "思考中" between steps, when nothing is running', () => {
    expect(generateSummary([workStep('s1', 'file-read', 'completed', 'read_file')], t, locale, true)).toBe(t.chat.thinking);
    expect(generateSummary([workStep('s1', 'file-read', 'pending', 'read_file')], t, locale, true)).toBe(t.chat.thinking);
  });
});

describe('generateSummary — settled block counts a skill as one kind of work', () => {
  const t = getI18n();
  const locale = getLocale();
  const separator = locale.startsWith('zh') ? '，' : ', ';

  it('lists the skill with the other kinds of work, each counted', () => {
    const summary = generateSummary([
      workStep('s1', 'skill', 'completed', 'use_skill'),
      workStep('s2', 'file-read', 'completed', 'read_file'),
      workStep('s3', 'file-read', 'completed', 'read_file'),
      workStep('s4', 'command', 'completed', 'run_command'),
    ], t, locale, false);
    expect(summary).toBe([t.task.usedSkill, format(t.task.readFiles, { count: 2 }), t.task.executedCommand].join(separator));
  });

  it('counts two skills and never repeats a skill row\'s label', () => {
    const steps = [workStep('s1', 'skill', 'completed', 'use_skill'), workStep('s2', 'skill', 'completed', 'use_skill')];
    const summary = generateSummary(steps, t, locale, false);
    expect(summary).toBe(format(t.task.usedSkills, { count: 2 }));
    expect(summary).not.toContain(steps[0].label);
  });

  it('keeps the thinking duration out of a block that also did work', () => {
    expect(generateSummary([thinkingStep(5), workStep('s1', 'file-read', 'completed', 'read_file')], t, locale, false)).toBe(t.task.readFile);
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

  it('live block that mounts together with its list row shows its final state without expand wrappers', () => {
    const { container } = render(
      <RowMountProvider>
        <TaskBlock executionSteps={[execThinkingStep()]} isActive />
      </RowMountProvider>,
    );
    expect(container.querySelector('.flow-timeline')).not.toBeNull();
    expect(container.querySelector('.block-expand-enter')).toBeNull();
  });

  it('live block that appears inside a mounted list row mounts inside expand wrappers', () => {
    const { container, rerender } = render(<RowMountProvider>{null}</RowMountProvider>);
    rerender(
      <RowMountProvider>
        <TaskBlock executionSteps={[execThinkingStep()]} isActive />
      </RowMountProvider>,
    );
    expect(container.querySelectorAll('.block-expand-enter')).toHaveLength(2);
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
// replacement — a two-structure swap would land a ~24px height change
// (toggle button + gap) in one frame.
describe('TaskBlock — thinking pane running → completed', () => {
  afterEach(() => cleanup());

  const t = getI18n();
  // The row's label is the toggle once thinking is done.
  const findThinkingToggle = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes(t.chat.thinkingProcess),
    );
  const stepRows = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('.flow-timeline > .flex.items-start'));

  it('keeps the streamed content mounted and turns the row label into the toggle', () => {
    const { container, rerender } = render(
      <TaskBlock executionSteps={[execThinkingStep()]} isActive />,
    );
    // Running: the header says 思考中, the row is named 思考过程 as plain text,
    // the pane content is present, and no running row follows the steps.
    const header = () => container.querySelector('.task-block > button')!;
    expect(header().textContent).toContain(t.chat.thinking.replace(/[…]$/, ''));
    expect(container.textContent).toContain(t.chat.thinkingProcess);
    expect(findThinkingToggle(container)).toBeUndefined();
    expect(container.textContent).toContain('reasoning tokens streaming in');
    expect(stepRows(container)).toHaveLength(1);

    rerender(
      <TaskBlock
        executionSteps={[execThinkingStep({ status: 'completed', duration: 3 })]}
        isActive={false}
      />,
    );
    // Completed: the header carries the duration, the content pre is still
    // mounted inside an OPEN panel (thinkingExpanded persists across the
    // transition), and the row label is now the toggle.
    expect(header().textContent).toBe(format(t.task.thoughtFor, { seconds: 3 }));
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toContain('reasoning tokens streaming in');
    expect(pre!.closest('.block-expand')!.classList.contains('block-expand-open')).toBe(true);
    const toggle = findThinkingToggle(container);
    expect(toggle).toBeDefined();
    expect(toggle!.getAttribute('aria-expanded')).toBe('true');
    expect(header().textContent).not.toContain(t.chat.thinkingProcess);
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

  it('collapse via the row label rolls the panel up (closed + inert), not unmounted', () => {
    const { container } = render(
      <TaskBlock
        executionSteps={[execThinkingStep({ status: 'completed', duration: 3 })]}
        isActive={false}
      />,
    );
    // Fresh settled mount: the timeline only mounts when the user opens the
    // summary header, so expand it first.
    fireEvent.click(container.querySelector('button')!);
    // The row label is the toggle; the panel starts collapsed.
    const toggle = findThinkingToggle(container);
    expect(toggle).toBeDefined();
    expect(toggle!.getAttribute('aria-expanded')).toBe('false');
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
    // No running row follows the steps: the header already says what runs.
    expect(document.querySelectorAll('.flow-timeline svg.lucide-loader-circle')).toHaveLength(2);
    expect(document.querySelectorAll('.flow-timeline > .flex.items-start')).toHaveLength(2);
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

describe('TaskBlock — the command of a background-command step', () => {
  afterEach(cleanup);

  const outputStep: ExecutionStep = {
    id: 'step-output',
    executionId: 'exec-1',
    toolCallId: 'tc-output',
    type: 'tool',
    label: 'Read background command output bg-0a1b2c3d',
    status: 'completed',
    toolName: 'background_command_output',
    toolInput: { id: 'bg-0a1b2c3d' },
    toolResult: 'status: running',
    source: 'agent',
    detailBlocks: [],
  };
  const commands = new Map([['tc-output', { command: 'npm run dev' }]]);

  function renderOpen(steps: ExecutionStep[]) {
    render(<TaskBlock executionSteps={steps} isActive={false} backgroundCommands={commands} />);
    fireEvent.click(screen.getAllByRole('button')[0]);
  }

  it('names the command the step recorded', () => {
    renderOpen([outputStep]);

    expect(screen.getByText('Read background command output npm run dev')).toBeInTheDocument();
  });

  it('names the command for a step restored from a saved snapshot', () => {
    const restored = snapshotToExecutionSteps(snapshotExecutionSteps([outputStep]));
    expect(restored[0].toolInput).toEqual({});

    renderOpen(restored);

    expect(screen.getByText('Read background command output npm run dev')).toBeInTheDocument();
  });

  it('names the command for a legacy step by its tool call id', () => {
    render(
      <TaskBlock
        steps={[{
          id: 'tc-output',
          type: 'tool',
          label: '查看后台命令的输出 bg-0a1b2c3d',
          status: 'completed',
          timestamp: 1,
          toolName: 'background_command_output',
          toolInput: { id: 'bg-0a1b2c3d' },
        }]}
        isActive={false}
        backgroundCommands={commands}
      />,
    );
    fireEvent.click(screen.getAllByRole('button')[0]);

    expect(screen.getByText('Read background command output npm run dev')).toBeInTheDocument();
  });
});

describe('convertExecutionStep label (persisted snapshots keep their label)', () => {
  const base = { id: 's', executionId: 'e', type: 'command' as const, status: 'completed' as const, source: 'agent' as const, detailBlocks: [] };
  it('keeps the stored label when the snapshot has no toolInput, recomputes when it does', () => {
    expect(convertExecutionStep({ ...base, type: 'tool', toolName: 'present_files', toolInput: {}, label: '交付了 2 个文件' } as never, 'zh-CN').label).toBe('交付了 2 个文件');
    expect(convertExecutionStep({ ...base, toolName: 'run_command', toolInput: { command: 'ls -la', purpose: '看看文件夹' }, label: 'stale' } as never, 'zh-CN').label).toBe('看看文件夹');
  });

  it('rebuilds a command or connector title that an old snapshot saved with the command or the tool id', () => {
    expect(convertExecutionStep({ ...base, toolName: 'run_command', toolInput: {}, label: '执行 python3 - <<' } as never, 'zh-CN').label).toBe('处理文件');
    expect(convertExecutionStep({ ...base, toolName: 'run_command', toolInput: { purpose: '合并三张表', background: true }, label: 'x' } as never, 'zh-CN').label).toBe('合并三张表（在后台）');
    expect(convertExecutionStep({ ...base, toolName: 'gh__list', toolInput: {}, label: '[gh] list' } as never, 'en-US').label).toBe('Use gh');
    expect(convertExecutionStep({ ...base, type: 'tool', toolName: 'manage_goal', toolInput: {}, label: '调用 manage_goal' } as never, 'zh-CN').label).toBe('更新目标');
  });
});

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

describe('TaskBlock — whole tool results', () => {
  const t = getI18n();
  afterEach(() => cleanup());

  // A tool without a view of its own shows its result block in the step.
  const infoStep = (overrides: Partial<ExecutionStep> = {}) => commandStep({ type: 'tool', toolName: 'get_system_info', ...overrides });
  const sixty = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
  const showAll = () => screen.queryByRole('button', { name: format(t.chat.toolResultShowAllLines, { count: 60 }) });

  it('hands each step the whole result stored under its tool call id', () => {
    render(<TaskBlock executionSteps={[infoStep()]} isActive={false} toolResults={new Map([['call-1', sixty]])} />);
    fireEvent.click(screen.getAllByRole('button')[0]);

    fireEvent.click(showAll()!);
    expect(screen.getByText(/line 30/)).toBeInTheDocument();
  });

  it('switches from the partial block to the whole result once it arrives', () => {
    const { rerender } = render(<TaskBlock executionSteps={[infoStep()]} isActive toolResults={new Map()} />);
    expect(screen.getByText(t.chat.toolResultFullUnavailable)).toBeInTheDocument();

    rerender(<TaskBlock executionSteps={[infoStep()]} isActive toolResults={new Map([['call-1', sixty]])} />);
    expect(showAll()).not.toBeNull();
    expect(screen.queryByText(t.chat.toolResultFullUnavailable)).toBeNull();
  });

  it('keeps the nested steps of an expert as they were', () => {
    const child = infoStep({ id: 'child', toolCallId: 'call-child' });
    const delegate = commandStep({
      id: 'd', toolCallId: 'call-d', type: 'delegate', toolName: 'delegate_to_agent', detailBlocks: [], childSteps: [child],
    });
    render(<TaskBlock executionSteps={[delegate]} isActive toolResults={new Map([['call-child', sixty]])} />);

    expect(screen.getByText('line 1')).toBeInTheDocument();
    expect(showAll()).toBeNull();
    expect(screen.queryByText(t.chat.toolResultFullUnavailable)).toBeNull();
  });
});

describe('TaskBlock — tool views', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });
  afterEach(() => cleanup());

  const VIEW_STEPS: Array<[string, Record<string, unknown>]> = [
    ['run_command', { command: 'npm test' }],
    ['read_file', { path: '/w/notes.md' }],
    ['search_files', { pattern: 'TODO', path: '/w' }],
    ['find_files', { pattern: '*.ts', path: '/w' }],
    ['list_directory', { path: '/w' }],
    ['http_fetch', { url: 'https://example.com/docs/api' }],
    ['web_search', { query: 'vitest' }],
  ];
  const labelOf = (toolName: string, input: Record<string, unknown>) => getToolLabel(toolName, input, 'zh-CN').label;
  const npmTest = { command: 'npm test' };
  const pageUrl = 'https://example.com/docs/api';

  function renderOpen(
    steps: ExecutionStep[],
    props: { toolViewRecords?: Map<string, ToolViewRecord>; toolResults?: Map<string, string> } = {},
  ) {
    const view = render(<TaskBlock executionSteps={steps} isActive={false} {...props} />, { wrapper: DesignSystemProvider });
    fireEvent.click(screen.getAllByRole('button')[0]);
    return view;
  }
  const commandRecord = (commandOutcome: ToolViewRecord['commandOutcome']) =>
    new Map<string, ToolViewRecord>([['call-1', { input: npmTest, commandOutcome }]]);
  const fetchStep = () => commandStep({ type: 'tool', toolName: 'http_fetch', toolInput: { url: pageUrl }, toolResult: 'HTTP 404' });
  const fetchRecord = (status: number) => new Map<string, ToolViewRecord>([
    ['call-1', { input: { url: pageUrl }, httpFetchOutcome: { status, statusText: 'x', body: [0, 0], truncated: false } }],
  ]);

  it.each(VIEW_STEPS)('makes the title of a %s step an expandable button', (toolName, input) => {
    const { container } = renderOpen([commandStep({ toolName, toolInput: input })]);
    const title = screen.getByRole('button', { name: labelOf(toolName, input) });
    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('[data-step-view]')).toBeNull();

    fireEvent.click(title);
    expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('[data-step-view]')).not.toBeNull();

    fireEvent.click(title);
    expect(container.querySelector('[data-step-view]')).toBeNull();
  });

  it('folds every open view when the timeline closes', () => {
    const { container } = renderOpen([commandStep({ toolInput: npmTest })]);
    fireEvent.click(screen.getByRole('button', { name: labelOf('run_command', npmTest) }));
    expect(container.querySelector('[data-step-view]')).not.toBeNull();

    const header = container.querySelector('.task-block > button')!;
    fireEvent.click(header);
    expect(container.querySelector('[data-step-view]')).toBeNull();

    fireEvent.click(header);
    expect(container.querySelector('[data-step-view]')).toBeNull();
  });

  it('drops the script and result chips for these steps and keeps them for other tools', () => {
    renderOpen([commandStep({ toolInput: { command: 'ls' }, toolResult: 'ok', detailBlocks: [] })]);
    expect(screen.queryByRole('button', { name: '脚本' })).toBeNull();
    expect(screen.queryByRole('button', { name: '结果' })).toBeNull();
    cleanup();

    renderOpen([commandStep({ type: 'tool', toolName: 'get_system_info', toolResult: 'ok', detailBlocks: [] })]);
    expect(screen.getByRole('button', { name: '结果' })).toBeInTheDocument();
  });

  it('shows the exit code only when it is not zero', () => {
    const step = commandStep({ toolInput: npmTest, toolResult: 'FAIL' });
    const failed = renderOpen([step], { toolViewRecords: commandRecord({ exitCode: 1 }) });
    expect(failed.container.querySelector('[data-exit-code="1"]')).toHaveTextContent('退出码 1');
    cleanup();

    const passed = renderOpen([step], { toolViewRecords: commandRecord({ exitCode: 0 }) });
    expect(passed.container.querySelector('[data-exit-code]')).toBeNull();
    cleanup();

    const unrecorded = renderOpen([step]);
    expect(unrecorded.container.querySelector('[data-exit-code]')).toBeNull();
  });

  it('shows the exit code -1 of a killed or timed out command', () => {
    const step = commandStep({ toolInput: { command: 'sleep 60' }, toolResult: 'exit code: -1' });
    const { container } = renderOpen([step], { toolViewRecords: commandRecord({ exitCode: -1 }) });
    expect(container.querySelector('[data-exit-code="-1"]')).toHaveTextContent('退出码 -1');
  });

  it('shows no exit code for a background start', () => {
    const { container } = renderOpen(
      [commandStep({ toolInput: { command: 'npm run dev', background: true }, toolResult: 'started' })],
      { toolViewRecords: commandRecord({ exitCode: 0, background: true }) },
    );
    expect(container.querySelector('[data-exit-code]')).toBeNull();
  });

  it('shows the http status only outside 2xx', () => {
    const missing = renderOpen([fetchStep()], { toolViewRecords: fetchRecord(404) });
    expect(missing.container.querySelector('[data-http-status="404"]')).toHaveTextContent('404');
    cleanup();

    const found = renderOpen([fetchStep()], { toolViewRecords: fetchRecord(200) });
    expect(found.container.querySelector('[data-http-status]')).toBeNull();
  });

  it('names a page fetch by its address and links it beside the title button', () => {
    const { container } = renderOpen([fetchStep()]);
    const title = screen.getByRole('button', { name: '读取网页 example.com/docs/api' });
    const link = container.querySelector(`a[href="${pageUrl}"]`);
    expect(link).not.toBeNull();
    expect(title.contains(link)).toBe(false);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('says stopped on a cancelled step', () => {
    // UnifiedStep carries the cancelled status; ExecutionStep's type does not name it.
    renderOpen([commandStep({ toolInput: npmTest, status: 'cancelled' as never })]);
    expect(screen.getByRole('status', { name: '已停止' })).toHaveTextContent('已停止');
    expect(screen.queryByText('[已取消]')).toBeNull();
  });

  describe('in a stopped turn', () => {
    const scriptBlock: DetailBlock = {
      id: 'step-1-script', stepId: 'step-1', type: 'script', label: 'Script', labelKey: 'script',
      content: 'sleep 30', isTruncated: false, isExpanded: true,
    };
    function renderStopped(steps: ExecutionStep[]) {
      const view = render(<TaskBlock executionSteps={steps} isActive={false} isStopped />, { wrapper: DesignSystemProvider });
      fireEvent.click(screen.getAllByRole('button')[0]);
      return view;
    }
    const sleep = { command: 'sleep 30' };

    it.each([
      ['running', [scriptBlock]],
      ['pending', []],
      ['error', [scriptBlock]],
    ] as const)('says stopped on a %s step that holds no result and no error, and shows only its command', (status, blocks) => {
      const { container } = renderStopped([commandStep({ status, toolInput: sleep, detailBlocks: [...blocks] })]);
      expect(screen.getByRole('status', { name: '已停止' })).toHaveTextContent('已停止');
      expect(screen.queryByText('执行出错')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: labelOf('run_command', sleep) }));
      const view = container.querySelector<HTMLElement>('[data-step-view="command"]')!;
      expect(view).toHaveTextContent('sleep 30');
      expect(view.querySelector('[data-tool-result]')).toBeNull();
      expect(within(view).queryByText('运行中…')).toBeNull();
    });

    it.each(['AbortError: Aborted', 'Error: AbortError: Aborted'])('says stopped on a step whose only error is the abort of Stop (%s)', (content) => {
      const { container } = renderStopped([commandStep({
        status: 'error', toolInput: sleep,
        detailBlocks: [scriptBlock, { ...scriptBlock, id: 'step-1-error', type: 'error', label: 'Error', labelKey: 'error', content }],
      })]);
      expect(screen.getByRole('status', { name: '已停止' })).toBeInTheDocument();
      expect(screen.queryByText('执行出错')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: labelOf('run_command', sleep) }));
      const view = container.querySelector<HTMLElement>('[data-step-view="command"]')!;
      expect(view).toHaveTextContent('sleep 30');
      expect(view).not.toHaveTextContent('AbortError');
    });

    it('says stopped on a saved step whose call holds the abort of Stop', () => {
      const legacy: WorkflowStep = {
        id: 'call-1', type: 'command', label: labelOf('run_command', sleep), status: 'error', timestamp: 0,
        toolName: 'run_command', toolInput: sleep, toolResult: 'Error: AbortError: Aborted',
      };
      render(<TaskBlock steps={[legacy]} isActive={false} isStopped />, { wrapper: DesignSystemProvider });
      fireEvent.click(screen.getAllByRole('button')[0]);
      expect(screen.getByRole('status', { name: '已停止' })).toBeInTheDocument();
    });

    it('keeps a step that failed with an error as failed', () => {
      renderStopped([commandStep({
        status: 'error', toolInput: sleep,
        detailBlocks: [{ ...scriptBlock, id: 'step-1-error', type: 'error', label: 'Error', labelKey: 'error', content: 'boom' }],
      })]);
      expect(screen.queryByRole('status', { name: '已停止' })).toBeNull();
      expect(screen.getByText('执行出错')).toBeInTheDocument();
    });

    it('keeps a finished step as finished', () => {
      renderStopped([commandStep({ toolInput: sleep })]);
      expect(screen.queryByRole('status', { name: '已停止' })).toBeNull();
    });

    it.each(['[已取消]', '[Cancelled]'])('says stopped on a saved step whose call Stop marked %s', (result) => {
      const legacy: WorkflowStep = {
        id: 'call-1', type: 'command', label: labelOf('run_command', sleep), status: 'completed', timestamp: 0,
        toolName: 'run_command', toolInput: sleep, toolResult: result,
      };
      const { container } = render(<TaskBlock steps={[legacy]} isActive={false} isStopped />, { wrapper: DesignSystemProvider });
      fireEvent.click(screen.getAllByRole('button')[0]);
      expect(screen.getByRole('status', { name: '已停止' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: labelOf('run_command', sleep) }));
      const view = container.querySelector<HTMLElement>('[data-step-view="command"]')!;
      expect(view).toHaveTextContent('sleep 30');
      expect(view.querySelector('[data-tool-result]')).toBeNull();
    });

    it('keeps a saved step that a hook blocked as it was', () => {
      const legacy: WorkflowStep = {
        id: 'call-1', type: 'command', label: labelOf('run_command', sleep), status: 'completed', timestamp: 0,
        toolName: 'run_command', toolInput: sleep, toolResult: '[被 hook 拦截]',
      };
      render(<TaskBlock steps={[legacy]} isActive={false} isStopped />, { wrapper: DesignSystemProvider });
      fireEvent.click(screen.getAllByRole('button')[0]);
      expect(screen.queryByRole('status', { name: '已停止' })).toBeNull();
    });

    it('leaves a running step running while the turn is not stopped', () => {
      renderOpen([commandStep({ status: 'running', toolInput: sleep, detailBlocks: [scriptBlock] })]);
      expect(screen.queryByRole('status', { name: '已停止' })).toBeNull();
    });
  });

  it('keeps an image read as it is', () => {
    const input = { path: '/w/shot.png' };
    const { container } = renderOpen([commandStep({
      type: 'file-read', toolName: 'read_file', toolInput: input,
      detailBlocks: [{
        id: 'step-1-image', stepId: 'step-1', type: 'image', label: 'Image', content: '',
        isTruncated: false, isExpanded: true, imageData: { mediaType: 'image/png', base64: 'iVBORw0KGgo=' },
      }],
    })]);
    const label = labelOf('read_file', input);
    expect(screen.queryByRole('button', { name: label })).toBeNull();
    expect(screen.getByText(label)).not.toHaveAttribute('aria-expanded');
    expect(container.querySelector('img')).not.toBeNull();
  });

  it("gives an expert's nested step the view without a record", () => {
    const child = commandStep({
      id: 'child', toolCallId: 'call-child', toolInput: npmTest,
      detailBlocks: [{
        id: 'child-result', stepId: 'child', type: 'result', label: 'Result', labelKey: 'result',
        content: 'hello\nworld', isTruncated: false, isExpanded: true,
      }],
    });
    const delegate = commandStep({
      id: 'd', toolCallId: 'call-d', type: 'delegate', toolName: 'delegate_to_agent', toolInput: { task: 'run the tests' },
      detailBlocks: [], childSteps: [child],
    });
    const { container } = renderOpen([delegate], {
      toolViewRecords: new Map([['call-child', { input: npmTest, commandOutcome: { exitCode: 2 } }]]),
    });

    fireEvent.click(screen.getByRole('button', { name: labelOf('run_command', npmTest) }));
    const view = container.querySelector<HTMLElement>('[data-step-view="command"]')!;
    expect(within(view).getByText('输出')).toBeInTheDocument();
    expect(view).toHaveTextContent('hello');
    expect(view).toHaveTextContent('world');
    expect(container.querySelector('[data-exit-code]')).toBeNull();
    expect(container.querySelector('[data-line-numbers]')).toBeNull();
  });

  it('says the command ended under a non-zero exit', () => {
    renderOpen([commandStep({ toolInput: npmTest, toolResult: 'FAIL' })], { toolViewRecords: commandRecord({ exitCode: 1 }) });
    expect(screen.getByText('这一步已结束，结果请看详情')).toBeInTheDocument();
  });

  it.each([
    ['read_file', 'file-read', { path: '/w/missing.md' }, 'Error reading file: ENOENT: no such file'],
    ['http_fetch', 'tool', { url: pageUrl }, 'Error making HTTP request: fetch failed'],
  ])('shows the failure text of a %s step that holds an error block, with the title colour of its status', (toolName, type, input, failure) => {
    const step = commandStep({
      type: type as ExecutionStep['type'], toolName, toolInput: input, status: 'completed',
      detailBlocks: [{
        id: 'step-1-error', stepId: 'step-1', type: 'error', label: 'Error', labelKey: 'error',
        content: failure, isTruncated: false, isExpanded: true,
      }],
    });
    const { container } = renderOpen([step], { toolResults: new Map([['call-1', failure]]) });
    const title = screen.getByRole('button', { name: labelOf(toolName, input) });
    fireEvent.click(title);
    const failureText = container.querySelector<HTMLElement>('[data-step-view] [data-tool-result]')!;
    expect(failureText).toHaveTextContent(failure);
    expect(failureText).toHaveClass('text-danger');
    const titleLine = title.closest('.pb-3')!.firstElementChild!;
    expect(titleLine).not.toHaveClass('text-danger');
    expect(titleLine).toHaveClass('text-label-tertiary');
  });

  it('shows the failure text of an error block saved in a snapshot, without the whole results', () => {
    const failure = 'Error reading file: ENOENT: no such file';
    const input = { path: '/w/missing.md' };
    const step = commandStep({
      type: 'file-read', toolName: 'read_file', toolInput: input, toolResult: undefined, label: labelOf('read_file', input),
      detailBlocks: [{
        id: 'step-1-error', stepId: 'step-1', type: 'error', label: 'Error', labelKey: 'error',
        content: failure, isTruncated: false, isExpanded: true,
      }],
    });
    const { container } = renderOpen(snapshotToExecutionSteps(snapshotExecutionSteps([step])), {
      toolViewRecords: new Map([['call-1', { input }]]),
    });
    fireEvent.click(screen.getByRole('button', { name: labelOf('read_file', input) }));
    const failureText = container.querySelector<HTMLElement>('[data-step-view] [data-tool-result]')!;
    expect(failureText).toHaveTextContent(failure);
    expect(failureText).toHaveClass('text-danger');
  });

  describe('a successful read of a file whose text starts with Error', () => {
    const text = 'Error: line 1\nline 2';
    const input = { path: '/w/error.log' };
    const readStep = () => commandStep({
      type: 'file-read', toolName: 'read_file', toolInput: input, status: 'completed', toolResult: text,
      detailBlocks: [{
        id: 'step-1-error', stepId: 'step-1', type: 'error', label: 'Error', labelKey: 'error',
        content: text, isTruncated: false, isExpanded: true,
      }],
    });

    it('opens the numbered view when the call has a read record', () => {
      const { container } = renderOpen([readStep()], {
        toolResults: new Map([['call-1', text]]),
        toolViewRecords: new Map([['call-1', {
          input, fileReadOutcome: { kind: 'text', startLine: 1, lineCount: 2, totalLines: 2, bodyStart: 0 },
        }]]),
      });
      fireEvent.click(screen.getByRole('button', { name: labelOf('read_file', input) }));
      const view = container.querySelector<HTMLElement>('[data-step-view]')!;
      expect(view.querySelector('[data-line-numbers]')).toHaveTextContent('1 2');
      expect(view).toHaveTextContent('Error: line 1');
      expect(view.querySelector('.text-danger')).toBeNull();
    });

    it('opens the failure view when the call has no record', () => {
      const { container } = renderOpen([readStep()], {
        toolResults: new Map([['call-1', text]]),
        toolViewRecords: new Map([['call-1', { input }]]),
      });
      fireEvent.click(screen.getByRole('button', { name: labelOf('read_file', input) }));
      const view = container.querySelector<HTMLElement>('[data-step-view]')!;
      expect(view.querySelector('[data-line-numbers]')).toBeNull();
      expect(view.querySelector('[data-tool-result]')).toHaveClass('text-danger');
    });
  });

  it('lists every result of a web search whose list block kept only the start of the result', () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `Result ${i + 1}`, url: `https://example.com/article-${i + 1}`, snippet: `Snippet ${i + 1}`, source: 'example.com',
    }));
    const whole = `<!--SEARCH_JSON:${JSON.stringify(results)}-->\n\nResults`;
    const input = { query: 'vitest' };
    const step = commandStep({
      type: 'tool', toolName: 'web_search', toolInput: input,
      detailBlocks: [{
        id: 'step-1-result', stepId: 'step-1', type: 'list', label: 'Result', labelKey: 'result',
        content: whole.slice(0, 300), isTruncated: true, fullContentLength: whole.length, isExpanded: false,
      }],
    });
    const { container } = renderOpen([step], { toolResults: new Map([['call-1', whole]]) });
    fireEvent.click(screen.getByRole('button', { name: labelOf('web_search', input) }));
    const view = container.querySelector<HTMLElement>('[data-step-view="web-search"]')!;
    expect(view.querySelectorAll('a[target="_blank"]')).toHaveLength(8);
  });

  it('says the whole result is not in the conversation under the view', () => {
    const { container } = renderOpen([commandStep({ toolInput: npmTest })], { toolResults: new Map() });
    fireEvent.click(screen.getByRole('button', { name: labelOf('run_command', npmTest) }));
    const view = container.querySelector<HTMLElement>('[data-step-view]')!;
    expect(within(view).getByText('这段对话里没有这一步的完整结果')).toBeInTheDocument();
  });
});

describe('TaskBlock — the step list', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });
  afterEach(() => {
    cleanup();
    initLanguage('system');
  });

  const steps = (count: number, overrides: Partial<ExecutionStep> = {}) =>
    Array.from({ length: count }, (_, index) => execCommandStep(`s${index + 1}`, `Step ${index + 1}`, overrides));
  const header = (container: HTMLElement) => container.querySelector<HTMLElement>('.task-block > button')!;

  it('lists every step without a show-more button', () => {
    const { container } = render(<TaskBlock executionSteps={steps(10, { status: 'completed' })} isActive={false} />);
    fireEvent.click(header(container));
    for (let index = 1; index <= 10; index++) expect(screen.getByText(`Step ${index}`)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '查看更多' })).toBeNull();
    expect(screen.queryByRole('button', { name: '收起' })).toBeNull();
  });

  it('opens a running turn with every step', () => {
    const { container } = render(<TaskBlock executionSteps={steps(5)} isActive />);
    expect(header(container)).toHaveAttribute('aria-expanded', 'true');
    for (let index = 1; index <= 5; index++) expect(screen.getByText(`Step ${index}`)).toBeInTheDocument();
  });

  it('puts the steps and the end node in one scrolling list', () => {
    const { container } = render(<TaskBlock executionSteps={steps(2, { status: 'completed' })} isActive={false} />);
    fireEvent.click(header(container));
    const list = container.querySelector<HTMLElement>('[data-step-list]')!;
    expect(list).toHaveClass('overflow-y-auto', 'max-h-[min(240px,50vh)]');
    expect(within(list).getByText('Step 1')).toBeInTheDocument();
    expect(within(list).getByText(getI18n().task.done)).toBeInTheDocument();
  });

  it('folds on the header and opens again on the header', () => {
    const failed = [...steps(4, { status: 'completed' }), execCommandStep('s5', 'Step 5', { status: 'error' })];
    const { container } = render(<TaskBlock executionSteps={failed} isActive={false} />);
    const timeline = () => container.querySelector('.block-expand')!;

    fireEvent.click(header(container));
    expect(timeline()).toHaveClass('block-expand-open');
    fireEvent.click(header(container));
    expect(timeline()).toHaveClass('block-expand-closed');
    fireEvent.click(header(container));
    expect(timeline()).toHaveClass('block-expand-open');
    for (let index = 1; index <= 5; index++) expect(screen.getByText(`Step ${index}`)).toBeInTheDocument();
  });
});
