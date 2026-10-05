// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * U5 authorization visibility on the task detail page.
 *
 * A scheduled task runs unattended, so the browser gate lets it act only on
 * the sites the user granted in Settings — a standing authorization that was
 * visible nowhere near the task acting under it. This pins that the page now
 * reports it, and that the revoke entry point goes to the one place that owns
 * those verdicts (rather than growing a second editor that can disagree).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ScheduleTaskDetail from './ScheduleTaskDetail';
import { DesignSystemProvider } from '@/components/ds/provider';
import { schedulerEngine } from '@/core/scheduler/scheduler';
import { initLanguage } from '@/i18n';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ScheduledTask } from '@/types/schedule';
import { testSiteVerdicts } from '@/test/browserSiteVerdicts';

vi.mock('@/core/scheduler/scheduler', () => ({
  schedulerEngine: { runNow: vi.fn() },
}));
vi.mock('./ScheduleRunHistory', () => ({
  default: () => null,
}));

const TASK: ScheduledTask = {
  id: 'task-1',
  name: 'Nightly report',
  prompt: 'collect the numbers',
  schedule: { frequency: 'daily', time: { hour: 3, minute: 0 } },
  status: 'active',
  totalRuns: 4,
  createdAt: 0,
  updatedAt: 0,
  runs: [],
} as ScheduledTask;

// The page asks its questions through the design-system provider, as the app root does.
const renderDetail = () => render(<DesignSystemProvider><ScheduleTaskDetail /></DesignSystemProvider>);
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const backButton = () => button('Back');
const classes = (element: HTMLElement) => element.className.split(/\s+/);

function card(): HTMLElement {
  return screen
    .getByText('Browser authorization this task can use')
    .closest('[data-schedule-section]') as HTMLElement;
}

describe('ScheduleTaskDetail — browser authorization', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useScheduleStore.setState({ tasks: { 'task-1': TASK }, selectedTaskId: 'task-1' });
    useSettingsStore.setState({
      browserSitePermissions: testSiteVerdicts({}),
      allowUnattendedBrowser: true,
      systemSettingsOpen: false,
    });
  });

  afterEach(() => cleanup());

  it('points to shared browser permissions without duplicating the settings or old switch', () => {
    useSettingsStore.setState({ allowUnattendedBrowser: false, browserSitePermissions: testSiteVerdicts({ 'https://reports.example.com': 'allowed' }) });
    renderDetail();
    expect(within(card()).getByText('Applies to the built-in browser and My Chrome.')).toBeVisible();
    expect(within(card()).queryByText('https://reports.example.com')).toBeNull();
    expect(within(card()).queryByText(/master switch/)).toBeNull();
  });

  it('the revoke entry point opens Settings → Capabilities, where the verdicts live', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(within(card()).getByRole('button', { name: /Manage \/ revoke/ }));

    expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
    expect(useSettingsStore.getState().activeSystemTab).toBe('capabilities');
  });
});

