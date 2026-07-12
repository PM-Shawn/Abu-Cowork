/// <reference types="@testing-library/jest-dom" />
/**
 * State-dispatch tests for the inline show_widget card.
 *
 * The card must never vanish silently: a failed/cancelled call renders a
 * compact status row (the call is hidden from the generic tool list, so
 * this row is the only trace), and rendering ALWAYS re-runs the pure
 * validateWidgetCode gate — execute()'s validation throw comes back as a
 * plain string with the error flag unset, and cancelled calls never ran
 * validation at all.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import ShowWidgetCard from './ShowWidgetCard';
import {
  TOOL_RESULT_CANCELLED_MARKER,
  TOOL_RESULT_HOOK_BLOCKED_MARKER,
} from '@/core/agent/toolExecutor';
import { SHOW_WIDGET_OK_MARKER } from '@/core/tools/definitions/widgetTools';
import type { ToolCall } from '@/types';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      chat: {
        htmlWidgetLoading: '正在渲染组件...',
        widgetCardError: '组件渲染失败',
        widgetCardCancelled: '组件渲染已取消',
      },
    },
  }),
}));

// Stub the heavy renderer — these tests assert state dispatch, not iframe
// mechanics (HtmlWidgetBlock has its own P0 coverage).
vi.mock('./HtmlWidgetBlock', () => ({
  default: ({ code, title }: { code: string; title?: string }) => (
    <div data-testid="widget-block" data-title={title}>{code}</div>
  ),
}));

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-widget',
    name: 'show_widget',
    input: {
      title: 'Sales chart',
      widget_code: '<div>hi</div>',
      loading_messages: ['画图中…'],
    },
    hidden: true,
    result: `${SHOW_WIDGET_OK_MARKER}Widget rendered: Sales chart`,
    ...overrides,
  };
}

afterEach(cleanup);

describe('ShowWidgetCard', () => {
  it('shows the skeleton with loading_messages[0] while executing', () => {
    render(<ShowWidgetCard toolCall={makeCall({ result: undefined, isExecuting: true })} />);
    expect(screen.getByText('画图中…')).toBeInTheDocument();
    expect(screen.queryByTestId('widget-block')).not.toBeInTheDocument();
  });

  it('renders the widget from input when result is stale-undefined but not executing (reload recovery)', () => {
    render(<ShowWidgetCard toolCall={makeCall({ result: undefined, isExecuting: undefined })} />);
    expect(screen.getByTestId('widget-block')).toHaveTextContent('<div>hi</div>');
  });

  it('shows the error row (not an eternal skeleton) for stale-undefined result with INVALID code', () => {
    render(
      <ShowWidgetCard
        toolCall={makeCall({
          result: undefined,
          isExecuting: undefined,
          input: { title: 'Bad', widget_code: '<form><input/></form>', loading_messages: ['x'] },
        })}
      />,
    );
    expect(screen.getByText(/组件渲染失败/)).toBeInTheDocument();
  });

  it('shows the cancelled row for the cancel marker', () => {
    render(<ShowWidgetCard toolCall={makeCall({ result: TOOL_RESULT_CANCELLED_MARKER })} />);
    expect(screen.getByText(/组件渲染已取消/)).toBeInTheDocument();
    expect(screen.queryByTestId('widget-block')).not.toBeInTheDocument();
  });

  it('shows the cancelled row for the hook-blocked marker', () => {
    render(<ShowWidgetCard toolCall={makeCall({ result: TOOL_RESULT_HOOK_BLOCKED_MARKER })} />);
    expect(screen.getByText(/组件渲染已取消/)).toBeInTheDocument();
  });

  it('shows the error row (with title) for the interrupted-by-user backfill', () => {
    render(<ShowWidgetCard toolCall={makeCall({ isError: true, result: '[Tool execution interrupted by user]' })} />);
    expect(screen.getByText(/组件渲染失败 · Sales chart/)).toBeInTheDocument();
  });

  it('shows the error row when the code fails client-side validation even though the result looks settled', () => {
    // execute()'s throw is caught by the registry and returned as a plain
    // string with error:false — the card must not mount the renderer.
    render(
      <ShowWidgetCard
        toolCall={makeCall({
          result: 'Error executing tool "show_widget": widget_code must not contain a <form> element',
          input: { title: 'Bad', widget_code: '<form><input/></form>', loading_messages: ['x'] },
        })}
      />,
    );
    expect(screen.getByText(/组件渲染失败/)).toBeInTheDocument();
    expect(screen.queryByTestId('widget-block')).not.toBeInTheDocument();
  });

  it('renders the widget with a filename-safe sanitized title on success', () => {
    render(
      <ShowWidgetCard
        toolCall={makeCall({
          input: { title: '2024/Q1 营收', widget_code: '<div>chart</div>', loading_messages: ['x'] },
          result: `${SHOW_WIDGET_OK_MARKER}Widget rendered: 2024/Q1 营收`,
        })}
      />,
    );
    const block = screen.getByTestId('widget-block');
    expect(block).toHaveTextContent('<div>chart</div>');
    expect(block.getAttribute('data-title')).toBe('2024Q1_营收');
  });

  describe('positive success gate — any non-marker result is a status row', () => {
    it('param-error result (missing required parameter) → error row, no widget', () => {
      render(
        <ShowWidgetCard
          toolCall={makeCall({
            result: 'Error: tool "show_widget" is missing required parameter(s): title.',
          })}
        />,
      );
      expect(screen.getByText(/组件渲染失败/)).toBeInTheDocument();
      expect(screen.queryByTestId('widget-block')).not.toBeInTheDocument();
    });

    it('enterprise policy denial → error row, no widget (even with valid code)', () => {
      render(
        <ShowWidgetCard toolCall={makeCall({ result: 'Error: [policy] blocked by org policy' })} />,
      );
      expect(screen.getByText(/组件渲染失败/)).toBeInTheDocument();
      expect(screen.queryByTestId('widget-block')).not.toBeInTheDocument();
    });

    it("en-US Stop backfill '[Cancelled]' → cancelled row, regardless of active locale", () => {
      render(<ShowWidgetCard toolCall={makeCall({ result: '[Cancelled]' })} />);
      expect(screen.getByText(/组件渲染已取消/)).toBeInTheDocument();
      expect(screen.queryByTestId('widget-block')).not.toBeInTheDocument();
    });

    it("zh-CN Stop backfill '[已取消]' → cancelled row", () => {
      render(<ShowWidgetCard toolCall={makeCall({ result: '[已取消]' })} />);
      expect(screen.getByText(/组件渲染已取消/)).toBeInTheDocument();
    });

    it('marker-carrying result renders the widget', () => {
      render(<ShowWidgetCard toolCall={makeCall()} />);
      expect(screen.getByTestId('widget-block')).toHaveTextContent('<div>hi</div>');
    });
  });

  describe('skeleton loading_messages cycling', () => {
    it('cycles through multiple loading messages on an interval', async () => {
      vi.useFakeTimers();
      try {
        render(
          <ShowWidgetCard
            toolCall={makeCall({
              result: undefined,
              isExecuting: true,
              input: {
                title: 'Chart',
                widget_code: '<div>x</div>',
                loading_messages: ['第一步…', '第二步…'],
              },
            })}
          />,
        );
        expect(screen.getByText('第一步…')).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2500);
        });
        expect(screen.getByText('第二步…')).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2500);
        });
        expect(screen.getByText('第一步…')).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
