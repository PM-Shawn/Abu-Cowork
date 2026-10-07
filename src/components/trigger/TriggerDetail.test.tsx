// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { triggerEngine } from '@/core/trigger/triggerEngine';
import { initLanguage } from '@/i18n';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useToastStore } from '@/stores/toastStore';
import { useTriggerStore } from '@/stores/triggerStore';
import type { Trigger, TriggerCapability } from '@/types/trigger';
import { passSettleInterval } from '@/test/dsWindows';
import TriggerDetail from './TriggerDetail';

vi.mock('@/core/trigger/triggerEngine', () => ({
  triggerEngine: { getServerPort: vi.fn(() => 18080), handleEvent: vi.fn() },
}));

const BASE_TIME = 1_700_000_000_000;

function makeTrigger(id: string, action: Trigger['action'], extra: Partial<Trigger> = {}): Trigger {
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
    ...extra,
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
  useIMChannelStore.setState({ channels: {} });
  useToastStore.setState({ toasts: [] });
}

function show(trigger: Trigger) {
  useTriggerStore.setState({ triggers: { [trigger.id]: trigger }, selectedTriggerId: trigger.id });
  return render(<DesignSystemProvider><TriggerDetail /></DesignSystemProvider>);
}

// The row of the facts box that a label starts: the label and its value share one parent.
const rowOf = (label: string) => screen.getByText(label).parentElement!;
const handleEvent = vi.mocked(triggerEngine.handleEvent);
const classes = (element: Element) => (element.getAttribute('class') ?? '').split(/\s+/);

describe('TriggerDetail capability level', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetStores();
    handleEvent.mockClear();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('shows read-only when a trigger has no capability field', () => {
    show(makeTrigger('missing-capability', { prompt: 'Handle event' }));

    expect(screen.getByText('自主程度')).toBeInTheDocument();
    expect(screen.getByText('只看不动（默认）')).toBeInTheDocument();
  });

  it('shows the current capability level', () => {
    show(makeTrigger('safe-capability', { prompt: 'Handle event', capability: 'safe_tools' }));

    expect(screen.getByText('自主程度')).toBeInTheDocument();
    expect(screen.getByText('常规')).toBeInTheDocument();
  });

  it.each(['future_tier', '__proto__'])('fails closed when persisted capability is %s', (persistedCapability) => {
    show(makeTrigger('malformed-capability', {
      prompt: 'Handle event',
      capability: persistedCapability as TriggerCapability,
    }));

    expect(screen.getByText('只看不动（默认）')).toBeInTheDocument();
  });

  it.each([
    [undefined, '只看不动（默认）'],
    ['read_tools', '只看不动（默认）'],
    ['safe_tools', '常规'],
    ['full', '完全放开'],
    ['custom', '自定义规则（保留现有配置）'],
  ] as const)('names the level %s in the row of the autonomy label', (capability, label) => {
    show(makeTrigger('level', { prompt: 'Handle event', capability }));

    expect(rowOf('自主程度')).toHaveTextContent(`自主程度${label}`);
  });
});

