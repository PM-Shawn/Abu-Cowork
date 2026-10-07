// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { outputSender } from '@/core/im/outputSender';
import { getI18n, initLanguage } from '@/i18n';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useProjectStore } from '@/stores/projectStore';
import { useTriggerStore } from '@/stores/triggerStore';
import type { Trigger, TriggerCapability, TriggerPermissions } from '@/types/trigger';
import { passSettleInterval } from '@/test/dsWindows';
import TriggerEditor from './TriggerEditor';

vi.mock('@/core/trigger/triggerEngine', () => ({
  triggerEngine: { getServerPort: () => 18080 },
}));
vi.mock('@/core/im/outputSender', () => ({
  outputSender: { testSend: vi.fn() },
}));

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

// The autonomy level: a list that is closed until it is asked for.
const capabilityBox = () => screen.getByRole('combobox', { name: '自主程度' });

async function selectCapability(user: ReturnType<typeof userEvent.setup>, nextLabel: string) {
  await user.click(capabilityBox());
  await user.click(screen.getByRole('option', { name: nextLabel }));
}

beforeAll(() => {
  // happy-dom has none of these, and Radix Select calls them when its list opens.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

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

    renderEditor();

    // Held before the list opens: an open list hides the rest of the window from a screen reader.
    const box = capabilityBox();
    expect(box).toHaveTextContent('只看不动（默认）');
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('可读取文件、搜索信息；不能修改文件、执行命令或操控浏览器。')).toBeInTheDocument();
    await user.click(box);
    expect(box).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.queryByRole('option', { name: '自定义规则（保留现有配置）' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(box).toHaveAttribute('aria-expanded', 'false');

    await saveNewTrigger(user);

    const created = Object.values(useTriggerStore.getState().triggers)[0];
    expect(created.action.capability).toBe('read_tools');
    expect(created.action.permissions).toBeUndefined();
  });

  it('saves full capability when the user selects it', async () => {
    const user = userEvent.setup();
    useTriggerStore.setState({ showEditor: true });

    renderEditor();

    await selectCapability(user, '完全放开');
    expect(capabilityBox()).toHaveTextContent('完全放开');
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

    renderEditor();

    expect(capabilityBox()).toHaveTextContent(label);
    await user.click(capabilityBox());
    expect(screen.queryByRole('option', { name: '自定义规则（保留现有配置）' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
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

    renderEditor();

    expect(capabilityBox()).toHaveTextContent('自定义规则（保留现有配置）');
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

    renderEditor();

    await selectCapability(user, '常规');
    // The rules being left stay on offer until the window closes.
    await user.click(capabilityBox());
    expect(screen.getByRole('option', { name: '自定义规则（保留现有配置）' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
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

    renderEditor();

    await selectCapability(user, '只看不动（默认）');
    act(() => {
      useTriggerStore.getState().startRun(trigger.id, 'conversation-1', 'event');
    });

    expect(capabilityBox()).toHaveTextContent('只看不动（默认）');
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

    renderEditor();

    expect(capabilityBox()).toHaveTextContent('只看不动（默认）');
    await user.click(screen.getByRole('button', { name: '保存' }));
    expect(useTriggerStore.getState().triggers[trigger.id].action.capability).toBe('read_tools');
  });
});

const realActions = useTriggerStore.getState();
const createTrigger = vi.fn<typeof realActions.createTrigger>();
const updateTrigger = vi.fn<typeof realActions.updateTrigger>();
const testSend = vi.mocked(outputSender.testSend);

const stored = (id: string, name: string, extra: Partial<Trigger>): Trigger => ({
  ...makeTrigger(id, { prompt: 'Handle event' }),
  name,
  ...extra,
});

// A listener on a folder: keyword match, quiet hours, result pushed to a custom webhook, skill and project chosen.
const FILE_TRIGGER = stored('file-1', '日志监听', {
  description: '看日志',
  source: { type: 'file', path: '/fake/logs', events: ['create', 'delete'], pattern: '*.log' },
  filter: { type: 'keyword', keywords: ['error', 'alert'], field: 'data.content' },
  action: { prompt: '分析 $EVENT_DATA', skillName: 'log-skill', workspacePath: '/work/typed', capability: 'safe_tools' },
  debounce: { enabled: true, windowSeconds: 120 },
  quietHours: { enabled: true, start: '23:00', end: '07:00' },
  output: {
    enabled: true,
    target: 'webhook',
    platform: 'custom',
    webhookUrl: 'https://example.invalid/hook',
    extractMode: 'custom_template',
    customTemplate: '$AI_RESPONSE',
    customHeaders: { Authorization: 'Bearer sk-test-not-a-secret' },
  },
  projectId: 'project-1',
});

// A listener on an IM channel: regex match, fully open, result pushed back through the channel.
const IM_TRIGGER = stored('im-1', '群消息', {
  source: { type: 'im', channelId: 'channel-1', listenScope: 'direct_only', chatId: 'chat-9', senderMatch: 'bot' },
  filter: { type: 'regex', pattern: 'P[01]' },
  action: { prompt: '处理', capability: 'full' },
  debounce: { enabled: false, windowSeconds: 0 },
  output: {
    enabled: true,
    target: 'im_channel',
    outputChannelId: 'channel-1',
    outputChatIds: 'chat-a, chat-b',
    outputUserIds: 'user-a',
    extractMode: 'full',
  },
});

const CRON_TRIGGER = stored('cron-1', '巡检', {
  source: { type: 'cron', intervalSeconds: 5 },
  action: { prompt: '检查', capability: 'read_tools' },
});

const seedChoices = () => {
  useDiscoveryStore.setState({
    skills: [
      { name: 'log-skill', userInvocable: true },
      { name: 'internal-only', userInvocable: false },
    ] as never,
  });
  useProjectStore.setState({
    projects: {
      'project-1': { id: 'project-1', name: '官网改版', workspacePath: '/work/site', archived: false, lastActiveAt: 2 },
    } as never,
  });
  useIMChannelStore.setState({
    channels: { 'channel-1': { id: 'channel-1', name: '运营群', platform: 'feishu' } } as never,
  });
};

const openEditor = (...args: Parameters<typeof realActions.openEditor>) => useTriggerStore.getState().openEditor(...args);
const renderEditor = () => render(<DesignSystemProvider><TriggerEditor /></DesignSystemProvider>);
const nameField = () => screen.getByPlaceholderText('例如：群消息告警处理');
const promptField = () => screen.getByPlaceholderText('收到事件后阿布要执行的指令...');
const saveButton = () => screen.getByRole('button', { name: '保存' });
const timeFields = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="time"]'));
// One choice of a row of choices (source, match rule, where the result goes).
const choice = (name: string) => screen.getByRole('radio', { name });
const select = (name: string) => screen.getByRole('combobox', { name });
const pick = async (user: ReturnType<typeof userEvent.setup>, name: string, option: string) => {
  await user.click(select(name));
  await user.click(screen.getByRole('option', { name: option }));
};
const ds = () => getI18n().designSystem;
const classes = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/);

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}
const closingWindow = () => document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]')!;

describe('TriggerEditor', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetStores();
    createTrigger.mockReset();
    createTrigger.mockImplementation(realActions.createTrigger);
    updateTrigger.mockReset();
    updateTrigger.mockImplementation(realActions.updateTrigger);
    testSend.mockReset();
    useTriggerStore.setState({ createTrigger, updateTrigger });
  });

  afterEach(() => {
    cleanup();
    useTriggerStore.setState({ createTrigger: realActions.createTrigger, updateTrigger: realActions.updateTrigger });
    resetStores();
  });

  describe('what a save hands to the store', () => {
    it('creates a listener with exactly the defaults when only a name and a prompt are typed', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();

      await user.type(nameField(), '  Daily digest ');
      await user.type(promptField(), ' Summarize $EVENT_DATA ');
      await user.click(saveButton());

      expect(updateTrigger).not.toHaveBeenCalled();
      expect(createTrigger).toHaveBeenCalledTimes(1);
      expect(createTrigger.mock.calls[0][0]).toStrictEqual({
        name: 'Daily digest',
        description: undefined,
        source: { type: 'http' },
        filter: { type: 'always', keywords: undefined, pattern: undefined, field: undefined },
        action: { prompt: 'Summarize $EVENT_DATA', skillName: undefined, workspacePath: undefined, capability: 'read_tools', permissions: undefined },
        debounce: { enabled: true, windowSeconds: 300 },
        quietHours: undefined,
        output: undefined,
        projectId: undefined,
      });
      // The new listener is the one in view afterwards, and the window has closed.
      const created = Object.values(useTriggerStore.getState().triggers)[0];
      expect(useTriggerStore.getState().selectedTriggerId).toBe(created.id);
      expect(useTriggerStore.getState().showEditor).toBe(false);
    });

    it('hands back a folder listener untouched, every field as it was stored', async () => {
      const user = userEvent.setup();
      seedChoices();
      useTriggerStore.setState({ triggers: { [FILE_TRIGGER.id]: FILE_TRIGGER } });
      openEditor(FILE_TRIGGER.id);
      renderEditor();

      await user.click(saveButton());

      expect(createTrigger).not.toHaveBeenCalled();
      expect(updateTrigger).toHaveBeenCalledTimes(1);
      expect(updateTrigger.mock.calls[0][0]).toBe('file-1');
      expect(updateTrigger.mock.calls[0][1]).toStrictEqual({
        name: '日志监听',
        description: '看日志',
        source: { type: 'file', path: '/fake/logs', events: ['create', 'delete'], pattern: '*.log' },
        filter: { type: 'keyword', keywords: ['error', 'alert'], pattern: undefined, field: 'data.content' },
        // The folder of the project wins over the one typed.
        action: { prompt: '分析 $EVENT_DATA', skillName: 'log-skill', workspacePath: '/work/site', capability: 'safe_tools', permissions: undefined },
        debounce: { enabled: true, windowSeconds: 120 },
        quietHours: { enabled: true, start: '23:00', end: '07:00' },
        output: {
          enabled: true,
          target: 'webhook',
          platform: 'custom',
          webhookUrl: 'https://example.invalid/hook',
          outputChannelId: undefined,
          outputChatIds: undefined,
          outputUserIds: undefined,
          extractMode: 'custom_template',
          customTemplate: '$AI_RESPONSE',
          customHeaders: { Authorization: 'Bearer sk-test-not-a-secret' },
        },
        projectId: 'project-1',
      });
      expect(useTriggerStore.getState().showEditor).toBe(false);
    });

    it('hands back an IM listener untouched, every field as it was stored', async () => {
      const user = userEvent.setup();
      seedChoices();
      useTriggerStore.setState({ triggers: { [IM_TRIGGER.id]: IM_TRIGGER } });
      openEditor(IM_TRIGGER.id);
      renderEditor();

      await user.click(saveButton());

      expect(updateTrigger.mock.calls[0][0]).toBe('im-1');
      expect(updateTrigger.mock.calls[0][1]).toStrictEqual({
        name: '群消息',
        description: undefined,
        source: { type: 'im', channelId: 'channel-1', listenScope: 'direct_only', chatId: 'chat-9', senderMatch: 'bot' },
        filter: { type: 'regex', keywords: undefined, pattern: 'P[01]', field: undefined },
        action: { prompt: '处理', skillName: undefined, workspacePath: undefined, capability: 'full', permissions: undefined },
        debounce: { enabled: false, windowSeconds: 0 },
        quietHours: undefined,
        output: {
          enabled: true,
          target: 'im_channel',
          platform: undefined,
          webhookUrl: undefined,
          outputChannelId: 'channel-1',
          outputChatIds: 'chat-a, chat-b',
          outputUserIds: 'user-a',
          extractMode: 'full',
          customTemplate: undefined,
          customHeaders: undefined,
        },
        projectId: undefined,
      });
    });

    it('saves a timed listener with an interval of at least ten seconds', async () => {
      const user = userEvent.setup();
      useTriggerStore.setState({ triggers: { [CRON_TRIGGER.id]: CRON_TRIGGER } });
      openEditor(CRON_TRIGGER.id);
      renderEditor();

      await user.click(saveButton());

      expect(updateTrigger.mock.calls[0][1]).toStrictEqual({
        name: '巡检',
        description: undefined,
        source: { type: 'cron', intervalSeconds: 10 },
        filter: { type: 'always', keywords: undefined, pattern: undefined, field: undefined },
        action: { prompt: '检查', skillName: undefined, workspacePath: undefined, capability: 'read_tools', permissions: undefined },
        debounce: { enabled: false, windowSeconds: 0 },
        quietHours: undefined,
        output: undefined,
        projectId: undefined,
      });
    });

    it('opens a template with its name, prompt, source, match rule and keywords filled in', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: '告警', sourceType: 'http', filterType: 'keyword', prompt: '处理 $EVENT_DATA', keywords: 'error, alert，P0' });
      renderEditor();

      expect(nameField()).toHaveValue('告警');
      expect(promptField()).toHaveValue('处理 $EVENT_DATA');
      expect(screen.getByPlaceholderText('多个关键词用逗号分隔')).toHaveValue('error, alert，P0');
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0]).toMatchObject({
        name: '告警',
        source: { type: 'http' },
        filter: { type: 'keyword', keywords: ['error', 'alert', 'P0'], pattern: undefined, field: undefined },
      });
    });
  });

  describe('when a save is possible', () => {
    it('needs a name and a prompt', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();

      expect(saveButton()).toBeDisabled();
      await user.type(nameField(), 'Daily');
      expect(saveButton()).toBeDisabled();
      await user.type(promptField(), '   ');
      expect(saveButton()).toBeDisabled();
      await user.type(promptField(), 'go');
      expect(saveButton()).toBeEnabled();
    });

    it('needs a folder for a folder listener', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: '日志', sourceType: 'file', prompt: '分析' });
      renderEditor();

      expect(saveButton()).toBeDisabled();
      await user.click(saveButton());
      expect(createTrigger).not.toHaveBeenCalled();

      await user.type(screen.getByPlaceholderText('输入要监听的文件或目录路径'), '/fake/logs');
      expect(saveButton()).toBeEnabled();
      await user.click(saveButton());
      expect(createTrigger.mock.calls[0][0].source).toStrictEqual({ type: 'file', path: '/fake/logs', events: ['create', 'modify'], pattern: undefined });
    });

    it('needs a channel for an IM listener, and says where to add one when there is none', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: '群消息', sourceType: 'im', prompt: '处理' });
      renderEditor();

      expect(screen.getByText('请先在设置 → IM 频道中添加频道')).toBeVisible();
      expect(saveButton()).toBeDisabled();
      await user.click(saveButton());
      expect(createTrigger).not.toHaveBeenCalled();
    });

    it('refuses a name another listener has, and says so; the listener being edited keeps its own', async () => {
      const user = userEvent.setup();
      useTriggerStore.setState({ triggers: { [CRON_TRIGGER.id]: CRON_TRIGGER } });
      openEditor(undefined, { name: '巡检', prompt: '检查' });
      renderEditor();

      expect(screen.getByText('已存在同名触发器')).toBeVisible();
      expect(saveButton()).toBeDisabled();
      await user.type(nameField(), '二');
      expect(screen.queryByText('已存在同名触发器')).toBeNull();
      expect(saveButton()).toBeEnabled();

      act(() => useTriggerStore.getState().closeEditor());
      act(() => openEditor(CRON_TRIGGER.id));
      expect(nameField()).toHaveValue('巡检');
      expect(screen.queryByText('已存在同名触发器')).toBeNull();
      expect(saveButton()).toBeEnabled();
    });
  });

  describe('fields that show once their box is ticked', () => {
    it('shows the debounce window while debounce is on, and saves it off without one', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      const debounce = screen.getByRole('checkbox', { name: '防抖（相同内容去重）' });

      expect(debounce).toBeChecked();
      expect(screen.getByRole('spinbutton')).toHaveValue(300);

      await user.click(debounce);
      expect(debounce).not.toBeChecked();
      expect(screen.queryByRole('spinbutton')).toBeNull();
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].debounce).toStrictEqual({ enabled: false, windowSeconds: 300 });
    });

    it('shows the quiet hours once they are on, and saves them', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      const quiet = screen.getByRole('checkbox', { name: '静默时段（该时段内不触发）' });

      expect(quiet).not.toBeChecked();
      expect(timeFields()).toHaveLength(0);
      expect(screen.queryByText('支持跨午夜，如 22:00 ~ 08:00')).toBeNull();

      await user.click(quiet);
      expect(timeFields().map((field) => field.value)).toEqual(['22:00', '08:00']);
      expect(screen.getByText('支持跨午夜，如 22:00 ~ 08:00')).toBeVisible();
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].quietHours).toStrictEqual({ enabled: true, start: '22:00', end: '08:00' });
    });

    it('shows where the result goes once pushing is on, and tries the webhook on request', async () => {
      const user = userEvent.setup();
      testSend.mockResolvedValue({ success: true });
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      const push = screen.getByRole('checkbox', { name: '处理完成后推送结果' });

      expect(push).not.toBeChecked();
      expect(screen.queryByPlaceholderText('https://...')).toBeNull();

      await user.click(push);
      expect(screen.getByRole('radio', { name: '最后一条 AI 回复' })).toBeChecked();
      expect(screen.getByRole('button', { name: '测试推送' })).toBeDisabled();
      await user.type(screen.getByPlaceholderText('https://...'), 'https://example.invalid/hook');
      await user.click(screen.getByRole('button', { name: '测试推送' }));

      expect(testSend).toHaveBeenCalledTimes(1);
      expect(testSend).toHaveBeenCalledWith('dchat', 'https://example.invalid/hook', undefined);
      expect(await screen.findByText('推送成功')).toBeVisible();

      await user.click(saveButton());
      expect(createTrigger.mock.calls[0][0].output).toStrictEqual({
        enabled: true,
        target: 'webhook',
        platform: 'dchat',
        webhookUrl: 'https://example.invalid/hook',
        outputChannelId: undefined,
        outputChatIds: undefined,
        outputUserIds: undefined,
        extractMode: 'last_message',
        customTemplate: undefined,
        customHeaders: undefined,
      });
    });

    it('says why a webhook try failed', async () => {
      const user = userEvent.setup();
      testSend.mockResolvedValue({ success: false, error: 'HTTP 500' });
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();

      await user.click(screen.getByRole('checkbox', { name: '处理完成后推送结果' }));
      await user.type(screen.getByPlaceholderText('https://...'), 'https://example.invalid/hook');
      await user.click(screen.getByRole('button', { name: '测试推送' }));

      expect(await screen.findByText('推送失败: HTTP 500')).toBeVisible();
    });
  });

  describe('the window', () => {
    it('shows nothing until it is opened, then is a dialog named after what it does', () => {
      renderEditor();
      expect(screen.queryByRole('dialog')).toBeNull();

      act(() => openEditor());
      expect(screen.getByRole('dialog', { name: '新建监听' })).toBeVisible();
      expect(screen.getByRole('heading', { name: '新建监听' })).toBeVisible();
      expect(screen.getByRole('button', { name: '关闭' })).toBeVisible();
    });

    it('is named for editing when it opens on a listener', () => {
      useTriggerStore.setState({ triggers: { [CRON_TRIGGER.id]: CRON_TRIGGER } });
      openEditor(CRON_TRIGGER.id);
      renderEditor();
      expect(screen.getByRole('dialog', { name: '编辑监听' })).toBeVisible();
    });

    it('closes on 取消 with nothing saved', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();

      await user.click(screen.getByRole('button', { name: '取消' }));

      expect(useTriggerStore.getState().showEditor).toBe(false);
      expect(createTrigger).not.toHaveBeenCalled();
    });

    it('asks before it discards what was typed, on Escape and on 取消', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();
      await user.type(nameField(), '晨报');

      await user.keyboard('{Escape}');
      expect(screen.getByRole('alertdialog', { name: ds().discardTitle })).toBeVisible();
      expect(useTriggerStore.getState().showEditor).toBe(true);

      // The question takes no pointer press for a moment after it appears: it has been read.
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: ds().keepEditing }));
      expect(useTriggerStore.getState().showEditor).toBe(true);
      expect(nameField()).toHaveValue('晨报');

      await user.click(screen.getByRole('button', { name: '取消' }));
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: ds().discard }));
      expect(useTriggerStore.getState().showEditor).toBe(false);
      expect(createTrigger).not.toHaveBeenCalled();
    });

    it('asks nothing when a template was opened and left as it is, or a changed choice is back to what it was', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: '告警', sourceType: 'http', filterType: 'keyword', prompt: '处理', keywords: 'error' });
      renderEditor();
      await user.click(choice('文件变更'));
      await user.click(screen.getByRole('checkbox', { name: '删除' }));
      await user.click(screen.getByRole('checkbox', { name: '删除' }));
      await user.click(choice('HTTP 接收'));

      await user.keyboard('{Escape}');

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(useTriggerStore.getState().showEditor).toBe(false);
    });

    it('saves nothing from the window while it fades out, and keeps showing what it showed', async () => {
      const user = userEvent.setup();
      const fading = keepClosingLayersOnScreen();
      try {
        seedChoices();
        useTriggerStore.setState({ triggers: { [FILE_TRIGGER.id]: FILE_TRIGGER } });
        openEditor(FILE_TRIGGER.id);
        renderEditor();
        await user.clear(nameField());
        await user.type(nameField(), '日志监听二');

        act(() => useTriggerStore.getState().closeEditor());

        const closing = closingWindow();
        expect(within(closing).getByRole('heading', { name: '编辑监听' })).toBeInTheDocument();
        expect(within(closing).getByPlaceholderText('例如：群消息告警处理')).toHaveValue('日志监听二');
        expect(within(closing).getByPlaceholderText('输入要监听的文件或目录路径')).toHaveValue('/fake/logs');
        expect(within(closing).queryByText('已存在同名触发器')).toBeNull();
        fireEvent.click(within(closing).getByRole('button', { name: '保存' }));

        expect(updateTrigger).not.toHaveBeenCalled();
        expect(createTrigger).not.toHaveBeenCalled();
      } finally {
        fading.mockRestore();
      }
    });

    it('sends no test push from the window while it fades out', async () => {
      const fading = keepClosingLayersOnScreen();
      try {
        seedChoices();
        useTriggerStore.setState({ triggers: { [FILE_TRIGGER.id]: FILE_TRIGGER } });
        openEditor(FILE_TRIGGER.id);
        renderEditor();

        act(() => useTriggerStore.getState().closeEditor());
        fireEvent.click(within(closingWindow()).getByRole('button', { name: '测试推送' }));
        await act(async () => { await Promise.resolve(); });

        expect(testSend).not.toHaveBeenCalled();
      } finally {
        fading.mockRestore();
      }
    });

    it('starts empty again after a listener was edited', async () => {
      const user = userEvent.setup();
      seedChoices();
      useTriggerStore.setState({ triggers: { [FILE_TRIGGER.id]: FILE_TRIGGER } });
      openEditor(FILE_TRIGGER.id);
      renderEditor();
      await user.click(screen.getByRole('button', { name: '取消' }));
      expect(useTriggerStore.getState().showEditor).toBe(false);

      act(() => openEditor());

      expect(screen.getByRole('heading', { name: '新建监听' })).toBeVisible();
      expect(nameField()).toHaveValue('');
      expect(promptField()).toHaveValue('');
      expect(choice('HTTP 接收')).toBeChecked();
      expect(capabilityBox()).toHaveTextContent('只看不动（默认）');
    });

    it('is the wide window, so the row of four sources fits in English as well', () => {
      openEditor();
      renderEditor();
      expect(classes(screen.getByRole('dialog', { name: '新建监听' }))).toContain('max-w-2xl');
    });

    it('has one filled button, the one that saves', () => {
      openEditor();
      renderEditor();
      expect(classes(saveButton())).toContain('bg-emphasis');
      expect(classes(screen.getByRole('button', { name: '取消' }))).not.toContain('bg-emphasis');
    });
  });

  describe('the autonomy level', () => {
    it('explains each level in the open list, under the name of the level', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();

      await user.click(capabilityBox());

      expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-describedby') && document.getElementById(option.getAttribute('aria-describedby')!)!.textContent)).toEqual([
        '可读取文件、搜索信息；不能修改文件、执行命令或操控浏览器。',
        '可通过受控工具读取和修改所选工作区；命令执行和范围外访问会被拒绝。',
        '可访问更广的路径和命令；系统级硬性拦截仍然生效。',
      ]);
      expect(screen.getByRole('option', { name: '只看不动（默认）' })).toHaveAttribute('aria-selected', 'true');
      await user.keyboard('{Escape}');
    });

    it('only opens the list on an arrow key, and keeps the level when the list is closed again', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      // Held before the list opens: an open list hides the rest of the window from a screen reader.
      const box = capabilityBox();
      box.focus();

      await user.keyboard('{ArrowDown}');
      expect(box).toHaveAttribute('aria-expanded', 'true');
      expect(box).toHaveTextContent('只看不动（默认）');

      // Inside the list the arrow keys move the highlight; nothing is chosen.
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(box).toHaveTextContent('只看不动（默认）');
      await user.keyboard('{Escape}');
      expect(box).toHaveAttribute('aria-expanded', 'false');
      expect(box).toHaveTextContent('只看不动（默认）');
      expect(screen.queryByText(/完全放开只适合可信输入源/)).toBeNull();
      // The window is still there: Escape closed the list only.
      expect(useTriggerStore.getState().showEditor).toBe(true);

      await user.click(saveButton());
      expect(createTrigger.mock.calls[0][0].action.capability).toBe('read_tools');
    });

    it('takes no level from a letter typed on the closed list', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      capabilityBox().focus();

      await user.keyboard('完常f');

      expect(capabilityBox()).toHaveTextContent('只看不动（默认）');
      await user.click(saveButton());
      expect(createTrigger.mock.calls[0][0].action.capability).toBe('read_tools');
    });

    it('takes the highlighted level on Enter', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      capabilityBox().focus();

      await user.keyboard('{ArrowDown}');
      await user.keyboard('{ArrowDown}{ArrowDown}');
      await user.keyboard('{Enter}');

      expect(capabilityBox()).toHaveAttribute('aria-expanded', 'false');
      expect(capabilityBox()).toHaveTextContent('完全放开');
      await user.click(saveButton());
      expect(createTrigger.mock.calls[0][0].action.capability).toBe('full');
    });

    it.each([
      ['read_tools', '只看不动（默认）'],
      ['safe_tools', '常规'],
      ['full', '完全放开'],
    ] as const)('saves exactly the level picked: %s', async (level, label) => {
      const user = userEvent.setup();
      // Opens on another level, so each of the three is a real pick.
      const start = level === 'read_tools' ? 'full' : 'read_tools';
      const trigger = { ...CRON_TRIGGER, action: { prompt: '检查', capability: start } } as Trigger;
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      openEditor(trigger.id);
      renderEditor();

      await selectCapability(user, label);
      await user.click(saveButton());

      expect(updateTrigger.mock.calls[0][1].action).toStrictEqual({
        prompt: '检查', skillName: undefined, workspacePath: undefined, capability: level, permissions: undefined,
      });
    });

    it('warns under the list while the fully open level is chosen, and only then', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();
      expect(screen.queryByText(/完全放开只适合可信输入源/)).toBeNull();

      await selectCapability(user, '完全放开');
      const warning = screen.getByText(/完全放开只适合可信输入源/).closest('[role="status"]')!;
      expect(classes(warning)).toContain('bg-warning-soft');
      expect(warning.querySelector('svg')).not.toBeNull();
      expect(screen.getByText('触发器会无人值守执行；超出所选自主程度的操作会被直接拒绝，并在执行结果中写明原因。')).toBeVisible();

      await selectCapability(user, '常规');
      expect(screen.queryByText(/完全放开只适合可信输入源/)).toBeNull();
    });
  });

  describe('choices in a row', () => {
    it('offers the source as one row of choices; arrow keys move along it and choose nothing', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      const row = screen.getByRole('group', { name: '触发方式' });
      expect(within(row).getAllByRole('radio').map((item) => item.textContent)).toEqual(['HTTP 接收', '文件变更', '定时触发', 'IM 消息源']);
      expect(choice('HTTP 接收')).toBeChecked();

      choice('HTTP 接收').focus();
      await user.keyboard('{ArrowRight}');
      expect(choice('文件变更')).toHaveFocus();
      expect(choice('HTTP 接收')).toBeChecked();
      expect(screen.queryByPlaceholderText('输入要监听的文件或目录路径')).toBeNull();

      await user.keyboard(' ');
      expect(choice('文件变更')).toBeChecked();
      expect(screen.getByPlaceholderText('输入要监听的文件或目录路径')).toBeVisible();

      // Pressing the chosen one again keeps it.
      await user.click(choice('文件变更'));
      expect(choice('文件变更')).toBeChecked();
    });

    it('offers the match rule as one row of choices; arrow keys choose nothing', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      const row = screen.getByRole('group', { name: '触发条件' });
      expect(within(row).getAllByRole('radio').map((item) => item.textContent)).toEqual(['所有事件', '关键词匹配', '正则匹配']);

      choice('所有事件').focus();
      await user.keyboard('{ArrowRight}{ArrowRight}');
      expect(choice('所有事件')).toBeChecked();
      expect(screen.queryByPlaceholderText('例如：error|alert|warning')).toBeNull();

      await user.keyboard('{Enter}');
      expect(choice('正则匹配')).toBeChecked();
      const pattern = screen.getByPlaceholderText('例如：error|alert|warning');
      expect(classes(pattern)).toContain('font-code');
      await user.type(pattern, 'P[[01]');
      await user.type(screen.getByPlaceholderText('要匹配的 JSON 字段路径，如 data.content'), 'data.level');
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].filter).toStrictEqual({ type: 'regex', keywords: undefined, pattern: 'P[01]', field: 'data.level' });
    });

    it('ticks the file events one by one, in the order they were ticked', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P', sourceType: 'file' });
      renderEditor();
      await user.type(screen.getByPlaceholderText('输入要监听的文件或目录路径'), '/fake/logs');
      await user.type(screen.getByPlaceholderText('例如：*.log 或 *.csv（留空监听全部）'), '*.log');

      expect(screen.getByRole('checkbox', { name: '创建' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: '修改' })).toBeChecked();
      expect(screen.getByRole('checkbox', { name: '删除' })).not.toBeChecked();

      await user.click(screen.getByRole('checkbox', { name: '删除' }));
      await user.click(screen.getByRole('checkbox', { name: '创建' }));
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].source).toStrictEqual({ type: 'file', path: '/fake/logs', events: ['modify', 'delete'], pattern: '*.log' });
    });

    it('takes the interval of a timed listener from a number field', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P', sourceType: 'cron' });
      renderEditor();
      await user.click(screen.getByRole('checkbox', { name: '防抖（相同内容去重）' }));
      const interval = screen.getByRole('spinbutton');
      expect(interval).toHaveValue(60);
      expect(interval).toHaveAttribute('min', '10');

      // An emptied field falls back to sixty at once, so the new number replaces the old in one change.
      fireEvent.change(interval, { target: { value: '90' } });
      expect(interval).toHaveValue(90);
      fireEvent.change(interval, { target: { value: '' } });
      expect(interval).toHaveValue(60);
      fireEvent.change(interval, { target: { value: '90' } });
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].source).toStrictEqual({ type: 'cron', intervalSeconds: 90 });
    });
  });

  describe('an IM listener', () => {
    it('picks the channel from a list and the scope from a group of choices', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor(undefined, { name: 'N', prompt: 'P', sourceType: 'im' });
      renderEditor();
      expect(saveButton()).toBeDisabled();

      await pick(user, '选择 IM 频道', '运营群 (feishu)');
      expect(saveButton()).toBeEnabled();

      const scope = screen.getByRole('radiogroup', { name: '监听范围' });
      expect(within(scope).getAllByRole('radio').map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
      expect(screen.getByRole('radio', { name: '仅 @Abu 消息' })).toBeChecked();
      await user.click(screen.getByRole('radio', { name: '所有消息' }));
      await user.type(screen.getByPlaceholderText('从 IM 平台复制群 ID，不填=所有群'), 'chat-9');
      await user.type(screen.getByPlaceholderText('机器人名称或 ID'), 'bot');
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].source).toStrictEqual({ type: 'im', channelId: 'channel-1', listenScope: 'all', chatId: 'chat-9', senderMatch: 'bot' });
    });

    it('asks for a channel in the box when the channel of a listener was deleted, and still saves the stored one', async () => {
      const user = userEvent.setup();
      seedChoices();
      const trigger = { ...IM_TRIGGER, source: { type: 'im', channelId: 'gone-channel', listenScope: 'all' } } as Trigger;
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      openEditor(trigger.id);
      renderEditor();

      expect(select('选择 IM 频道')).toHaveTextContent(/^选择 IM 频道$/);
      expect(saveButton()).toBeEnabled();
      await user.click(saveButton());

      expect(updateTrigger.mock.calls[0][1].source).toMatchObject({ type: 'im', channelId: 'gone-channel' });
    });

    it('shows the callback address of the chosen channel in a field that cannot be typed in, and copies it', async () => {
      const user = userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, 'writeText');
      seedChoices();
      openEditor(undefined, { name: 'N', prompt: 'P', sourceType: 'im' });
      renderEditor();
      expect(screen.queryByText('回调地址')).toBeNull();

      await pick(user, '选择 IM 频道', '运营群 (feishu)');
      const address = screen.getByLabelText('回调地址');
      expect(address).toHaveValue('http://127.0.0.1:18080/im/feishu/webhook');
      expect(address).toHaveAttribute('readonly');
      expect(classes(address)).toContain('font-code');
      expect(screen.getByText('将此地址配置到 IM 平台的机器人回调 URL 中')).toBeVisible();

      await user.click(screen.getByRole('button', { name: '复制地址' }));
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:18080/im/feishu/webhook');
    });
  });

  describe('where the result goes', () => {
    it('pushes through an IM channel picked from a list, and says that approvals go there too', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      await user.click(screen.getByRole('checkbox', { name: '处理完成后推送结果' }));

      const target = screen.getByRole('group', { name: '输出配置' });
      expect(within(target).getAllByRole('radio').map((item) => item.textContent)).toEqual(['推送到 Webhook', '推送到 IM 频道']);
      expect(choice('推送到 Webhook')).toBeChecked();
      await user.click(choice('推送到 IM 频道'));
      expect(screen.queryByPlaceholderText('https://...')).toBeNull();
      expect(screen.getByText(/运行中需要你确认的操作也会发到这里/)).toBeVisible();

      await pick(user, '选择推送频道', '运营群 (feishu)');
      await user.type(screen.getByPlaceholderText('群 ID，多个用逗号分隔，不填=回复来源群'), ' chat-a ');
      await user.type(screen.getByPlaceholderText('用户 ID，多个用逗号分隔'), 'user-a');
      const mode = screen.getByRole('radiogroup', { name: '结果提取' });
      await user.click(within(mode).getByRole('radio', { name: '自定义模板' }));
      const template = screen.getByPlaceholderText('$TRIGGER_NAME 处理完成：$AI_RESPONSE');
      expect(classes(template)).toContain('font-code');
      await user.type(template, '$AI_RESPONSE');
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].output).toStrictEqual({
        enabled: true,
        target: 'im_channel',
        platform: undefined,
        webhookUrl: undefined,
        outputChannelId: 'channel-1',
        outputChatIds: 'chat-a',
        outputUserIds: 'user-a',
        extractMode: 'custom_template',
        customTemplate: '$AI_RESPONSE',
        customHeaders: undefined,
      });
    });

    it('picks the webhook platform from a list, and takes headers for the plain HTTP one', async () => {
      const user = userEvent.setup();
      testSend.mockResolvedValue({ success: true });
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      await user.click(screen.getByRole('checkbox', { name: '处理完成后推送结果' }));
      expect(screen.queryByPlaceholderText('Authorization: Bearer sk-xxx')).toBeNull();

      await pick(user, '推送平台', 'HTTP');
      await user.type(screen.getByPlaceholderText('https://...'), 'https://example.invalid/hook');
      const headers = screen.getByPlaceholderText('Authorization: Bearer sk-xxx');
      expect(classes(headers)).toContain('font-code');
      await user.type(headers, 'Authorization: Bearer sk-test-not-a-secret');
      await user.click(screen.getByRole('button', { name: '测试推送' }));
      expect(testSend).toHaveBeenCalledWith('custom', 'https://example.invalid/hook', { Authorization: 'Bearer sk-test-not-a-secret' });
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].output).toMatchObject({
        target: 'webhook',
        platform: 'custom',
        webhookUrl: 'https://example.invalid/hook',
        customHeaders: { Authorization: 'Bearer sk-test-not-a-secret' },
      });
    });

    it('asks for a platform in the box of a new listener, whose stored platform is not on offer, and still saves that platform', async () => {
      const user = userEvent.setup();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      await user.click(screen.getByRole('checkbox', { name: '处理完成后推送结果' }));

      expect(select('推送平台')).toHaveTextContent(/^推送平台$/);
      expect(select('推送平台')).toHaveAttribute('data-placeholder');
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].output).toMatchObject({ target: 'webhook', platform: 'dchat' });
    });

    it('asks for a channel in the box when the push channel of a listener was deleted, and still saves the stored one', async () => {
      const user = userEvent.setup();
      seedChoices();
      const trigger = { ...IM_TRIGGER, output: { ...IM_TRIGGER.output!, outputChannelId: 'gone-channel' } };
      useTriggerStore.setState({ triggers: { [trigger.id]: trigger } });
      openEditor(trigger.id);
      renderEditor();

      expect(select('选择推送频道')).toHaveTextContent(/^选择推送频道$/);
      await user.click(saveButton());

      expect(updateTrigger.mock.calls[0][1].output).toMatchObject({ outputChannelId: 'gone-channel' });
    });

    it('keeps the focus on the test button while the push is on its way: it is busy, never disabled', async () => {
      const user = userEvent.setup();
      let finish: (result: { success: boolean }) => void = () => undefined;
      testSend.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      await user.click(screen.getByRole('checkbox', { name: '处理完成后推送结果' }));
      await user.type(screen.getByPlaceholderText('https://...'), 'https://example.invalid/hook');
      const test = screen.getByRole('button', { name: '测试推送' });

      await user.click(test);
      expect(test).toHaveAttribute('aria-disabled', 'true');
      expect(test).not.toBeDisabled();
      expect(test).toHaveFocus();
      await user.click(test);
      expect(testSend).toHaveBeenCalledTimes(1);

      await act(async () => { finish({ success: true }); });
      expect(test).not.toHaveAttribute('aria-disabled');
    });
  });

  describe('skill, project and folder', () => {
    it('offers no skill or project list when there is none to pick', () => {
      openEditor();
      renderEditor();
      expect(screen.queryByRole('combobox', { name: '绑定技能' })).toBeNull();
      expect(screen.queryByRole('combobox', { name: '所属项目' })).toBeNull();
    });

    it('binds the skill picked, and none when the first entry is picked again', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      expect(select('绑定技能')).toHaveTextContent('不绑定');

      await user.click(select('绑定技能'));
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['不绑定', 'log-skill']);
      await user.click(screen.getByRole('option', { name: 'log-skill' }));
      await pick(user, '绑定技能', '不绑定');
      await pick(user, '绑定技能', 'log-skill');
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].action.skillName).toBe('log-skill');
    });

    it('takes the folder of the project picked and locks the folder field', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();
      await user.type(screen.getByLabelText('工作区路径'), '/work/typed');

      await pick(user, '所属项目', '官网改版');
      expect(screen.getByLabelText('工作区路径')).toHaveValue('/work/site');
      expect(screen.getByLabelText('工作区路径')).toBeDisabled();
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0]).toMatchObject({ projectId: 'project-1', action: { workspacePath: '/work/site' } });
    });

    it('keeps the folder of a project that is then taken off again', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor(undefined, { name: 'N', prompt: 'P' });
      renderEditor();

      await pick(user, '所属项目', '官网改版');
      await pick(user, '所属项目', '不关联项目');
      expect(screen.getByLabelText('工作区路径')).toBeEnabled();
      await user.click(saveButton());

      expect(createTrigger.mock.calls[0][0].projectId).toBeUndefined();
      expect(createTrigger.mock.calls[0][0].action.workspacePath).toBe('/work/site');
    });
  });

  it('marks a name another listener has on the field itself, and says so as an alert', () => {
    useTriggerStore.setState({ triggers: { [CRON_TRIGGER.id]: CRON_TRIGGER } });
    openEditor(undefined, { name: '巡检', prompt: '检查' });
    renderEditor();

    expect(nameField()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('已存在同名触发器');
  });

  it('names every field for a screen reader by the words shown above it', () => {
    openEditor();
    renderEditor();
    expect(screen.getByLabelText('触发器名称')).toBe(nameField());
    expect(screen.getByLabelText('执行指令')).toBe(promptField());
    expect(screen.getByLabelText('描述')).toHaveAttribute('placeholder', '描述这个触发器的用途...');
    expect(screen.getByText('使用 $EVENT_DATA 引用事件数据')).toBeVisible();
  });
});
