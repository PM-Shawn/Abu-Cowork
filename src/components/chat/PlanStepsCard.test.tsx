/// <reference types="@testing-library/jest-dom" />
/**
 * Tests for the inline plan card shown for report_plan tool calls.
 *
 * Regression: report_plan calls were fully hidden from the chat flow
 * (hidden:true + ToolCallsGroup filter), so a turn that only reported a
 * plan rendered as a blank assistant bubble — users read it as a bug and
 * aborted/re-sent, compounding into empty aborted turns.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlanStepsCard from './PlanStepsCard';
import { findLatestPlanCall } from '@/utils/workflowExtractor';
import type { Message, ToolCall } from '@/types';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      planCard: {
        title: '执行计划',
        awaiting: '等待你确认',
        stepsUnit: '步',
      },
    },
  }),
}));

function makePlanCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-plan',
    name: 'report_plan',
    input: { steps: ['扫描桌面文件', '识别发票', '移动发票到文件夹'] },
    result: '已记录执行计划：3个步骤',
    ...overrides,
  };
}

function makeMsg(id: string, toolCalls: ToolCall[]): Message {
  return { id, role: 'assistant', content: '', timestamp: 0, toolCalls };
}

afterEach(() => cleanup());

describe('PlanStepsCard', () => {
  // 拍板: 计划的完整状态住在右侧进度面板；对话内只留一行可展开摘要
  // (对齐 Claude Code 的 out-of-transcript 范式)。
  it('collapses to a one-line summary by default once resolved', () => {
    render(<PlanStepsCard toolCall={makePlanCall()} />);
    expect(screen.getByText('执行计划')).toBeInTheDocument();
    expect(screen.getByText(/3\s*步/)).toBeInTheDocument();
    expect(screen.queryByText('扫描桌面文件')).not.toBeInTheDocument();
  });

  it('expands to the full step list on click', async () => {
    const user = userEvent.setup();
    render(<PlanStepsCard toolCall={makePlanCall()} />);
    await user.click(screen.getByText('执行计划'));
    expect(screen.getByText('扫描桌面文件')).toBeInTheDocument();
    expect(screen.getByText('识别发票')).toBeInTheDocument();
    expect(screen.getByText('移动发票到文件夹')).toBeInTheDocument();
  });

  it('shows the awaiting badge while approval is pending (collapsed; dock handles approval UI)', () => {
    render(<PlanStepsCard toolCall={makePlanCall({ result: undefined })} />);
    expect(screen.getByText('等待你确认')).toBeInTheDocument();
    // Collapsed by default — approval lives in the dock above the composer.
    expect(screen.queryByText('扫描桌面文件')).not.toBeInTheDocument();
  });

  it('does not show the awaiting hint once the plan resolved', () => {
    render(<PlanStepsCard toolCall={makePlanCall()} />);
    expect(screen.queryByText('等待你确认')).not.toBeInTheDocument();
  });

  it('renders nothing for a plan call without steps', () => {
    const { container } = render(
      <PlanStepsCard toolCall={makePlanCall({ input: { steps: [] } })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('defaults to collapsed even while awaiting approval (approval lives in the dock)', () => {
    const toolCall = { id: 'p1', name: 'report_plan', input: { steps: ['step one', 'step two'] } } as ToolCall;
    // result undefined = awaiting
    render(<PlanStepsCard toolCall={toolCall} />);
    // Collapsed: step text not visible until expanded
    expect(screen.queryByText('step one')).toBeNull();
    // Header (title + count) still shown
    expect(screen.getByText('执行计划')).toBeInTheDocument();
  });
});

describe('findLatestPlanCall', () => {
  it('returns the last report_plan call across messages', () => {
    const msgs = [
      makeMsg('m1', [makePlanCall({ id: 'p1' })]),
      makeMsg('m2', [{ id: 'x', name: 'run_command', input: {} }]),
      makeMsg('m3', [makePlanCall({ id: 'p2' })]),
    ];
    expect(findLatestPlanCall(msgs)?.id).toBe('p2');
  });

  it('returns undefined when no report_plan call exists', () => {
    const msgs = [makeMsg('m1', [{ id: 'x', name: 'run_command', input: {} }])];
    expect(findLatestPlanCall(msgs)).toBeUndefined();
  });

  it('skips plan calls without renderable steps (review regression)', () => {
    // MessageGroup gates hasAnyContent on findLatestPlanCall while the card
    // gates on non-empty steps — a steps:[] call must not count as content,
    // or the streaming dots get suppressed with nothing rendered in their place.
    const empty = makePlanCall({ id: 'p-empty', input: { steps: ['  ', ''] } });
    expect(findLatestPlanCall([makeMsg('m1', [empty])])).toBeUndefined();
    // ...and an earlier call WITH steps still wins over a degenerate later one.
    const good = makePlanCall({ id: 'p-good' });
    expect(findLatestPlanCall([makeMsg('m1', [good]), makeMsg('m2', [empty])])?.id).toBe('p-good');
  });
});
