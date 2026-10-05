// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initLanguage } from '@/i18n';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useProjectStore } from '@/stores/projectStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useTeamStore, type Team } from '@/stores/teamStore';
import type { IMChannel } from '@/types/imChannel';
import type { Project } from '@/types/project';
import type { ScheduledTask } from '@/types/schedule';
import ScheduleEditor from './ScheduleEditor';

const BASE_TIME = 1_700_000_000_000;

const project: Project = {
  id: 'project-1',
  name: 'Alpha project',
  workspacePath: '/workspace/alpha',
  pinned: false,
  archived: false,
  createdAt: BASE_TIME,
  updatedAt: BASE_TIME,
  lastActiveAt: BASE_TIME,
};

const channel = {
  id: 'channel-1',
  platform: 'feishu',
  name: 'Ops channel',
} as IMChannel;

const team: Team = {
  id: 'team-1',
  name: 'Alpha team',
  leaderRoleId: 'role-1',
  memberRoleIds: ['role-1'],
  createdAt: BASE_TIME,
};

function resetStores() {
  useScheduleStore.setState({
    tasks: {},
    activeTaskId: null,
    selectedTaskId: null,
    showEditor: false,
    editingTaskId: null,
  });
  useDiscoveryStore.setState({ skills: [], agents: [], isLoading: false });
  useIMChannelStore.setState({ channels: {} });
  useProjectStore.setState({ projects: {} });
  useTeamStore.setState({ teams: [], managedTeamSources: {} });
}

function openEditorOnTask(fields: Partial<ScheduledTask>): ScheduledTask {
  const task: ScheduledTask = {
    id: 'task-1',
    name: 'Nightly report',
    prompt: 'collect the numbers',
    schedule: { frequency: 'daily', time: { hour: 3, minute: 0 } },
    status: 'active',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    runs: [],
    totalRuns: 0,
    ...fields,
  };
  useDiscoveryStore.setState({
    skills: [{ name: 'report', description: 'Builds a report', userInvocable: true }],
  });
  useIMChannelStore.setState({ channels: { [channel.id]: channel } });
  useProjectStore.setState({ projects: { [project.id]: project } });
  useTeamStore.setState({ teams: [team] });
  useScheduleStore.setState({
    tasks: { [task.id]: task },
    showEditor: true,
    editingTaskId: task.id,
  });
  return task;
}

function savedTask(): ScheduledTask {
  return useScheduleStore.getState().tasks['task-1'];
}

describe('ScheduleEditor clearing optional settings', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('saves an emptied description', async () => {
    const user = userEvent.setup();
    openEditorOnTask({ description: 'Daily digest' });
    render(<ScheduleEditor />);

    await user.clear(screen.getByPlaceholderText('描述这个任务的目的...'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(savedTask().description).toBeUndefined();
  });

  it('saves the skill switched to none', async () => {
    const user = userEvent.setup();
    openEditorOnTask({ skillName: 'report' });
    render(<ScheduleEditor />);

    await user.click(screen.getByRole('button', { name: 'report' }));
    await user.click(screen.getByRole('button', { name: '不绑定' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(savedTask().skillName).toBeUndefined();
  });

  it('saves the project switched to none', async () => {
    const user = userEvent.setup();
    openEditorOnTask({ projectId: project.id, workspacePath: project.workspacePath });
    render(<ScheduleEditor />);

    await user.click(screen.getByRole('button', { name: 'Alpha project' }));
    await user.click(screen.getByRole('button', { name: '不关联项目' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(savedTask().projectId).toBeUndefined();
  });

  it('saves an emptied workspace path', async () => {
    const user = userEvent.setup();
    openEditorOnTask({ workspacePath: '/workspace/alpha' });
    render(<ScheduleEditor />);

    await user.clear(screen.getByPlaceholderText('可选，指定工作目录'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(savedTask().workspacePath).toBeUndefined();
  });

  it('saves the push channel switched to none together with its recipients', async () => {
    const user = userEvent.setup();
    openEditorOnTask({ outputChannelId: channel.id, outputChatIds: 'chat-1', outputUserIds: 'user-1' });
    render(<ScheduleEditor />);

    await user.click(screen.getByRole('button', { name: 'Ops channel (feishu)' }));
    await user.click(screen.getByRole('button', { name: '不推送' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    const saved = savedTask();
    expect(saved.outputChannelId).toBeUndefined();
    expect(saved.outputChatIds).toBeUndefined();
    expect(saved.outputUserIds).toBeUndefined();
  });

  it('saves emptied push recipients while keeping the channel', async () => {
    const user = userEvent.setup();
    openEditorOnTask({ outputChannelId: channel.id, outputChatIds: 'chat-1', outputUserIds: 'user-1' });
    render(<ScheduleEditor />);

    await user.clear(screen.getByPlaceholderText('群 ID，多个用逗号分隔'));
    await user.clear(screen.getByPlaceholderText('用户 ID，多个用逗号分隔'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    const saved = savedTask();
    expect(saved.outputChannelId).toBe(channel.id);
    expect(saved.outputChatIds).toBeUndefined();
    expect(saved.outputUserIds).toBeUndefined();
  });

  it('saves the team switched to none', async () => {
    const user = userEvent.setup();
    openEditorOnTask({ teamId: team.id });
    render(<ScheduleEditor />);

    await user.click(screen.getByTestId('schedule-team-select'));
    await user.click(screen.getByTestId('search-select-option-'));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(savedTask().teamId).toBeUndefined();
  });

  it('keeps the optional settings when they are left untouched', async () => {
    const user = userEvent.setup();
    openEditorOnTask({
      description: 'Daily digest',
      skillName: 'report',
      workspacePath: project.workspacePath,
      projectId: project.id,
      outputChannelId: channel.id,
      outputChatIds: 'chat-1',
      outputUserIds: 'user-1',
      teamId: team.id,
    });
    render(<ScheduleEditor />);

    await user.click(screen.getByRole('button', { name: '保存' }));

    const saved = savedTask();
    expect(saved.description).toBe('Daily digest');
    expect(saved.skillName).toBe('report');
    expect(saved.workspacePath).toBe(project.workspacePath);
    expect(saved.projectId).toBe(project.id);
    expect(saved.outputChannelId).toBe(channel.id);
    expect(saved.outputChatIds).toBe('chat-1');
    expect(saved.outputUserIds).toBe('user-1');
    expect(saved.teamId).toBe(team.id);
  });
});
