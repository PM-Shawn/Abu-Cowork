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
      browserSitePermissions: testSiteVerdicts({}),
      allowUnattendedBrowser: true,
      systemSettingsOpen: false,
    });
  });

  afterEach(() => cleanup());

  it('points to shared browser permissions without duplicating the settings or old switch', () => {
    useSettingsStore.setState({ allowUnattendedBrowser: false, browserSitePermissions: testSiteVerdicts({ 'https://reports.example.com': 'allowed' }) });
    render(<ScheduleTaskDetail />);
    expect(within(card()).getByText('Applies to the built-in browser and My Chrome.')).toBeVisible();
    expect(within(card()).queryByText('https://reports.example.com')).toBeNull();
    expect(within(card()).queryByText(/master switch/)).toBeNull();
  });

  it('the revoke entry point opens Settings → Capabilities, where the verdicts live', async () => {
    const user = userEvent.setup();
    render(<ScheduleTaskDetail />);

    await user.click(within(card()).getByRole('button', { name: /Manage \/ revoke/ }));

    expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
    expect(useSettingsStore.getState().activeSystemTab).toBe('capabilities');
  });
});
