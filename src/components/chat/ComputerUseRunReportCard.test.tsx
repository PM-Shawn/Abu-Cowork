// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ComputerUseRunReportCard from './ComputerUseRunReportCard';
import { initLanguage } from '@/i18n';
import type { ToolCall } from '@/types';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function step(id: string, input: Record<string, unknown>, computerStep: NonNullable<ToolCall['computerStep']>, withImage = false): ToolCall {
  return {
    id,
    name: 'computer',
    input,
    result: 'ok',
    computerStep,
    ...(withImage
      ? { resultContent: [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: PNG } }] }
      : {}),
  };
}

describe('ComputerUseRunReportCard', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });
  afterEach(() => {
    cleanup();
  });

  it('summarises the run and, when it settled, keeps the steps folded', () => {
    render(
      <ComputerUseRunReportCard
        conversationId="conv-1"
        steps={[
          step('t1', { action: 'get_app_state', app: 'Notepad' }, { action: 'get_app_state', targetApp: 'Notepad', consequence: 'none', outcome: 'observed' }),
          step('t2', { action: 'click', element_id: 12 }, { action: 'click', targetApp: 'Notepad', consequence: 'none', outcome: 'verified-change' }),
          step('t3', { action: 'type', text: 'hello world' }, { action: 'type', targetApp: 'Notepad', consequence: 'none', outcome: 'verified-change' }),
        ]}
      />,
    );
    expect(screen.getByText('操作回放 · Notepad')).toBeInTheDocument();
    expect(screen.getByText(/3 步，2 步已验证/)).toBeInTheDocument();
    expect(screen.getByTestId('cu-run-final')).toHaveTextContent('已验证变化');
    // Folded: no step rows until the header is clicked.
    expect(screen.queryAllByTestId('cu-run-step')).toHaveLength(0);
    fireEvent.click(screen.getByText('操作回放 · Notepad'));
    const rows = screen.getAllByTestId('cu-run-step');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('点击 元素 #12');
    // Typed text is never shown, only its length.
    expect(rows[2]).toHaveTextContent('输入 11 个字符');
    expect(rows[2]).not.toHaveTextContent('hello world');
  });

  it('opens by itself when the run needs the user, flags consequential steps with what was approved, and shows the step screenshot', () => {
    render(
      <ComputerUseRunReportCard
        conversationId="conv-1"
        steps={[
          step(
            't1',
            { action: 'key', key: 'Return', consequence: 'send', consequence_detail: 'Send the drafted reply' },
            { action: 'key', targetApp: 'Slack', consequence: 'send', consequenceDetail: 'Send the drafted reply', outcome: 'verified-change' },
            true,
          ),
          step('t2', { action: 'click', x: 10, y: 20 }, { action: 'click', targetApp: 'Slack', consequence: 'none', outcome: 'paused' }),
        ]}
      />,
    );
    expect(screen.getByTestId('cu-run-final')).toHaveTextContent('已暂停');
    const rows = screen.getAllByTestId('cu-run-step');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('按键 Return');
    expect(screen.getByTestId('cu-run-consequence')).toHaveTextContent('有后果（send）· 已确认');
    expect(rows[0]).toHaveTextContent('Send the drafted reply');
    expect(rows[0].querySelector('img')).not.toBeNull();
    expect(rows[1]).toHaveTextContent('点击 (10, 20)');
    expect(screen.getByText(/1 步有后果/)).toBeInTheDocument();
  });

  it('is a flat card whose outcomes are status tags with their shape', () => {
    const { container } = render(
      <ComputerUseRunReportCard
        steps={[
          step('t1', { action: 'click', element_id: 3 }, { action: 'click', targetApp: 'Finder', consequence: 'delete', outcome: 'error', detail: 'approval-denied' }),
        ]}
      />,
    );
    const card = screen.getByTestId('cu-run-report');
    expect(card).toHaveClass('rounded-panel');
    expect(card).toHaveClass('border-separator');
    expect(card).toHaveClass('bg-surface');
    const header = screen.getByRole('button', { name: /操作回放/ });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('cu-run-final').querySelector('svg.lucide-circle-x')).toHaveClass('text-danger');
    expect(screen.getByTestId('cu-run-consequence').querySelector('svg.lucide-circle-x')).toHaveClass('text-danger');
    expect(container.innerHTML).not.toContain('--abu-');
  });

  it('marks a settled run with a success tag and folds it', () => {
    render(
      <ComputerUseRunReportCard
        steps={[step('t1', { action: 'click', element_id: 3 }, { action: 'click', targetApp: 'Finder', consequence: 'none', outcome: 'verified-change' })]}
      />,
    );
    expect(screen.getByRole('button', { name: /操作回放/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('cu-run-final').querySelector('svg.lucide-circle-check')).toHaveClass('text-success');
  });

  it('marks a consequential step that never ran as not executed', () => {
    render(
      <ComputerUseRunReportCard
        steps={[
          step('t1', { action: 'click', element_id: 3, consequence: 'delete' }, { action: 'click', targetApp: 'Finder', consequence: 'delete', outcome: 'error', detail: 'approval-denied' }),
        ]}
      />,
    );
    expect(screen.getByTestId('cu-run-consequence')).toHaveTextContent('有后果（delete）· 未执行');
    expect(screen.getByTestId('cu-run-final')).toHaveTextContent('失败');
    expect(screen.getAllByTestId('cu-run-step')[0]).toHaveTextContent('approval-denied');
  });
});