describe('ScheduleTaskDetail — what its buttons do', () => {
  const runNow = vi.mocked(schedulerEngine.runNow);

  beforeEach(() => {
    initLanguage('en-US');
    runNow.mockReset();
    useScheduleStore.setState({
      tasks: { 'task-1': TASK, 'task-2': { ...TASK, id: 'task-2', name: 'Weekly digest' } },
      selectedTaskId: 'task-1',
      showEditor: false,
      editingTaskId: null,
    });
    useSettingsStore.setState({ systemSettingsOpen: false });
  });

  afterEach(() => cleanup());

  it('runs the task in view once, however often the button is pressed while it runs', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    runNow.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderDetail();

    await user.click(button('Run Now'));
    expect(runNow).toHaveBeenCalledTimes(1);
    expect(runNow).toHaveBeenCalledWith('task-1');

    await user.click(button('Running...'));
    expect(runNow).toHaveBeenCalledTimes(1);

    await act(async () => { finish(); });
    expect(button('Run Now')).toBeVisible();
  });

  it('pauses a running task and resumes a paused one', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(button('Pause'));
    expect(useScheduleStore.getState().tasks['task-1'].status).toBe('paused');

    await user.click(button('Resume'));
    expect(useScheduleStore.getState().tasks['task-1'].status).toBe('active');
  });

  it('deletes nothing until the question is answered, then deletes the task in view', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(button('Delete'));
    expect(Object.keys(useScheduleStore.getState().tasks)).toEqual(['task-1', 'task-2']);

    await user.click(button('Confirm'));
    expect(Object.keys(useScheduleStore.getState().tasks)).toEqual(['task-2']);
  });

  it('keeps the task when the question is answered with cancel', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(button('Delete'));
    await user.click(button('Cancel'));

    expect(Object.keys(useScheduleStore.getState().tasks)).toEqual(['task-1', 'task-2']);
  });

  it('opens the editor on the task in view', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(button('Edit'));

    expect(useScheduleStore.getState().showEditor).toBe(true);
    expect(useScheduleStore.getState().editingTaskId).toBe('task-1');
  });

  it('goes back to the list', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(backButton());

    expect(useScheduleStore.getState().selectedTaskId).toBeNull();
  });

  it('keeps the focus on the run button while the task runs: it is busy, never disabled', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    runNow.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderDetail();

    await user.click(button('Run Now'));

    const running = button('Running...');
    expect(running).toHaveAttribute('aria-disabled', 'true');
    expect(running).not.toBeDisabled();
    expect(running).toHaveFocus();
    // The words say it is running; nothing on the button turns.
    expect(running.querySelector('[data-ds-spinner]')).toBeNull();

    await act(async () => { finish(); });
    expect(button('Run Now')).not.toHaveAttribute('aria-disabled');
  });

  it('names the task in the question, on a line of its own under the question', async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(button('Delete'));

    const question = screen.getByRole('alertdialog', { name: 'Delete' });
    const words = within(question).getByText(/Are you sure you want to delete this scheduled task\?/);
    expect(words.textContent).toBe('Are you sure you want to delete this scheduled task?\nNightly report');
    expect(classes(words)).toContain('whitespace-pre-line');
  });

  it('deletes nothing when the task has already gone by the time the question is answered', async () => {
    const user = userEvent.setup();
    const realDelete = useScheduleStore.getState().deleteTask;
    const deleteTask = vi.fn();
    useScheduleStore.setState({ deleteTask });
    try {
      renderDetail();
      await user.click(button('Delete'));
      act(() => useScheduleStore.setState({ tasks: { 'task-2': { ...TASK, id: 'task-2', name: 'Weekly digest' } } }));

      await user.click(button('Confirm'));

      expect(deleteTask).not.toHaveBeenCalled();
    } finally {
      useScheduleStore.setState({ deleteTask: realDelete });
    }
  });

  it('deletes the task the question was asked about, under its id', async () => {
    const user = userEvent.setup();
    const realDelete = useScheduleStore.getState().deleteTask;
    const deleteTask = vi.fn();
    useScheduleStore.setState({ deleteTask });
    try {
      renderDetail();
      await user.click(button('Delete'));
      await user.click(button('Confirm'));

      expect(deleteTask).toHaveBeenCalledTimes(1);
      expect(deleteTask).toHaveBeenCalledWith('task-1');
    } finally {
      useScheduleStore.setState({ deleteTask: realDelete });
    }
  });

  it('has one filled button, the one that runs the task; delete is the danger button', () => {
    renderDetail();
    expect(classes(button('Run Now'))).toContain('bg-emphasis');
    expect(classes(button('Pause'))).not.toContain('bg-emphasis');
    expect(classes(button('Edit'))).not.toContain('bg-emphasis');
    expect(classes(button('Delete'))).toContain('text-danger');
  });

  it('says the status in a tag with a shape: running in green, paused in grey', () => {
    renderDetail();
    expect(classes(screen.getByText('Active'))).toContain('bg-success-soft');
    expect(screen.getByText('Active').querySelector('svg')).not.toBeNull();

    act(() => useScheduleStore.getState().pauseTask('task-1'));
    expect(classes(screen.getByText('Paused'))).toContain('bg-fill');
    expect(classes(screen.getByText('Paused'))).not.toContain('bg-success-soft');
  });

  it('keeps the page title as the first-level heading and the run history as a third-level one', () => {
    renderDetail();
    expect(screen.getByRole('heading', { level: 1, name: 'Nightly report' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: 'Run History' })).toBeVisible();
  });

  it('shows the prompt as it was typed, in the code font', () => {
    useScheduleStore.setState({ tasks: { 'task-1': { ...TASK, prompt: 'line one\n  line two' } } });
    renderDetail();
    const prompt = screen.getByText(/line one/);
    expect(prompt.textContent).toBe('line one\n  line two');
    expect(classes(prompt)).toContain('font-code');
    expect(classes(prompt)).toContain('whitespace-pre-wrap');
  });
});
