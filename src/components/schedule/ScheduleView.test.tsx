// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { ScheduledTask } from '@/types/schedule';
import { passSettleInterval } from '@/test/dsWindows';
import ScheduleView from './ScheduleView';

vi.mock('@/core/scheduler/scheduler', () => ({
  schedulerEngine: { runNow: vi.fn() },
}));

const task = (id: string, name: string, createdAt: number, extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id,
  name,
  prompt: 'collect the numbers',
  schedule: { frequency: 'daily', time: { hour: 9, minute: 0 } },
  status: 'active',
  totalRuns: 0,
  createdAt,
  updatedAt: createdAt,
  runs: [],
  ...extra,
});

const seed = (...tasks: ScheduledTask[]) => useScheduleStore.setState({
  tasks: Object.fromEntries(tasks.map((item) => [item.id, item])),
  selectedTaskId: null,
  showEditor: false,
  editingTaskId: null,
});

const renderView = () => render(<DesignSystemProvider><ScheduleView /></DesignSystemProvider>);
const status = (id: string) => useScheduleStore.getState().tasks[id].status;
// The on/off control of one card: a switch named after its task.
const toggleOf = (name: string) => screen.getByRole('switch', { name });
const card = (id: string) => screen.getByTestId(`schedule-card-${id}`);

