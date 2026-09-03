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
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ScheduleTaskDetail from './ScheduleTaskDetail';
import { initLanguage } from '@/i18n';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ScheduledTask } from '@/types/schedule';

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
} as ScheduledTask;

function card(): HTMLElement {
  return screen
    .getByText('Browser authorization this task can use')
    .closest('div.rounded-xl') as HTMLElement;
}

describe('ScheduleTaskDetail — browser authorization', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useScheduleStore.setState({ tasks: { 'task-1': TASK }, selectedTaskId: 'task-1' });
    useSettingsStore.setState({
      browserSitePermissions: {},
      allowUnattendedBrowser: true,
      systemSettingsOpen: false,
    });
  });

  afterEach(() => cleanup());

  it('lists the origins an unattended run of this task may act on', () => {
    useSettingsStore.setState({
      browserSitePermissions: {
        'https://reports.example.com': 'allowed',
        'https://blocked.example.com': 'denied',
      },
    });
    render(<ScheduleTaskDetail />);

    expect(within(card()).getByText('https://reports.example.com')).toBeInTheDocument();
    // A blocked site is not an authorization this task can use.
    expect(within(card()).queryByText('https://blocked.example.com')).not.toBeInTheDocument();
  });

  it('leaves a high-risk site out of the set, even when the user allowed it', () => {
    useSettingsStore.setState({
      browserSitePermissions: { 'https://www.paypal.com': 'allowed' },
    });
    render(<ScheduleTaskDetail />);

    expect(within(card()).queryByText('https://www.paypal.com')).not.toBeInTheDocument();
    expect(within(card()).getByText(/No site is authorized/)).toBeInTheDocument();
  });

  it('says the task cannot use the browser at all while the master switch is off', () => {
    useSettingsStore.setState({
      browserSitePermissions: { 'https://reports.example.com': 'allowed' },
      allowUnattendedBrowser: false,
    });
    render(<ScheduleTaskDetail />);

    expect(within(card()).getByText(/master switch is off/)).toBeInTheDocument();
    // The list is not shown at all — it would read as "this task uses these".
    expect(within(card()).queryByText('https://reports.example.com')).not.toBeInTheDocument();
  });

  it('caps a long list and counts the rest', () => {
    const many: Record<string, 'allowed'> = {};
    for (let i = 0; i < 9; i += 1) many[`https://s${i}.example.com`] = 'allowed';
    useSettingsStore.setState({ browserSitePermissions: many });
    render(<ScheduleTaskDetail />);

    expect(within(card()).getByText('3 more')).toBeInTheDocument();
  });

  it('the revoke entry point opens Settings → Capabilities, where the verdicts live', async () => {
    const user = userEvent.setup();
    render(<ScheduleTaskDetail />);

    await user.click(within(card()).getByRole('button', { name: /Manage \/ revoke/ }));

    expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
    expect(useSettingsStore.getState().activeSystemTab).toBe('capabilities');
  });
});
