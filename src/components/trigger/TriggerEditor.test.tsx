// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initLanguage } from '@/i18n';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTriggerStore } from '@/stores/triggerStore';
import type { Trigger, TriggerCapability, TriggerPermissions } from '@/types/trigger';
import TriggerEditor from './TriggerEditor';

const BASE_TIME = 1_700_000_000_000;

function makeTrigger(
  id: string,
  action: Trigger['action'],
): Trigger {
  return {
    id,
    name: `Trigger ${id}`,
    status: 'active',
    source: { type: 'http' },
    filter: { type: 'always' },
    action,
    debounce: { enabled: false, windowSeconds: 0 },
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    runs: [],
    totalRuns: 0,
  };
}

function resetStores() {
  useTriggerStore.setState({
    triggers: {},
    selectedTriggerId: null,
    showEditor: false,
    editingTriggerId: null,
    editorTemplateDefaults: null,
  });
  useDiscoveryStore.setState({ skills: [], agents: [], isLoading: false });
  useIMChannelStore.setState({ channels: {} });
  useProjectStore.setState({ projects: {} });
}

async function saveNewTrigger(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('例如：群消息告警处理'), 'Daily digest');
  await user.type(screen.getByPlaceholderText('收到事件后阿布要执行的指令...'), 'Summarize $EVENT_DATA');
  await user.click(screen.getByRole('button', { name: '保存' }));
}

async function selectCapability(user: ReturnType<typeof userEvent.setup>, currentLabel: string, nextLabel: string) {
  await user.click(screen.getByRole('button', { name: `自主程度: ${currentLabel}` }));
  await user.click(screen.getByRole('button', { name: nextLabel }));
}

describe('TriggerEditor capability level', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetStores();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('creates new triggers with read-only capability by default', async () => {
    const user = userEvent.setup();
    useTriggerStore.setState({ showEditor: true });

    render(<TriggerEditor />);

    expect(screen.getByRole('button', { name: '自主程度: 只看不动（默认）' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('可读取文件、搜索信息；不能修改文件、执行命令或操控浏览器。')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '自主程度: 只看不动（默认）' }));
    expect(screen.getByRole('button', { name: '自主程度: 只看不动（默认）' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { name: '自定义规则（保留现有配置）' })).not.toBeInTheDocument();

    await saveNewTrigger(user);

    const created = Object.values(useTriggerStore.getState().triggers)[0];
    expect(created.action.capability).toBe('read_tools');
    expect(created.action.permissions).toBeUndefined();
  });

  it('saves full capability when the user selects it', async () => {
    const user = userEvent.setup();
    useTriggerStore.setState({ showEditor: true });

    render(<TriggerEditor />);

    await selectCapability(user, '只看不动（默认）', '完全放开');
    expect(screen.getByText('可访问更广的路径和命令；系统级硬性拦截仍然生效。')).toBeInTheDocument();
    expect(screen.getByText(/完全放开只适合可信输入源/)).toBeInTheDocument();
    await saveNewTrigger(user);

    const created = Object.values(useTriggerStore.getState().triggers)[0];
    expect(created.action.capability).toBe('full');
  });

  it.each([
    ['safe_tools' as const, '常规'],
    ['full' as const, '完全放开'],
  ])('keeps %s when editing without downgrading', async (capability, label) => {
    const user = userEvent.setup();
    const trigger = makeTrigger('trigger-1', {
      prompt: 'Handle event',
      capability,
    });
    useTriggerStore.setState({
      triggers: { [trigger.id]: trigger },
      showEditor: true,
      editingTriggerId: trigger.id,
    });

    render(<TriggerEditor />);

    expect(screen.getByRole('button', { name: `自主程度: ${label}` })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `自主程度: ${label}` }));
    expect(screen.queryByRole('button', { name: '自定义规则（保留现有配置）' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(useTriggerStore.getState().triggers[trigger.id].action.capability).toBe(capability);
  });

  it('shows legacy custom mode and preserves permission values when unchanged', async () => {
    const user = userEvent.setup();
    const permissions: TriggerPermissions = {
      allowedCommands: ['npm run *'],
      allowedPaths: ['/tmp/workspace'],
      allowedTools: ['read_file'],
    };
    const trigger = makeTrigger('custom-trigger', {
      prompt: 'Handle custom',
      capability: 'custom',
      permissions,
    });
    useTriggerStore.setState({
      triggers: { [trigger.id]: trigger },
      showEditor: true,
      editingTriggerId: trigger.id,
    });

    render(<TriggerEditor />);

    expect(screen.getByRole('button', { name: '自主程度: 自定义规则（保留现有配置）' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));

    const updated = useTriggerStore.getState().triggers[trigger.id];
    expect(updated.action.capability).toBe('custom');
    expect(updated.action.permissions).toStrictEqual({
      allowedCommands: ['npm run *'],
      allowedPaths: ['/tmp/workspace'],
      allowedTools: ['read_file'],
    });
  });

  it('clears legacy custom permissions after switching to a standard level', async () => {
    const user = userEvent.setup();
    const permissions: TriggerPermissions = {
      allowedCommands: ['npm run *'],
      allowedPaths: ['/tmp/workspace'],
      allowedTools: ['read_file'],
    };
    const trigger = makeTrigger('custom-trigger', {
      prompt: 'Handle custom',
      capability: 'custom',
      permissions,
    });
    useTriggerStore.setState({
      triggers: { [trigger.id]: trigger },
      showEditor: true,
      editingTriggerId: trigger.id,
    });

    render(<TriggerEditor />);

    await selectCapability(user, '自定义规则（保留现有配置）', '常规');
    await user.click(screen.getByRole('button', { name: '保存' }));

    const updated = useTriggerStore.getState().triggers[trigger.id];
    expect(updated.action.capability).toBe('safe_tools');
    expect(updated.action.permissions).toBeUndefined();
  });

  it('keeps an unsaved downgrade when the trigger run state changes', async () => {
    const user = userEvent.setup();
    const trigger = makeTrigger('running-trigger', {
      prompt: 'Handle event',
      capability: 'full',
    });
    useTriggerStore.setState({
      triggers: { [trigger.id]: trigger },
      showEditor: true,
      editingTriggerId: trigger.id,
    });

    render(<TriggerEditor />);

    await selectCapability(user, '完全放开', '只看不动（默认）');
    act(() => {
      useTriggerStore.getState().startRun(trigger.id, 'conversation-1', 'event');
    });

    expect(screen.getByRole('button', { name: '自主程度: 只看不动（默认）' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(useTriggerStore.getState().triggers[trigger.id].action.capability).toBe('read_tools');
  });

  it.each(['future_tier', '__proto__'])('fails closed for malformed persisted capability %s', async (persistedCapability) => {
    const user = userEvent.setup();
    const trigger = makeTrigger('malformed-trigger', {
      prompt: 'Handle event',
      capability: persistedCapability as TriggerCapability,
    });
    useTriggerStore.setState({
      triggers: { [trigger.id]: trigger },
      showEditor: true,
      editingTriggerId: trigger.id,
    });

    render(<TriggerEditor />);

    expect(screen.getByRole('button', { name: '自主程度: 只看不动（默认）' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(useTriggerStore.getState().triggers[trigger.id].action.capability).toBe('read_tools');
  });
});