describe('ScheduleView', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    seed();
  });

  afterEach(() => cleanup());

  it('says so when there is no task yet', () => {
    renderView();
    expect(screen.getByText(getI18n().schedule.noTasks)).toBeVisible();
    expect(screen.getByText(getI18n().schedule.noTasksHint)).toBeVisible();
    // The design-system empty state: its title is a window-title-sized line.
    expect(screen.getByText(getI18n().schedule.noTasks).className.split(/\s+/)).toContain('text-title');
  });

  it('tells when tasks run, with or without tasks', () => {
    renderView();
    expect(screen.getByText(getI18n().schedule.onlyRunWhileAwake)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(getI18n().schedule.onlyRunWhileAwake);
  });

  it('draws each task as a card that is a button, found again by its task id', () => {
    seed(task('a', '任务 A', 100), task('b', '任务 B', 200, { status: 'paused' }));
    renderView();

    expect(card('a')).toHaveAttribute('role', 'button');
    expect(card('a').parentElement).toHaveAttribute('data-automation-entry', 'a');
    expect(toggleOf('任务 A')).toBeChecked();
    expect(toggleOf('任务 B')).not.toBeChecked();
  });

  it('opens the task from the keyboard when its card has the focus', async () => {
    const user = userEvent.setup();
    seed(task('a', '任务 A', 100));
    renderView();
    card('a').focus();

    await user.keyboard('{Enter}');

    expect(useScheduleStore.getState().selectedTaskId).toBe('a');
  });

  it('lists the newest task first', () => {
    seed(task('a', '任务 A', 100), task('b', '任务 B', 300), task('c', '任务 C', 200));
    renderView();
    expect(screen.getAllByText(/^任务 [ABC]$/).map((element) => element.textContent)).toEqual(['任务 B', '任务 C', '任务 A']);
  });

  it('shows how often a task runs and when it last ran', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const noon = new Date(2026, 0, 5, 12, 0, 0);
    vi.setSystemTime(noon);
    try {
      seed(
        task('a', '任务 A', 100, { schedule: { frequency: 'weekly', time: { hour: 8, minute: 5 }, dayOfWeek: 3 }, lastRunAt: noon.getTime() - 2 * 3600_000 }),
        task('b', '任务 B', 200, { schedule: { frequency: 'hourly', time: { hour: 0, minute: 7 } } }),
        task('c', '任务 C', 300, { schedule: { frequency: 'manual' } }),
      );
      renderView();
      expect(screen.getByText('每周 周三 08:05')).toBeVisible();
      expect(screen.getByText('上次执行: 2h前')).toBeVisible();
      expect(screen.getByText('每小时 :07')).toBeVisible();
      expect(screen.getByText('手动')).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens the task whose card is pressed', async () => {
    const user = userEvent.setup();
    seed(task('a', '任务 A', 100), task('b', '任务 B', 200));
    renderView();

    await user.click(screen.getByText('任务 A'));

    expect(useScheduleStore.getState().selectedTaskId).toBe('a');
  });

  it('pauses and resumes from the card without opening the task', async () => {
    const user = userEvent.setup();
    seed(task('a', '任务 A', 100), task('b', '任务 B', 200, { status: 'paused' }));
    renderView();

    await user.click(toggleOf('任务 A'));
    expect(status('a')).toBe('paused');
    await user.click(toggleOf('任务 B'));
    expect(status('b')).toBe('active');

    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('takes Enter and Space on the card switch, and nothing from the arrow keys', async () => {
    const user = userEvent.setup();
    seed(task('a', '任务 A', 100));
    renderView();
    toggleOf('任务 A').focus();

    await user.keyboard('{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}');
    expect(status('a')).toBe('active');

    await user.keyboard('{Enter}');
    expect(status('a')).toBe('paused');
    await user.keyboard(' ');
    expect(status('a')).toBe('active');

    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('shows the task page in place of the list once a task is chosen', () => {
    seed(task('a', '任务 A', 100));
    useScheduleStore.setState({ selectedTaskId: 'a' });
    renderView();

    expect(screen.getByRole('heading', { level: 1, name: '任务 A' })).toBeVisible();
    expect(screen.queryByText(getI18n().schedule.onlyRunWhileAwake)).toBeNull();
  });

  describe('keyboard focus between the list and a task page', () => {
    const backButton = () => screen.getByRole('button', { name: getI18n().schedule.backToList });

    it('lands on the way back when a card opens its task, and on that card on the way back', async () => {
      const user = userEvent.setup();
      seed(task('a', '任务 A', 100), task('b', '任务 B', 200));
      renderView();
      card('a').focus();

      await user.keyboard('{Enter}');
      expect(backButton()).toHaveFocus();
      expect(backButton()).toHaveAttribute('data-automation-back');

      await user.keyboard('{Enter}');
      expect(useScheduleStore.getState().selectedTaskId).toBeNull();
      expect(card('a')).toHaveFocus();
    });

    it('moves no focus when the page first shows, whichever of the two it shows', () => {
      seed(task('a', '任务 A', 100));
      useScheduleStore.setState({ selectedTaskId: 'a' });
      renderView();
      expect(document.body).toHaveFocus();
    });

    it('leaves the focus where it is when it sits on a control outside the page', () => {
      seed(task('a', '任务 A', 100));
      render(
        <DesignSystemProvider>
          <Button data-testid="outside">outside</Button>
          <ScheduleView />
        </DesignSystemProvider>,
      );
      screen.getByTestId('outside').focus();

      act(() => useScheduleStore.getState().setSelectedTaskId('a'));

      expect(screen.getByTestId('outside')).toHaveFocus();
    });

    it('goes to the card that took the place of a deleted task, else the one before it', async () => {
      const user = userEvent.setup();
      seed(task('a', '任务 A', 100), task('b', '任务 B', 200), task('c', '任务 C', 300));
      renderView();

      // The middle card: its place is taken by the card after it.
      await user.click(card('b'));
      await user.click(screen.getByRole('button', { name: getI18n().schedule.delete }));
      // The question takes no pointer press for a moment after it appears: it has been read.
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: getI18n().common.confirm }));
      expect(Object.keys(useScheduleStore.getState().tasks)).toEqual(['a', 'c']);
      expect(card('a')).toHaveFocus();

      // The last card: the one before it.
      await user.click(card('a'));
      await user.click(screen.getByRole('button', { name: getI18n().schedule.delete }));
      // The question takes no pointer press for a moment after it appears: it has been read.
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: getI18n().common.confirm }));
      expect(Object.keys(useScheduleStore.getState().tasks)).toEqual(['c']);
      expect(card('c')).toHaveFocus();
    });

    it('goes to the create button when the last task is deleted', async () => {
      const user = userEvent.setup();
      seed(task('a', '任务 A', 100));
      render(
        <DesignSystemProvider>
          <Button data-testid="automation-create">create</Button>
          <ScheduleView />
        </DesignSystemProvider>,
      );

      await user.click(card('a'));
      await user.click(screen.getByRole('button', { name: getI18n().schedule.delete }));
      // The question takes no pointer press for a moment after it appears: it has been read.
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: getI18n().common.confirm }));

      expect(useScheduleStore.getState().tasks).toEqual({});
      expect(screen.getByTestId('automation-create')).toHaveFocus();
    });

    // A tool in a conversation can delete the task whose page is in view. A window opened from
    // that page then gives the focus back to a button that has left with the page.
    describe('when the task in view is deleted from outside under a window opened from its page', () => {
      it('goes to the card that took its place once the delete question is cancelled', async () => {
        const user = userEvent.setup();
        seed(task('a', '任务 A', 100), task('b', '任务 B', 200));
        renderView();
        await user.click(card('a'));
        await user.click(screen.getByRole('button', { name: getI18n().schedule.delete }));

        act(() => useScheduleStore.getState().deleteTask('a'));
        passSettleInterval();
        await user.click(screen.getByRole('button', { name: getI18n().common.cancel }));

        await waitFor(() => expect(card('b')).toHaveFocus());
      });

      it('goes to the card that took its place once the delete question is confirmed', async () => {
        const user = userEvent.setup();
        seed(task('a', '任务 A', 100), task('b', '任务 B', 200));
        renderView();
        await user.click(card('a'));
        await user.click(screen.getByRole('button', { name: getI18n().schedule.delete }));

        act(() => useScheduleStore.getState().deleteTask('a'));
        passSettleInterval();
        await user.click(screen.getByRole('button', { name: getI18n().common.confirm }));

        await waitFor(() => expect(card('b')).toHaveFocus());
        expect(Object.keys(useScheduleStore.getState().tasks)).toEqual(['b']);
      });

      it('goes to the card that took its place once the editor is closed', async () => {
        const user = userEvent.setup();
        seed(task('a', '任务 A', 100), task('b', '任务 B', 200));
        renderView();
        await user.click(card('a'));
        await user.click(screen.getByRole('button', { name: getI18n().schedule.edit }));

        act(() => useScheduleStore.getState().deleteTask('a'));
        await user.click(screen.getByRole('button', { name: getI18n().common.cancel }));

        await waitFor(() => expect(card('b')).toHaveFocus());
      });

      it('goes to the create button when no task is left', async () => {
        const user = userEvent.setup();
        seed(task('a', '任务 A', 100));
        render(
          <DesignSystemProvider>
            <Button data-testid="automation-create">create</Button>
            <ScheduleView />
          </DesignSystemProvider>,
        );
        await user.click(card('a'));
        await user.click(screen.getByRole('button', { name: getI18n().schedule.edit }));

        act(() => useScheduleStore.getState().deleteTask('a'));
        await user.click(screen.getByRole('button', { name: getI18n().common.cancel }));

        await waitFor(() => expect(screen.getByTestId('automation-create')).toHaveFocus());
      });

      it('leaves the focus on the button that opened the editor when that button is still on the page', async () => {
        const user = userEvent.setup();
        seed(task('a', '任务 A', 100), task('b', '任务 B', 200));
        render(
          <DesignSystemProvider>
            <Button data-testid="automation-create" onClick={() => useScheduleStore.getState().openEditor()}>create</Button>
            <ScheduleView />
          </DesignSystemProvider>,
        );
        await user.click(card('a'));
        await user.click(screen.getByTestId('automation-create'));

        act(() => useScheduleStore.getState().deleteTask('a'));
        await user.click(screen.getByRole('button', { name: getI18n().common.cancel }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() => expect(screen.getByTestId('automation-create')).toHaveFocus());
      });
    });
  });

  it('keeps one editor mounted while the list and a task page replace each other', async () => {
    const user = userEvent.setup();
    seed(task('a', '任务 A', 100));
    renderView();
    act(() => useScheduleStore.getState().openEditor('a'));
    const editor = screen.getByRole('dialog', { name: getI18n().schedule.editTask });

    act(() => useScheduleStore.getState().setSelectedTaskId('a'));

    expect(screen.getByRole('dialog', { name: getI18n().schedule.editTask })).toBe(editor);
    await user.keyboard('{Escape}');
  });

  it('shows the list when the chosen task no longer exists', () => {
    seed(task('a', '任务 A', 100));
    useScheduleStore.setState({ selectedTaskId: 'gone' });
    renderView();

    expect(screen.getByText(getI18n().schedule.onlyRunWhileAwake)).toBeVisible();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });
});
