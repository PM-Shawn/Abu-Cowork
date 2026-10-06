// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import { TextArea } from '@/components/ds/text-area';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ScheduledTaskRun } from '@/types/schedule';
import ScheduleRunHistory from './ScheduleRunHistory';

// Each row that can open a conversation holds one icon button, which is a tooltip root. Counting
// its renders shows whether the rows render again.
const iconButtons = vi.hoisted(() => ({ renders: 0 }));
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      iconButtons.renders += 1;
      return <actual.IconButton {...props} />;
    },
  };
});

const realSwitchConversation = useChatStore.getState().switchConversation;
const switchConversation = vi.fn();

const at = (hour: number, minute: number) => new Date(2026, 0, 5, hour, minute, 7).getTime();

const RUNS: ScheduledTaskRun[] = [
  { id: 'run-3', scheduledTaskId: 'task-1', conversationId: 'conv-3', startedAt: at(11, 0), status: 'running' },
  { id: 'run-2', scheduledTaskId: 'task-1', conversationId: 'conv-2', startedAt: at(10, 0), completedAt: at(10, 2), status: 'completed' },
  { id: 'run-1', scheduledTaskId: 'task-1', conversationId: 'conv-gone', startedAt: at(9, 0), completedAt: at(9, 1), status: 'error', error: 'the model refused the request after forty characters' },
  { id: 'run-0', scheduledTaskId: 'task-1', conversationId: 'conv-gone', startedAt: at(8, 0), completedAt: at(8, 1), status: 'error' },
];

const conversationMeta = (id: string) => ({ id, title: id, createdAt: 1, updatedAt: 1, messageCount: 0 });
const renderHistory = (runs: ScheduledTaskRun[]) => render(<DesignSystemProvider><ScheduleRunHistory runs={runs} /></DesignSystemProvider>);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-schedule-run]')];
const viewButtons = () => screen.queryAllByRole('button', { name: '查看会话' });

describe('ScheduleRunHistory', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    switchConversation.mockReset();
    iconButtons.renders = 0;
    useChatStore.setState({
      conversationIndex: { 'conv-3': conversationMeta('conv-3'), 'conv-2': conversationMeta('conv-2') } as never,
      switchConversation,
    });
    useSettingsStore.setState({ viewMode: 'automation' });
  });

  afterEach(() => {
    cleanup();
    useChatStore.setState({ switchConversation: realSwitchConversation });
  });

  it('says so when the task has never run', () => {
    renderHistory([]);
    expect(screen.getByText('暂无执行记录')).toBeVisible();
    expect(rows()).toEqual([]);
  });

  it('lists each run with its times and its outcome in words', () => {
    renderHistory(RUNS);
    expect(rows().map((row) => row.dataset.scheduleRun)).toEqual(['run-3', 'run-2', 'run-1', 'run-0']);

    expect(rows()[0]).toHaveTextContent('开始 2026/01/05 11:00:07');
    expect(rows()[0]).toHaveTextContent('执行中');
    expect(rows()[0]).not.toHaveTextContent('结束');

    expect(rows()[1]).toHaveTextContent('已完成');
    expect(rows()[1]).toHaveTextContent('结束 2026/01/05 10:02:07');

    // A failure shows the first thirty characters of what went wrong, else the word for it.
    expect(rows()[2]).toHaveTextContent('the model refused the request ');
    expect(rows()[2]).not.toHaveTextContent('after forty');
    expect(rows()[3]).toHaveTextContent('出错');
  });

  it('marks the outcome with a shape as well as a color, and turns only for a run in progress', () => {
    renderHistory(RUNS);
    expect(rows()[0].querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(within(rows()[0]).getByRole('status')).toHaveTextContent('执行中');
    expect(rows()[1].querySelector('[data-ds-spinner]')).toBeNull();
    expect(rows()[1].querySelector('svg')!.getAttribute('class')!.split(/\s+/)).toContain('text-success');
    expect(rows()[2].querySelector('svg')!.getAttribute('class')!.split(/\s+/)).toContain('text-danger');
  });

  it('offers the conversation of a run only while that conversation exists, and opens it', async () => {
    const user = userEvent.setup();
    renderHistory(RUNS);
    expect(viewButtons()).toHaveLength(2);
    expect(within(rows()[2]).queryByRole('button')).toBeNull();

    await user.click(within(rows()[1]).getByRole('button', { name: '查看会话' }));

    expect(switchConversation).toHaveBeenCalledTimes(1);
    expect(switchConversation).toHaveBeenCalledWith('conv-2');
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('puts the focus in the message field once 查看会话 has changed the page', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
    // Stands in for the app: the automation page and the chat page replace each other.
    function Page() {
      const viewMode = useSettingsStore((s) => s.viewMode);
      return viewMode === 'automation' ? <ScheduleRunHistory runs={RUNS} /> : <TextArea data-chat-composer aria-label="message" />;
    }
    render(<DesignSystemProvider><Page /></DesignSystemProvider>);
    const view = within(rows()[1]).getByRole('button', { name: '查看会话' });
    view.focus();

    fireEvent.click(view);
    const field = screen.getByRole('textbox', { name: 'message' });
    expect(field).not.toHaveFocus();
    act(() => { frames.splice(0).forEach((frame) => frame(0)); });

    expect(field).toHaveFocus();
    vi.unstubAllGlobals();
  });

  it('asks for no focus when the conversation of the run is gone and the page stays', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
    renderHistory(RUNS);
    const view = within(rows()[1]).getByRole('button', { name: '查看会话' });
    // Deleted between the render and the press.
    useChatStore.setState({ conversationIndex: {} as never });

    fireEvent.click(view);

    expect(useSettingsStore.getState().viewMode).toBe('automation');
    expect(frames).toEqual([]);
    vi.unstubAllGlobals();
  });

  it('does not render a row again when another conversation changes', () => {
    renderHistory(RUNS);
    const before = iconButtons.renders;
    expect(before).toBe(2);

    act(() => useChatStore.setState({
      conversationIndex: { ...useChatStore.getState().conversationIndex, 'conv-other': conversationMeta('conv-other') } as never,
    }));

    expect(iconButtons.renders).toBe(before);
  });

  it('takes the button away from a run whose conversation is deleted', () => {
    renderHistory(RUNS);
    act(() => useChatStore.setState({ conversationIndex: { 'conv-3': conversationMeta('conv-3') } as never }));
    expect(viewButtons()).toHaveLength(1);
    expect(within(rows()[1]).queryByRole('button')).toBeNull();
  });
});