describe('TriggerDetail', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetStores();
    handleEvent.mockClear();
  });

  afterEach(() => {
    cleanup();
    resetStores();
  });

  it('shows the facts of the listener', () => {
    show(makeTrigger('facts', { prompt: 'Handle $EVENT_DATA' }, {
      description: 'What it is for',
      filter: { type: 'keyword', keywords: ['error', 'alert'] },
      debounce: { enabled: true, windowSeconds: 120 },
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
      totalRuns: 7,
    }));

    expect(screen.getByRole('heading', { level: 1, name: 'Trigger facts' })).toBeVisible();
    expect(rowOf('状态')).toHaveTextContent('状态启用');
    expect(rowOf('触发方式')).toHaveTextContent('触发方式HTTP 接收');
    expect(rowOf('触发条件')).toHaveTextContent('触发条件关键词匹配: error, alert');
    expect(rowOf('防抖')).toHaveTextContent('防抖120秒');
    expect(rowOf('静默时段')).toHaveTextContent('静默时段22:00 ~ 08:00');
    expect(rowOf('总执行次数')).toHaveTextContent('总执行次数7 次');
    expect(screen.getByText('What it is for')).toBeVisible();
    expect(screen.getByText('Handle $EVENT_DATA')).toBeVisible();
    expect(screen.getByText('暂无执行记录')).toBeVisible();
  });

  it('shows the watched folder of a file listener and the interval of a timed one, and no address for either', () => {
    const { unmount } = show(makeTrigger('file', { prompt: 'p' }, { source: { type: 'file', path: '/fake/watched', events: ['create'] } }));
    expect(rowOf('触发方式')).toHaveTextContent('文件变更');
    expect(rowOf('监听路径')).toHaveTextContent('/fake/watched');
    expect(screen.queryByText('HTTP 接收地址')).toBeNull();
    expect(screen.queryByRole('button', { name: '复制地址' })).toBeNull();
    unmount();

    show(makeTrigger('cron', { prompt: 'p' }, { source: { type: 'cron', intervalSeconds: 90 } }));
    expect(rowOf('触发间隔（秒）')).toHaveTextContent('每 90 秒');
    expect(screen.queryByText('HTTP 接收地址')).toBeNull();
  });

  it('names the channel of an IM listener, or its id once the channel is gone', () => {
    useIMChannelStore.setState({ channels: { 'channel-1': { id: 'channel-1', name: '运营群', platform: 'feishu' } } as never });
    const { unmount } = show(makeTrigger('im', { prompt: 'p' }, { source: { type: 'im', channelId: 'channel-1', listenScope: 'all' } }));
    expect(rowOf('触发方式')).toHaveTextContent('IM 消息源');
    expect(rowOf('选择 IM 频道')).toHaveTextContent('运营群 (feishu)');
    unmount();

    show(makeTrigger('im-gone', { prompt: 'p' }, { source: { type: 'im', channelId: 'channel-9', listenScope: 'all' } }));
    expect(rowOf('选择 IM 频道')).toHaveTextContent('channel-9');
  });

  it('shows the address an HTTP listener receives on, and a curl line for it', () => {
    show(makeTrigger('http-1', { prompt: 'p' }));

    expect(screen.getByText('HTTP 接收地址')).toBeVisible();
    expect(screen.getByText('POST http://localhost:18080/trigger/http-1')).toBeVisible();
    expect(screen.getByText('curl 示例')).toBeVisible();
    expect(screen.getByText(/^curl -X POST http:\/\/localhost:18080\/trigger\/http-1 /)).toBeVisible();
  });

  it('copies the address, and only the address, to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    show(makeTrigger('http-1', { prompt: 'p' }));

    await user.click(screen.getByRole('button', { name: '复制地址' }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('http://localhost:18080/trigger/http-1');
  });

  it.each([
    ['http', { type: 'http' }, { content: 'test message', _test: true }],
    ['file', { type: 'file', path: '/fake/watched', events: ['create'] }, { event: 'create', paths: ['/fake/watched/test-file.txt'], watchPath: '/fake/watched', _test: true }],
    ['cron', { type: 'cron', intervalSeconds: 60 }, { event: 'cron', run: 1, _test: true }],
  ] as const)('sends a test event to a %s listener and says so', async (_kind, source, data) => {
    const user = userEvent.setup();
    show(makeTrigger('tested', { prompt: 'p' }, { source: source as Trigger['source'] }));

    await user.click(screen.getByRole('button', { name: '测试触发' }));

    expect(handleEvent).toHaveBeenCalledTimes(1);
    const [id, payload, options] = handleEvent.mock.calls[0];
    expect(id).toBe('tested');
    expect(payload).toStrictEqual({ data: { ...data, timestamp: expect.any(Number) } });
    expect(options).toStrictEqual({ skipChecks: true });
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0]).toMatchObject({ type: 'success', title: '测试事件已发送' });
  });

  it('sends no test event while the listener is paused', async () => {
    const user = userEvent.setup();
    show(makeTrigger('paused', { prompt: 'p' }, { status: 'paused' }));

    expect(rowOf('状态')).toHaveTextContent('状态已暂停');
    expect(screen.getByRole('button', { name: '测试触发' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '测试触发' }));

    expect(handleEvent).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('pauses and resumes the listener', async () => {
    const user = userEvent.setup();
    show(makeTrigger('toggled', { prompt: 'p' }));

    await user.click(screen.getByRole('button', { name: '暂停' }));
    expect(useTriggerStore.getState().triggers.toggled.status).toBe('paused');
    await user.click(screen.getByRole('button', { name: '恢复' }));
    expect(useTriggerStore.getState().triggers.toggled.status).toBe('active');
  });

  it('goes back to the list, and opens the editor on this listener', async () => {
    const user = userEvent.setup();
    show(makeTrigger('edited', { prompt: 'p' }));

    await user.click(screen.getByRole('button', { name: '编辑' }));
    expect(useTriggerStore.getState().showEditor).toBe(true);
    expect(useTriggerStore.getState().editingTriggerId).toBe('edited');

    await user.click(screen.getByRole('button', { name: '返回列表' }));
    expect(useTriggerStore.getState().selectedTriggerId).toBeNull();
  });

  it('names the way back and marks it for the page that moves the focus onto it', () => {
    show(makeTrigger('named', { prompt: 'p' }));
    expect(screen.getByRole('button', { name: '返回列表' })).toHaveAttribute('data-automation-back');
  });

  it('says the status in a tag with a shape: listening in green, paused in grey', () => {
    show(makeTrigger('tagged', { prompt: 'p' }));
    expect(classes(screen.getByText('启用'))).toContain('bg-success-soft');
    expect(screen.getByText('启用').querySelector('svg')).not.toBeNull();

    act(() => useTriggerStore.getState().setTriggerStatus('tagged', 'paused'));
    expect(classes(screen.getByText('已暂停'))).toContain('bg-fill');
    expect(classes(screen.getByText('已暂停'))).not.toContain('bg-success-soft');
  });

  it('shows the address and the curl line in the code font', () => {
    show(makeTrigger('http-1', { prompt: 'p' }));
    const address = screen.getByText('POST http://localhost:18080/trigger/http-1');
    expect(address.tagName).toBe('CODE');
    expect(classes(address)).toContain('font-code');
    const curl = screen.getByText(/^curl -X POST /);
    expect(curl.tagName).toBe('PRE');
    expect(classes(curl)).toContain('font-code');
  });

  it('puts the address in the text of the page and in no attribute of any element', async () => {
    const user = userEvent.setup();
    show(makeTrigger('http-1', { prompt: 'p' }));
    await user.click(screen.getByRole('button', { name: '复制地址' }));

    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toContain('localhost:18080');
        expect(attribute.value, `${element.tagName} ${attribute.name}`).not.toContain('/trigger/http-1');
      }
    }
  });

  it('turns the copy mark into a check once the address is copied, under the same name', async () => {
    const user = userEvent.setup();
    show(makeTrigger('http-1', { prompt: 'p' }));
    const copyButton = screen.getByRole('button', { name: '复制地址' });
    expect(classes(copyButton.querySelector('svg')!)).toContain('lucide-copy');

    await user.click(copyButton);

    expect(screen.getByRole('button', { name: '复制地址' })).toBe(copyButton);
    expect(classes(copyButton.querySelector('svg')!)).toContain('lucide-check');
    expect(classes(copyButton.querySelector('svg')!)).not.toContain('lucide-copy');
  });

  it('names the listener in the question, on a line of its own under the question', async () => {
    const user = userEvent.setup();
    show(makeTrigger('asked', { prompt: 'p' }));

    await user.click(screen.getByRole('button', { name: '删除' }));

    const question = screen.getByRole('alertdialog', { name: '删除' });
    const words = within(question).getByText(/确定删除此触发器？/);
    expect(words.textContent).toBe('确定删除此触发器？\nTrigger asked');
    expect(classes(words)).toContain('whitespace-pre-line');
  });

  it('deletes nothing when the listener has already gone by the time the question is answered', async () => {
    const user = userEvent.setup();
    const realDelete = useTriggerStore.getState().deleteTrigger;
    const deleteTrigger = vi.fn();
    useTriggerStore.setState({ deleteTrigger });
    try {
      show(makeTrigger('gone', { prompt: 'p' }));
      await user.click(screen.getByRole('button', { name: '删除' }));
      act(() => useTriggerStore.setState({ triggers: { other: makeTrigger('other', { prompt: 'p' }) } }));

      passSettleInterval();
      await user.click(screen.getByRole('button', { name: '确认' }));

      expect(deleteTrigger).not.toHaveBeenCalled();
    } finally {
      useTriggerStore.setState({ deleteTrigger: realDelete });
    }
  });

  it('deletes the listener the question was asked about, under its id', async () => {
    const user = userEvent.setup();
    const realDelete = useTriggerStore.getState().deleteTrigger;
    const deleteTrigger = vi.fn();
    useTriggerStore.setState({ deleteTrigger });
    try {
      show(makeTrigger('asked', { prompt: 'p' }));
      await user.click(screen.getByRole('button', { name: '删除' }));
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: '确认' }));

      expect(deleteTrigger).toHaveBeenCalledTimes(1);
      expect(deleteTrigger).toHaveBeenCalledWith('asked');
    } finally {
      useTriggerStore.setState({ deleteTrigger: realDelete });
    }
  });

  it('has no filled button; delete is the danger button', () => {
    show(makeTrigger('plain', { prompt: 'p' }));
    for (const name of ['编辑', '暂停', '测试触发', '删除']) {
      expect(classes(screen.getByRole('button', { name }))).not.toContain('bg-emphasis');
    }
    expect(classes(screen.getByRole('button', { name: '删除' }))).toContain('text-danger');
  });

  it('keeps the page title as the first-level heading and the run history as a third-level one', () => {
    show(makeTrigger('titled', { prompt: 'p' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Trigger titled' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: '执行记录' })).toBeVisible();
  });

  it('shows the prompt as it was typed, in the code font', () => {
    show(makeTrigger('prompted', { prompt: 'line one\n  line two $EVENT_DATA' }));
    const prompt = screen.getByText(/line one/);
    expect(prompt.textContent).toBe('line one\n  line two $EVENT_DATA');
    expect(classes(prompt)).toContain('font-code');
    expect(classes(prompt)).toContain('whitespace-pre-wrap');
  });

  it('marks the counts of runs that worked and failed with a shape, not with a colored number', () => {
    const run = (id: string, status: Trigger['runs'][number]['status']) => ({ id, triggerId: 'counted', conversationId: '', startedAt: BASE_TIME, status });
    show(makeTrigger('counted', { prompt: 'p' }, { runs: [run('1', 'completed'), run('2', 'error')], totalRuns: 2 }));

    expect(classes(screen.getByText('成功').querySelector('svg')!)).toContain('text-success');
    expect(classes(screen.getByText('失败').querySelector('svg')!)).toContain('text-danger');
    expect(classes(screen.getByText('成功').previousElementSibling!)).toContain('text-label');
    expect(classes(screen.getByText('失败').previousElementSibling!)).toContain('text-label');
  });

  it('deletes nothing until the question is answered, and nothing on cancel', async () => {
    const user = userEvent.setup();
    show(makeTrigger('kept', { prompt: 'p' }));

    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByText('确定删除此触发器？', { exact: false })).toBeVisible();
    expect(useTriggerStore.getState().triggers.kept).toBeDefined();

    // The question takes no pointer press for a moment after it appears: it has been read.
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(useTriggerStore.getState().triggers.kept).toBeDefined();
    expect(screen.queryByText('确定删除此触发器？', { exact: false })).toBeNull();
  });

  it('deletes the listener once the question is confirmed', async () => {
    const user = userEvent.setup();
    show(makeTrigger('removed', { prompt: 'p' }));

    await user.click(screen.getByRole('button', { name: '删除' }));
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: '确认' }));

    expect(useTriggerStore.getState().triggers.removed).toBeUndefined();
    expect(useTriggerStore.getState().selectedTriggerId).toBeNull();
  });

  it('counts the runs by how they ended', () => {
    const run = (id: string, status: Trigger['runs'][number]['status']) => ({ id, triggerId: 'counted', conversationId: '', startedAt: BASE_TIME, status });
    show(makeTrigger('counted', { prompt: 'p' }, {
      runs: [run('1', 'completed'), run('2', 'completed'), run('3', 'completed'), run('4', 'error'), run('5', 'filtered'), run('6', 'debounced')],
      totalRuns: 6,
    }));

    expect(screen.getByText('成功率').parentElement).toHaveTextContent('75%');
    expect(screen.getByText('成功').parentElement).toHaveTextContent('3');
    expect(screen.getByText('失败').parentElement).toHaveTextContent('1');
    expect(screen.getAllByText('未匹配')[0].parentElement).toHaveTextContent('2');
  });
});
