// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useProjectStore } from '@/stores/projectStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import type { ScheduledTask } from '@/types/schedule';
import ScheduleEditor from './ScheduleEditor';

const teams = vi.hoisted(() => ({ list: [] as Array<{ id: string; name: string; avatar?: string }> }));
vi.mock('@/core/team/useVisibleTeams', () => ({ useVisibleTeams: () => teams.list }));

const realActions = useScheduleStore.getState();
const createTask = vi.fn<typeof realActions.createTask>();
const updateTask = vi.fn<typeof realActions.updateTask>();

const FULL_TASK: ScheduledTask = {
  id: 'task-1',
  name: '周报',
  description: '每周三汇总',
  prompt: '汇总本周进展',
  schedule: { frequency: 'weekly', time: { hour: 14, minute: 30 }, dayOfWeek: 3 },
  status: 'active',
  skillName: 'weekly-report',
  teamId: 'team-1',
  workspacePath: '/work/typed',
  projectId: 'project-1',
  outputChannelId: 'channel-1',
  outputChatIds: 'chat-a, chat-b',
  outputUserIds: 'user-a',
  permissionMode: 'smart',
  createdAt: 1,
  updatedAt: 1,
  runs: [],
  totalRuns: 0,
};

const seedChoices = () => {
  teams.list = [{ id: 'team-1', name: '研究组' }];
  useDiscoveryStore.setState({
    skills: [
      { name: 'weekly-report', userInvocable: true },
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

const openEditor = (taskId?: string) => useScheduleStore.getState().openEditor(taskId);
const renderEditor = () => render(<DesignSystemProvider><ScheduleEditor /></DesignSystemProvider>);
const nameField = () => screen.getByPlaceholderText('例如：每日晨报');
const promptField = () => screen.getByPlaceholderText('输入阿布要执行的指令...');
const saveButton = () => screen.getByRole('button', { name: '保存' });
// One choice of the frequency row or of the weekday row.
const choice = (name: string) => screen.getByRole('radio', { name });
const select = (name: string) => screen.getByRole('combobox', { name });
const pick = async (user: ReturnType<typeof userEvent.setup>, name: string, option: string) => {
  await user.click(select(name));
  await user.click(screen.getByRole('option', { name: option }));
};
const ds = () => getI18n().designSystem;

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

beforeAll(() => {
  // happy-dom has none of these, and Radix Select calls them when its list opens.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

describe('ScheduleEditor', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    createTask.mockReset();
    updateTask.mockReset();
    teams.list = [];
    useDiscoveryStore.setState({ skills: [] });
    useProjectStore.setState({ projects: {} });
    useIMChannelStore.setState({ channels: {} });
    useScheduleStore.setState({ tasks: {}, selectedTaskId: null, showEditor: false, editingTaskId: null, createTask, updateTask });
  });

  afterEach(() => {
    cleanup();
    useScheduleStore.setState({ createTask: realActions.createTask, updateTask: realActions.updateTask });
  });

  it('shows nothing until it is opened', () => {
    renderEditor();
    expect(screen.queryByText('新建任务')).toBeNull();
    expect(screen.queryByPlaceholderText('例如：每日晨报')).toBeNull();
  });

  it('opens empty for a new task and cannot save without a name and a prompt', async () => {
    const user = userEvent.setup();
    openEditor();
    renderEditor();

    expect(screen.getByRole('heading', { name: '新建任务' })).toBeVisible();
    expect(nameField()).toHaveValue('');
    expect(promptField()).toHaveValue('');
    expect(screen.getByPlaceholderText('描述这个任务的目的...')).toHaveValue('');
    expect(screen.getByPlaceholderText('可选，指定工作目录')).toHaveValue('');
    expect(saveButton()).toBeDisabled();

    await user.type(nameField(), '晨报');
    expect(saveButton()).toBeDisabled();
    await user.type(promptField(), '   ');
    expect(saveButton()).toBeDisabled();
    await user.type(promptField(), '整理新闻');
    expect(saveButton()).toBeEnabled();

    await user.clear(nameField());
    expect(saveButton()).toBeDisabled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it('creates a daily 09:00 task with nothing optional set, then closes', async () => {
    const user = userEvent.setup();
    openEditor();
    renderEditor();

    await user.type(nameField(), '  晨报 ');
    await user.type(promptField(), ' 整理新闻 ');
    await user.click(saveButton());

    expect(updateTask).not.toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith({
      name: '晨报',
      description: undefined,
      prompt: '整理新闻',
      teamId: undefined,
      schedule: { frequency: 'daily', time: { hour: 9, minute: 0 }, dayOfWeek: undefined },
      skillName: undefined,
      workspacePath: undefined,
      projectId: undefined,
      outputChannelId: undefined,
      outputChatIds: undefined,
      outputUserIds: undefined,
      permissionMode: undefined,
    });
    expect(useScheduleStore.getState().showEditor).toBe(false);
  });

  it.each([
    ['每小时', { frequency: 'hourly', time: { hour: 9, minute: 0 }, dayOfWeek: undefined }],
    ['每周', { frequency: 'weekly', time: { hour: 9, minute: 0 }, dayOfWeek: 1 }],
    ['工作日', { frequency: 'weekdays', time: { hour: 9, minute: 0 }, dayOfWeek: undefined }],
    ['手动', { frequency: 'manual', time: undefined, dayOfWeek: undefined }],
  ])('saves the frequency %s', async (label, schedule) => {
    const user = userEvent.setup();
    openEditor();
    renderEditor();
    await user.type(nameField(), '晨报');
    await user.type(promptField(), '整理新闻');

    await user.click(choice(label));
    await user.click(saveButton());

    expect(createTask.mock.calls[0][0].schedule).toEqual(schedule);
  });

  it('saves the weekday picked for a weekly task', async () => {
    const user = userEvent.setup();
    openEditor();
    renderEditor();
    await user.type(nameField(), '晨报');
    await user.type(promptField(), '整理新闻');

    await user.click(choice('每周'));
    await user.click(choice('周五'));
    await user.click(saveButton());

    expect(createTask.mock.calls[0][0].schedule).toEqual({ frequency: 'weekly', time: { hour: 9, minute: 0 }, dayOfWeek: 5 });
  });

  it('saves the workspace typed for a task without a project, and the description', async () => {
    const user = userEvent.setup();
    openEditor();
    renderEditor();
    await user.type(nameField(), '晨报');
    await user.type(promptField(), '整理新闻');
    await user.type(screen.getByPlaceholderText('描述这个任务的目的...'), ' 每天早上看一眼 ');
    await user.type(screen.getByPlaceholderText('可选，指定工作目录'), '/work/news');
    await user.click(saveButton());

    expect(createTask.mock.calls[0][0]).toMatchObject({ description: '每天早上看一眼', workspacePath: '/work/news', projectId: undefined });
  });

  it('opens on the task being edited and saves every field back under its id', async () => {
    const user = userEvent.setup();
    seedChoices();
    useScheduleStore.setState({ tasks: { 'task-1': FULL_TASK } });
    openEditor('task-1');
    renderEditor();

    expect(screen.getByRole('heading', { name: '编辑任务' })).toBeVisible();
    expect(nameField()).toHaveValue('周报');
    expect(promptField()).toHaveValue('汇总本周进展');
    expect(screen.getByPlaceholderText('描述这个任务的目的...')).toHaveValue('每周三汇总');
    // The project's folder is shown, and the field is locked while a project is chosen.
    expect(screen.getByPlaceholderText('可选，指定工作目录')).toHaveValue('/work/site');
    expect(screen.getByPlaceholderText('可选，指定工作目录')).toBeDisabled();
    expect(screen.getByPlaceholderText('群 ID，多个用逗号分隔')).toHaveValue('chat-a, chat-b');
    expect(screen.getByPlaceholderText('用户 ID，多个用逗号分隔')).toHaveValue('user-a');

    await user.click(saveButton());

    expect(createTask).not.toHaveBeenCalled();
    expect(updateTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith('task-1', {
      name: '周报',
      description: '每周三汇总',
      prompt: '汇总本周进展',
      teamId: 'team-1',
      schedule: { frequency: 'weekly', time: { hour: 14, minute: 30 }, dayOfWeek: 3 },
      skillName: 'weekly-report',
      workspacePath: '/work/site',
      projectId: 'project-1',
      outputChannelId: 'channel-1',
      outputChatIds: 'chat-a, chat-b',
      outputUserIds: 'user-a',
      permissionMode: 'smart',
    });
    expect(useScheduleStore.getState().showEditor).toBe(false);
  });

  it('drops the group and user ids of a task that pushes to no channel', async () => {
    const user = userEvent.setup();
    seedChoices();
    useScheduleStore.setState({ tasks: { 'task-1': { ...FULL_TASK, outputChannelId: undefined } } });
    openEditor('task-1');
    renderEditor();

    expect(screen.queryByPlaceholderText('群 ID，多个用逗号分隔')).toBeNull();
    await user.click(saveButton());

    expect(updateTask.mock.calls[0][1]).toMatchObject({ outputChannelId: undefined, outputChatIds: undefined, outputUserIds: undefined });
  });

  it('closes from 取消 without saving', async () => {
    const user = userEvent.setup();
    openEditor();
    renderEditor();

    await user.click(screen.getByRole('button', { name: '取消' }));

    expect(useScheduleStore.getState().showEditor).toBe(false);
    expect(createTask).not.toHaveBeenCalled();
  });

  it('closes on Escape while nothing has been typed', async () => {
    const user = userEvent.setup();
    openEditor();
    renderEditor();

    await user.keyboard('{Escape}');

    expect(useScheduleStore.getState().showEditor).toBe(false);
  });

  describe('the window', () => {
    it('is a window named after what it does, with a named close button and named fields', () => {
      seedChoices();
      useScheduleStore.setState({ tasks: { 'task-1': FULL_TASK } });
      openEditor('task-1');
      renderEditor();

      const editor = screen.getByRole('dialog', { name: '编辑任务' });
      expect(within(editor).getByRole('button', { name: getI18n().common.close })).toBeVisible();
      // The wide window: the seven weekdays in English need 562px in one row.
      expect(editor.className.split(/\s+/)).toContain('max-w-2xl');
      expect(screen.getByLabelText('任务名称')).toBe(nameField());
      expect(screen.getByLabelText('任务指令')).toBe(promptField());
      expect(screen.getByLabelText('任务描述').tagName).toBe('TEXTAREA');
      expect(screen.getByLabelText('工作区路径')).toHaveValue('/work/site');
      expect(screen.getByLabelText('群聊')).toHaveValue('chat-a, chat-b');
      expect(screen.getByLabelText('私聊')).toHaveValue('user-a');
      expect(screen.getByRole('group', { name: '执行频率' })).toBeVisible();
      expect(screen.getByRole('group', { name: '星期几' })).toBeVisible();
    });

    it('shows each choice of the task being edited', () => {
      seedChoices();
      useScheduleStore.setState({ tasks: { 'task-1': FULL_TASK } });
      openEditor('task-1');
      renderEditor();

      expect(choice('每周')).toBeChecked();
      expect(choice('周三')).toBeChecked();
      expect(select('执行时间')).toHaveTextContent('14');
      expect(select('每小时第几分钟')).toHaveTextContent('30');
      expect(select('交给专家团（可选）')).toHaveTextContent('研究组');
      expect(select('绑定技能')).toHaveTextContent('weekly-report');
      expect(select('所属项目')).toHaveTextContent('官网改版');
      expect(select('自主程度')).toHaveTextContent(getI18n().settings.permissionModeSmart);
      expect(select('结果与审批推送频道')).toHaveTextContent('运营群 (feishu)');
    });

    it('shows a new task as daily at 09:00, following the settings, pushing nowhere', () => {
      seedChoices();
      openEditor();
      renderEditor();

      expect(choice('每天')).toBeChecked();
      expect(screen.queryByRole('group', { name: '星期几' })).toBeNull();
      expect(select('执行时间')).toHaveTextContent('09');
      expect(select('每小时第几分钟')).toHaveTextContent('00');
      expect(select('交给专家团（可选）')).toHaveTextContent('不指定，普通任务');
      expect(select('绑定技能')).toHaveTextContent('不绑定');
      expect(select('自主程度')).toHaveTextContent('跟随设置');
      expect(select('结果与审批推送频道')).toHaveTextContent('不推送');
      expect(screen.queryByLabelText('群聊')).toBeNull();
    });

    it('offers only the time fields the frequency needs', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();

      await user.click(choice('每小时'));
      expect(screen.queryByRole('combobox', { name: '执行时间' })).toBeNull();
      expect(select('每小时第几分钟')).toBeVisible();

      await user.click(choice('手动'));
      expect(screen.queryByRole('combobox', { name: '每小时第几分钟' })).toBeNull();

      await user.click(choice('每周'));
      expect(screen.getByRole('group', { name: '星期几' })).toBeVisible();
      expect(choice('周一')).toBeChecked();
    });

    it('moves only the focus on an arrow key in the frequency row; Space picks', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();
      await user.type(nameField(), '晨报');
      await user.type(promptField(), '整理新闻');
      choice('每天').focus();

      await user.keyboard('{ArrowRight}');
      expect(choice('每周')).toHaveFocus();
      expect(choice('每天')).toBeChecked();
      expect(choice('每周')).not.toBeChecked();

      await user.keyboard('{ArrowLeft}{ArrowLeft}');
      expect(choice('每小时')).toHaveFocus();
      expect(choice('每天')).toBeChecked();

      await user.keyboard(' ');
      expect(choice('每小时')).toBeChecked();
      await user.click(saveButton());
      expect(createTask.mock.calls[0][0].schedule.frequency).toBe('hourly');
    });

    it('saves the hour and the minute picked from the two lists', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();
      await user.type(nameField(), '晨报');
      await user.type(promptField(), '整理新闻');

      await pick(user, '执行时间', '07');
      await pick(user, '每小时第几分钟', '45');
      await user.click(saveButton());

      expect(createTask.mock.calls[0][0].schedule).toEqual({ frequency: 'daily', time: { hour: 7, minute: 45 }, dayOfWeek: undefined });
    });

    it('saves the skill, the autonomy and the channel picked, and the ids typed for the channel', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor();
      renderEditor();
      await user.type(nameField(), '晨报');
      await user.type(promptField(), '整理新闻');

      await user.click(select('绑定技能'));
      // A skill the user cannot call is not offered.
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['不绑定', 'weekly-report']);
      await user.click(screen.getByRole('option', { name: 'weekly-report' }));
      await pick(user, '自主程度', getI18n().settings.permissionModeAutonomous);
      await pick(user, '结果与审批推送频道', '运营群 (feishu)');
      await user.type(screen.getByLabelText('群聊'), ' chat-1 ');
      await user.type(screen.getByLabelText('私聊'), ' user-1 ');
      await user.click(saveButton());

      expect(createTask.mock.calls[0][0]).toMatchObject({
        skillName: 'weekly-report',
        permissionMode: 'autonomous',
        outputChannelId: 'channel-1',
        outputChatIds: 'chat-1',
        outputUserIds: 'user-1',
      });
    });

    it('goes back to no skill, to following the settings and to no channel', async () => {
      const user = userEvent.setup();
      seedChoices();
      useScheduleStore.setState({ tasks: { 'task-1': FULL_TASK } });
      openEditor('task-1');
      renderEditor();

      await pick(user, '绑定技能', '不绑定');
      await pick(user, '自主程度', '跟随设置');
      await pick(user, '结果与审批推送频道', '不推送');
      await user.click(saveButton());

      expect(updateTask.mock.calls[0][1]).toMatchObject({
        skillName: undefined,
        permissionMode: undefined,
        outputChannelId: undefined,
        outputChatIds: undefined,
        outputUserIds: undefined,
      });
      expect('permissionMode' in updateTask.mock.calls[0][1]).toBe(true);
    });

    it('takes the folder of the project picked and locks the folder field', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor();
      renderEditor();
      await user.type(nameField(), '晨报');
      await user.type(promptField(), '整理新闻');
      await user.type(screen.getByLabelText('工作区路径'), '/work/typed');

      await pick(user, '所属项目', '官网改版');
      expect(screen.getByLabelText('工作区路径')).toHaveValue('/work/site');
      expect(screen.getByLabelText('工作区路径')).toBeDisabled();
      await user.click(saveButton());

      expect(createTask.mock.calls[0][0]).toMatchObject({ projectId: 'project-1', workspacePath: '/work/site' });
    });

    it('keeps the folder of a project that is then taken off again', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor();
      renderEditor();
      await user.type(nameField(), '晨报');
      await user.type(promptField(), '整理新闻');

      await pick(user, '所属项目', '官网改版');
      await pick(user, '所属项目', getI18n().project.projectNone);
      expect(screen.getByLabelText('工作区路径')).toBeEnabled();
      await user.click(saveButton());

      expect(createTask.mock.calls[0][0]).toMatchObject({ projectId: undefined, workspacePath: '/work/site' });
    });

    it('hands the task to the expert team picked, and to none when that team is picked again', async () => {
      const user = userEvent.setup();
      seedChoices();
      openEditor();
      renderEditor();
      await user.type(nameField(), '晨报');
      await user.type(promptField(), '整理新闻');

      await pick(user, '交给专家团（可选）', '研究组');
      expect(select('交给专家团（可选）')).toHaveTextContent('研究组');
      await pick(user, '交给专家团（可选）', '研究组');
      expect(select('交给专家团（可选）')).toHaveTextContent('不指定，普通任务');
      await pick(user, '交给专家团（可选）', '研究组');
      await user.click(saveButton());

      expect(createTask.mock.calls[0][0].teamId).toBe('team-1');
    });

    it('offers no expert team, skill or project field when there is none to pick', () => {
      openEditor();
      renderEditor();
      expect(screen.queryByRole('combobox', { name: '交给专家团（可选）' })).toBeNull();
      expect(screen.queryByRole('combobox', { name: '绑定技能' })).toBeNull();
      expect(screen.queryByRole('combobox', { name: '所属项目' })).toBeNull();
    });

    it('asks before it discards what was typed, on Escape and on 取消', async () => {
      const user = userEvent.setup();
      openEditor();
      renderEditor();
      await user.type(nameField(), '晨报');

      await user.keyboard('{Escape}');
      expect(screen.getByRole('alertdialog', { name: ds().discardTitle })).toBeVisible();
      expect(useScheduleStore.getState().showEditor).toBe(true);

      await user.click(screen.getByRole('button', { name: ds().keepEditing }));
      expect(useScheduleStore.getState().showEditor).toBe(true);
      expect(nameField()).toHaveValue('晨报');

      await user.click(screen.getByRole('button', { name: '取消' }));
      await user.click(screen.getByRole('button', { name: ds().discard }));
      expect(useScheduleStore.getState().showEditor).toBe(false);
      expect(createTask).not.toHaveBeenCalled();
    });

    it('asks nothing once a changed field is back to what it was', async () => {
      const user = userEvent.setup();
      seedChoices();
      useScheduleStore.setState({ tasks: { 'task-1': FULL_TASK } });
      openEditor('task-1');
      renderEditor();
      await user.click(choice('每天'));
      await user.click(choice('每周'));

      await user.keyboard('{Escape}');

      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(useScheduleStore.getState().showEditor).toBe(false);
    });

    it('saves nothing from the window while it fades out, and keeps showing what it showed', async () => {
      const user = userEvent.setup();
      const fading = keepClosingLayersOnScreen();
      try {
        seedChoices();
        useScheduleStore.setState({ tasks: { 'task-1': FULL_TASK } });
        openEditor('task-1');
        renderEditor();
        await user.clear(nameField());
        await user.type(nameField(), '周报二');

        act(() => useScheduleStore.getState().closeEditor());

        const closing = closingWindow();
        expect(within(closing).getByRole('heading', { name: '编辑任务' })).toBeInTheDocument();
        expect(within(closing).getByPlaceholderText('例如：每日晨报')).toHaveValue('周报二');
        fireEvent.click(within(closing).getByRole('button', { name: '保存' }));

        expect(updateTask).not.toHaveBeenCalled();
        expect(createTask).not.toHaveBeenCalled();
      } finally {
        fading.mockRestore();
      }
    });
  });

  it('starts empty again after a task was edited', async () => {
    const user = userEvent.setup();
    seedChoices();
    useScheduleStore.setState({ tasks: { 'task-1': FULL_TASK } });
    openEditor('task-1');
    renderEditor();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(useScheduleStore.getState().showEditor).toBe(false);

    act(() => openEditor());

    expect(screen.getByRole('heading', { name: '新建任务' })).toBeVisible();
    expect(nameField()).toHaveValue('');
    expect(promptField()).toHaveValue('');
  });
});
