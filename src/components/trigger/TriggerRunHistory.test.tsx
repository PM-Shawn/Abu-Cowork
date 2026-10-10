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
import type { TriggerRun } from '@/types/trigger';
import TriggerRunHistory from './TriggerRunHistory';

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

const NOON = new Date(2026, 0, 5, 12, 0, 0).getTime();
const ago = (minutes: number) => NOON - minutes * 60_000;

const RUNS: TriggerRun[] = [
  { id: 'run-5', triggerId: 't', conversationId: 'conv-5', startedAt: ago(0), status: 'running' },
  { id: 'run-4', triggerId: 't', conversationId: 'conv-4', startedAt: ago(5), status: 'completed', outputStatus: 'sent' },
  { id: 'run-3', triggerId: 't', conversationId: 'conv-gone', startedAt: ago(90), status: 'error', error: 'the model refused the request after forty characters', outputStatus: 'failed', outputError: 'webhook answered 500' },
  { id: 'run-2', triggerId: 't', conversationId: 'conv-gone', startedAt: ago(60 * 26), status: 'error' },
  { id: 'run-1', triggerId: 't', conversationId: '', startedAt: ago(60 * 50), status: 'filtered' },
  { id: 'run-0', triggerId: 't', conversationId: '', startedAt: ago(60 * 80), status: 'debounced' },
];

const conversationMeta = (id: string) => ({ id, title: id, createdAt: 1, updatedAt: 1, messageCount: 0 });
const renderHistory = (runs: TriggerRun[]) => render(<DesignSystemProvider><TriggerRunHistory runs={runs} /></DesignSystemProvider>);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-trigger-run]')];
const viewButtons = () => screen.queryAllByRole('button', { name: '查看会话' });
const classes = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/);

describe('TriggerRunHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOON);
    initLanguage('zh-CN');
    switchConversation.mockReset();
    iconButtons.renders = 0;
    useChatStore.setState({
      conversationIndex: { 'conv-5': conversationMeta('conv-5'), 'conv-4': conversationMeta('conv-4') } as never,
      switchConversation,
    });
    useSettingsStore.setState({ viewMode: 'automation' });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useChatStore.setState({ switchConversation: realSwitchConversation });
  });

  it('says so when the listener has never fired', () => {
    renderHistory([]);
    expect(screen.getByText('暂无执行记录')).toBeVisible();
    expect(rows()).toEqual([]);
  });

  it('lists each run with how long ago it started and its outcome in words', () => {
    renderHistory(RUNS);
    expect(rows().map((row) => row.dataset.triggerRun)).toEqual(['run-5', 'run-4', 'run-3', 'run-2', 'run-1', 'run-0']);

    expect(rows()[0]).toHaveTextContent('<1分钟前');
    expect(rows()[0]).toHaveTextContent('执行中');
    expect(rows()[1]).toHaveTextContent('5分钟前');
    expect(rows()[1]).toHaveTextContent('已完成');
    // A failure shows the first thirty characters of what went wrong, else the word for it.
    expect(rows()[2]).toHaveTextContent('1小时前');
    expect(rows()[2]).toHaveTextContent('the model refused the request ');
    expect(rows()[2]).not.toHaveTextContent('after forty');
    expect(rows()[3]).toHaveTextContent('1天前');
    expect(rows()[3]).toHaveTextContent('出错');
    expect(rows()[4]).toHaveTextContent('未匹配');
    expect(rows()[5]).toHaveTextContent('已去重');
  });

  it('marks the outcome with a shape as well as a color, and turns only for a run in progress', () => {
    renderHistory(RUNS);
    expect(rows()[0].querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(within(rows()[0]).getByRole('status')).toHaveTextContent('执行中');
    expect(rows()[1].querySelector('[data-ds-spinner]')).toBeNull();
    expect(classes(rows()[1].querySelector('svg')!)).toContain('text-success');
    expect(classes(rows()[2].querySelector('svg')!)).toContain('text-danger');
    // A run that was skipped is no failure: a grey mark.
    for (const skipped of [rows()[4], rows()[5]]) {
      expect(classes(skipped.querySelector('svg')!)).toContain('text-label-tertiary');
      expect(classes(skipped.querySelector('svg')!)).toContain('lucide-circle-minus');
    }
  });

  it('says whether the result was pushed, and why not on the mark of a failed push', () => {
    renderHistory(RUNS);
    const sent = within(rows()[1]).getByText('已推送');
    expect(classes(sent)).toContain('bg-success-soft');

    const failed = within(rows()[2]).getByText('推送失败');
    expect(classes(failed)).toContain('bg-danger-soft');
    expect(failed.parentElement).toHaveAttribute('title', 'webhook answered 500');

    expect(within(rows()[0]).queryByText('已推送')).toBeNull();
    expect(within(rows()[3]).queryByText('推送失败')).toBeNull();
  });

  it('offers the conversation of a run only while that conversation exists, and opens it', async () => {
    const user = userEvent.setup();
    renderHistory(RUNS);
    expect(viewButtons()).toHaveLength(2);
    expect(within(rows()[2]).queryByRole('button')).toBeNull();

    await user.click(within(rows()[1]).getByRole('button', { name: '查看会话' }));

    expect(switchConversation).toHaveBeenCalledTimes(1);
    expect(switchConversation).toHaveBeenCalledWith('conv-4');
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('puts the focus in the message field once 查看会话 has changed the page', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
    // Stands in for the app: the automation page and the chat page replace each other.
    function Page() {
      const viewMode = useSettingsStore((s) => s.viewMode);
      return viewMode === 'automation' ? <TriggerRunHistory runs={RUNS} /> : <TextArea data-chat-composer aria-label="message" />;
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

  it('says that the conversation of a run was deleted, and nothing for a run that never had one', () => {
    renderHistory(RUNS);
    for (const gone of [rows()[2], rows()[3]]) {
      const mark = within(gone).getByRole('img', { name: '对话已删除' });
      expect(mark.parentElement).toHaveAttribute('title', '对话已删除');
    }
    expect(within(rows()[4]).queryByRole('img')).toBeNull();
    expect(within(rows()[5]).queryByRole('img')).toBeNull();
  });

  it('gives every row the same least height, with or without a button at its end', () => {
    renderHistory(RUNS);
    for (const row of rows()) expect(classes(row)).toContain('min-h-8');
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
    act(() => useChatStore.setState({ conversationIndex: { 'conv-5': conversationMeta('conv-5') } as never }));
    expect(viewButtons()).toHaveLength(1);
    expect(within(rows()[1]).queryByRole('button')).toBeNull();
    expect(within(rows()[1]).getByRole('img', { name: '对话已删除' })).toBeInTheDocument();
  });
});
