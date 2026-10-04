// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTriggerStore } from '@/stores/triggerStore';
import { navigateToChatWithInput } from '@/utils/navigation';
import AutomationView from './AutomationView';

// The two pages have their own tests. Each stand-in renders whenever the frame around it does,
// so counting its renders shows whether the frame renders again.
const pages = vi.hoisted(() => ({ renders: 0 }));

vi.mock('@/components/schedule/ScheduleView', () => ({
  default: () => {
    pages.renders += 1;
    return <div data-testid="schedule-page" />;
  },
}));
vi.mock('@/components/trigger/TriggerView', () => ({
  default: () => {
    pages.renders += 1;
    return <div data-testid="trigger-page" />;
  },
}));
vi.mock('@/utils/navigation', () => ({ navigateToChatWithInput: vi.fn() }));

const renderView = () => render(<DesignSystemProvider><AutomationView /></DesignSystemProvider>);
const tabRow = () => within(screen.getByTestId('top-tab-nav'));
const button = (name: string) => tabRow().getByRole('button', { name });

describe('AutomationView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    vi.mocked(navigateToChatWithInput).mockReset();
    useSettingsStore.setState({ activeAutomationTab: 'schedule' });
    useScheduleStore.setState({ showEditor: false, editingTaskId: null });
    useTriggerStore.setState({ showEditor: false, editingTriggerId: null });
    pages.renders = 0;
  });

  afterEach(() => cleanup());

  it('names its two tabs 定时任务 and 监听事件, in that order, before the create buttons', () => {
    renderView();
    expect(tabRow().getAllByRole('button').map((element) => element.textContent)).toEqual([
      '定时任务', '监听事件', '让阿布帮你创建', '新建任务',
    ]);
    expect(screen.getByTestId('schedule-page')).toBeVisible();
    expect(screen.queryByTestId('trigger-page')).toBeNull();
  });

  it('writes the chosen tab to the settings store and shows its page', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(button('监听事件'));

    expect(useSettingsStore.getState().activeAutomationTab).toBe('trigger');
    expect(screen.getByTestId('trigger-page')).toBeVisible();
    expect(screen.queryByTestId('schedule-page')).toBeNull();
  });

  it('opens an empty task editor from 新建任务', async () => {
    const user = userEvent.setup();
    useScheduleStore.setState({ editingTaskId: 'left-over' });
    renderView();

    await user.click(button('新建任务'));

    expect(useScheduleStore.getState().showEditor).toBe(true);
    expect(useScheduleStore.getState().editingTaskId).toBeNull();
  });

  it('starts a chat that asks Abu for a scheduled task', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(button('让阿布帮你创建'));

    expect(navigateToChatWithInput).toHaveBeenCalledTimes(1);
    expect(navigateToChatWithInput).toHaveBeenCalledWith('帮我创建一个定时任务');
    expect(useScheduleStore.getState().showEditor).toBe(false);
  });

  it('offers the event listener buttons on the other tab', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ activeAutomationTab: 'trigger' });
    renderView();
    expect(tabRow().getAllByRole('button').map((element) => element.textContent)).toEqual([
      '定时任务', '监听事件', '让阿布帮你创建', '新建监听',
    ]);

    await user.click(button('让阿布帮你创建'));
    expect(navigateToChatWithInput).toHaveBeenCalledWith('帮我创建一个触发器');

    await user.click(button('新建监听'));
    expect(useTriggerStore.getState().showEditor).toBe(true);
    expect(useScheduleStore.getState().showEditor).toBe(false);
  });

  it.each(['schedule', 'trigger'] as const)('has one filled button on the %s tab: the one that creates by hand', (activeAutomationTab) => {
    useSettingsStore.setState({ activeAutomationTab });
    renderView();
    const create = button(activeAutomationTab === 'schedule' ? '新建任务' : '新建监听');
    const askAbu = button('让阿布帮你创建');
    expect(create.className.split(/\s+/)).toContain('bg-emphasis');
    expect(askAbu.className.split(/\s+/)).toContain('bg-fill');
    expect(askAbu.className.split(/\s+/)).not.toContain('bg-emphasis');
    // Where the focus goes when a page has no card left to take it.
    expect(screen.getByTestId('automation-create')).toBe(create);
  });

  describe('render count', () => {
    // Stands in for App, which reads the chat store and renders for every piece of a streamed reply.
    const app = { renders: 0 };
    function AppAround() {
      useChatStore((s) => s.conversations);
      app.renders += 1;
      return <AutomationView />;
    }
    const streamPiece = (text: string) => {
      const { conversations } = useChatStore.getState();
      useChatStore.setState({
        conversations: {
          ...conversations,
          'conv-stream': {
            id: 'conv-stream', title: 'Streaming', createdAt: 1, updatedAt: 1, status: 'running',
            messages: [{ id: 'm1', role: 'assistant', content: text, timestamp: 1 }],
          },
        },
      });
    };

    beforeEach(() => { app.renders = 0; });

    it('does not render again when the chat store changes and the app around it renders', () => {
      render(<DesignSystemProvider><AppAround /></DesignSystemProvider>);
      const frame = pages.renders;
      const around = app.renders;
      expect(frame).toBeGreaterThan(0);

      for (const text of ['Once', 'Once upon', 'Once upon a time']) act(() => streamPiece(text));

      expect(app.renders).toBe(around + 3);
      expect(pages.renders).toBe(frame);
    });

    it('does not render again when a settings field it does not read changes', () => {
      renderView();
      const frame = pages.renders;
      act(() => useSettingsStore.setState({ sidebarCollapsed: !useSettingsStore.getState().sidebarCollapsed }));
      expect(pages.renders).toBe(frame);
    });

    it('renders again for what it shows: the tab in view', () => {
      renderView();
      const frame = pages.renders;
      act(() => useSettingsStore.setState({ activeAutomationTab: 'trigger' }));
      expect(pages.renders).toBeGreaterThan(frame);
      expect(screen.getByTestId('trigger-page')).toBeVisible();
    });
  });
});
