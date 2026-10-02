// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import type { IMChannel } from '@/types/imChannel';
import IMChannelSection from './IMChannelSection';

// Made-up values. A channel secret may be typed into its field and nowhere else.
const SECRET = 'im-secret-not-real';
const WECHAT_CREDENTIALS = { botToken: 'wechat-token-not-real', baseurl: 'https://ilink.example.test', ilinkBotId: 'bot-not-real' };

const store = vi.hoisted(() => {
  const state = {
    channels: {} as Record<string, unknown>,
    sessions: {} as Record<string, unknown>,
    addChannel: vi.fn(),
    updateChannel: vi.fn(),
    removeChannel: vi.fn(),
  };
  const useIMChannelStore = Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  );
  return { state, useIMChannelStore };
});
vi.mock('@/stores/imChannelStore', () => ({ useIMChannelStore: store.useIMChannelStore }));

vi.mock('@/stores/settingsStore', () => {
  const state = { imChannel: { allowLanWebhook: false }, setIMAllowLanWebhook: vi.fn() };
  return { useSettingsStore: (selector: (value: typeof state) => unknown) => selector(state) };
});
vi.mock('@/core/trigger/triggerEngine', () => ({ triggerEngine: { getServerPort: () => 18080 } }));
vi.mock('@/core/im/pluginRegistry', () => ({ hasHeartbeatPlugin: () => false }));
vi.mock('@/core/im/platformLabels', () => {
  const names: Record<string, string> = { feishu: '飞书', dingtalk: '钉钉', wechat: '微信' };
  return {
    getIMPlatformOptions: () => Object.entries(names).map(([value, label]) => ({ value, label })),
    getPlatformDisplayName: (platform: string) => names[platform] ?? platform,
  };
});
// The scan itself talks to WeChat. Here one button stands for a finished scan.
vi.mock('./WeChatQRPanel', () => ({
  default: ({ onBound }: { onBound: (credentials: typeof WECHAT_CREDENTIALS) => void }) => (
    <Button onClick={() => onBound(WECHAT_CREDENTIALS)}>Finish scan</Button>
  ),
}));

// The browser's own question box.
const nativeConfirm = vi.fn<(message?: string) => boolean>();

function channel(overrides: Partial<IMChannel> = {}): IMChannel {
  return {
    id: 'ch-1',
    platform: 'feishu',
    name: 'Team bot',
    appId: 'cli_app_not_real',
    appSecret: SECRET,
    capability: 'safe_tools',
    responseMode: 'mention_only',
    allowedUsers: [],
    workspacePaths: [],
    sessionTimeoutMinutes: 30,
    maxRoundsPerSession: 0,
    enabled: true,
    status: 'connected',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}
function show(...channels: IMChannel[]) {
  store.state.channels = Object.fromEntries(channels.map((item) => [item.id, item]));
  return render(<IMChannelSection />, { wrapper: DesignSystemProvider });
}

// How the page's controls are found and operated. Everything below goes through these.
const ui = {
  header: (name = 'Team bot') => screen.getByText(name).closest('button')!,
  expand: (name = 'Team bot') => fireEvent.click(ui.header(name)),
  isExpanded: () => screen.queryByText('连接配置') !== null,
  channelSwitch: (name = 'Team bot') => screen.getByRole('switch', { name }),
  secretField: () => document.querySelector<HTMLInputElement>('input[type="password"]')!,
  field: (value: string) => screen.getByDisplayValue(value),
  select: (label: string) => screen.getByRole('combobox', { name: label }),
  async choose(label: string, option: string) {
    const user = userEvent.setup();
    await user.click(ui.select(label));
    await user.click(screen.getByRole('option', { name: option }));
  },
  deleteButton: () => screen.getByRole('button', { name: '删除' }),
  deleteQuestion: () => screen.findByRole('alertdialog', { name: '确定删除此频道？所有相关会话将被清除。' }),
  openAddForm: () => fireEvent.click(screen.getByRole('button', { name: '添加' })),
  pickPlatform: (name: string) => fireEvent.click(screen.getByRole('radio', { name })),
  saveButton: () => screen.getByRole('button', { name: '保存' }),
  copyButton: () => screen.getByRole('button', { name: '复制' }),
  type: (placeholder: string, value: string) => fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } }),
};
// An answer to a question reaches the page one promise turn after the button is pressed.
const settled = () => act(async () => { await Promise.resolve(); });

// Where a value could leak to besides its own field: what is shown, and what assistive
// technology, a hover or a test reads.
function readableOutsideFields(): string {
  const attributes = [...document.querySelectorAll('*')].flatMap((element) => (
    [...element.attributes]
      .filter((attribute) => attribute.name === 'title' || attribute.name.startsWith('aria-') || attribute.name.startsWith('data-'))
      .map((attribute) => `${attribute.name}=${attribute.value}`)
  ));
  return [document.body.textContent ?? '', ...attributes].join('\n');
}

describe('IMChannelSection', () => {
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });
  beforeEach(() => {
    initLanguage('zh-CN');
    store.state.channels = {};
    store.state.sessions = {};
    store.state.addChannel.mockReset();
    store.state.updateChannel.mockReset();
    store.state.removeChannel.mockReset();
    nativeConfirm.mockReset();
    vi.stubGlobal('confirm', nativeConfirm);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  describe('the list', () => {
    it('says there is no channel yet and what adding one is for', () => {
      show();
      expect(screen.getByText('暂无 IM 频道')).toBeInTheDocument();
      expect(screen.getByText('添加一个 IM 频道，让用户通过即时通讯与 Abu 互动')).toBeInTheDocument();
    });

    it('shows each channel with its platform, ability and running conversations', () => {
      store.state.sessions = { a: { channelId: 'ch-1' }, b: { channelId: 'ch-1' }, c: { channelId: 'ch-2' } };
      show(channel(), channel({ id: 'ch-2', name: 'Support', platform: 'dingtalk', capability: 'chat_only', status: 'disconnected', enabled: false }));
      expect(screen.queryByText('暂无 IM 频道')).toBeNull();
      const first = screen.getByText('Team bot').closest('.border')!;
      expect(within(first as HTMLElement).getByText('飞书')).toBeInTheDocument();
      expect(within(first as HTMLElement).getByText('标准（可读写已授权文件）')).toBeInTheDocument();
      expect(within(first as HTMLElement).getByText('活跃会话: 2')).toBeInTheDocument();
      expect(screen.getByText('仅对话（不操作文件）')).toBeInTheDocument();
      expect(ui.channelSwitch('Team bot')).toHaveAttribute('aria-checked', 'true');
      expect(ui.channelSwitch('Support')).toHaveAttribute('aria-checked', 'false');
    });

    it('marks a connected channel and a failed one with a shape, and any other with a hollow dot', () => {
      show(
        channel(),
        channel({ id: 'ch-2', name: 'Support', status: 'error' }),
        channel({ id: 'ch-3', name: 'Sales', status: 'disconnected' }),
      );
      expect(ui.header('Team bot').querySelector('.text-success')).not.toBeNull();
      expect(ui.header('Support').querySelector('.text-danger')).not.toBeNull();
      expect(ui.header('Sales').querySelector('.text-success')).toBeNull();
      expect(ui.header('Sales').querySelector('.text-danger')).toBeNull();
      expect(ui.header('Sales').querySelector('.rounded-full')).toHaveClass('border-control-border');
    });

    it('fills one button only: Add in the page header', () => {
      show(channel());
      ui.expand();
      const filled = screen.getAllByRole('button').filter((button) => button.classList.contains('bg-emphasis'));
      expect(filled).toEqual([screen.getByRole('button', { name: '添加' })]);
    });
  });

  describe('a channel header', () => {
    it('turns the channel off from its switch, without opening the channel', () => {
      show(channel());
      fireEvent.click(ui.channelSwitch());
      expect(store.state.updateChannel).toHaveBeenCalledExactlyOnceWith('ch-1', { enabled: false });
      expect(ui.isExpanded()).toBe(false);
    });

    it('turns a stopped channel on', () => {
      show(channel({ enabled: false }));
      fireEvent.click(ui.channelSwitch());
      expect(store.state.updateChannel).toHaveBeenCalledExactlyOnceWith('ch-1', { enabled: true });
    });

    it('is a button that says whether the channel is open, with the switch beside it and named after the channel', () => {
      show(channel());
      const header = ui.header();
      expect(header).toHaveAttribute('aria-expanded', 'false');
      expect(header).not.toContainElement(ui.channelSwitch());
      expect(header.parentElement).toContainElement(ui.channelSwitch());
      // The header comes first, so Tab reaches it before the switch.
      expect(header.compareDocumentPosition(ui.channelSwitch()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      ui.expand();
      expect(ui.header()).toHaveAttribute('aria-expanded', 'true');
    });

    it('does not open the channel when Space or Enter is pressed on its switch', async () => {
      const user = userEvent.setup();
      show(channel());
      ui.channelSwitch().focus();
      await user.keyboard(' ');
      await user.keyboard('{Enter}');
      expect(ui.isExpanded()).toBe(false);
      expect(store.state.updateChannel.mock.calls).toEqual([['ch-1', { enabled: false }], ['ch-1', { enabled: false }]]);
    });

    it('opens and closes the channel, one at a time', () => {
      show(channel(), channel({ id: 'ch-2', name: 'Support' }));
      ui.expand('Team bot');
      expect(ui.field('Team bot')).toBeInTheDocument();
      ui.expand('Support');
      expect(screen.queryByDisplayValue('Team bot')).toBeNull();
      expect(ui.field('Support')).toBeInTheDocument();
      ui.expand('Support');
      expect(ui.isExpanded()).toBe(false);
      expect(store.state.updateChannel).not.toHaveBeenCalled();
    });
  });

  describe('an open channel', () => {
    it('keeps the secret masked and out of everything readable on the page', () => {
      show(channel());
      ui.expand();
      expect(ui.secretField()).toHaveAttribute('type', 'password');
      expect(ui.secretField()).toHaveValue(SECRET);
      expect(readableOutsideFields()).not.toContain(SECRET);
    });

    it('writes the name, the app id and the secret as they are typed', () => {
      show(channel());
      ui.expand();
      fireEvent.change(ui.field('Team bot'), { target: { value: 'Team bot 2' } });
      fireEvent.change(ui.field('cli_app_not_real'), { target: { value: 'cli_other_not_real' } });
      fireEvent.change(ui.secretField(), { target: { value: 'im-secret-not-real-2' } });
      expect(store.state.updateChannel.mock.calls).toEqual([
        ['ch-1', { name: 'Team bot 2' }],
        ['ch-1', { appId: 'cli_other_not_real' }],
        ['ch-1', { appSecret: 'im-secret-not-real-2' }],
      ]);
    });

    it('changes the ability level to the one picked', async () => {
      show(channel());
      ui.expand();
      await ui.choose('能力等级', '完全控制（需白名单）');
      expect(store.state.updateChannel).toHaveBeenCalledExactlyOnceWith('ch-1', { capability: 'full' });
    });

    // The ability level decides what the other side of the chat can make Abu do.
    it('changes no ability level from arrow keys or typing; Enter picks the highlighted one', async () => {
      const user = userEvent.setup();
      show(channel());
      ui.expand();
      ui.select('能力等级').focus();
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('listbox')).toBeInTheDocument();
      await user.keyboard('{ArrowDown}{ArrowUp}{ArrowUp}');
      expect(store.state.updateChannel).not.toHaveBeenCalled();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('listbox')).toBeNull();
      await user.keyboard('完');
      expect(store.state.updateChannel).not.toHaveBeenCalled();
      expect(ui.isExpanded()).toBe(true);

      await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
      expect(store.state.updateChannel).toHaveBeenCalledExactlyOnceWith('ch-1', { capability: 'full' });
    });

    it('changes when the channel answers', async () => {
      show(channel());
      ui.expand();
      await ui.choose('响应方式', '所有消息');
      expect(store.state.updateChannel).toHaveBeenCalledExactlyOnceWith('ch-1', { responseMode: 'all_messages' });
    });

    it('gives every select of the form the whole control column, and every hint a button named after its row', () => {
      show(channel());
      ui.expand();
      for (const label of ['响应方式', '能力等级']) {
        expect(ui.select(label)).toHaveClass('w-full');
        expect(ui.select(label).parentElement).toHaveClass('w-85');
      }
      for (const label of ['回调地址', '响应方式', '会话超时（分钟）', '白名单用户']) {
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
      }
      expect(screen.queryByRole('button', { name: '能力等级' })).toBeNull();
    });

    it('explains a row when its hint button takes the keyboard focus', async () => {
      const user = userEvent.setup();
      show(channel());
      ui.expand();
      expect(screen.queryByText('0 = 不超时')).toBeNull();
      await user.tab();
      while (document.activeElement !== screen.getByRole('button', { name: '会话超时（分钟）' })) await user.tab();
      expect(await screen.findByRole('tooltip')).toHaveTextContent('0 = 不超时');
    });

    it('writes the timeout in minutes, and the lowest value when the field is emptied', () => {
      show(channel());
      ui.expand();
      const minutes = ui.field('30');
      expect(minutes).toHaveAttribute('type', 'number');
      expect(minutes).toHaveAttribute('min', '0');
      expect(minutes).toHaveAttribute('max', '1440');
      fireEvent.change(minutes, { target: { value: '45' } });
      fireEvent.change(minutes, { target: { value: '' } });
      expect(store.state.updateChannel.mock.calls).toEqual([
        ['ch-1', { sessionTimeoutMinutes: 45 }],
        ['ch-1', { sessionTimeoutMinutes: 0 }],
      ]);
    });

    it('adds an allowed user on Enter, once, and removes one from its own button', () => {
      show(channel({ allowedUsers: ['ou_ada'] }));
      ui.expand();
      const input = screen.getByPlaceholderText('');
      fireEvent.change(input, { target: { value: ' ou_grace ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(store.state.updateChannel).toHaveBeenLastCalledWith('ch-1', { allowedUsers: ['ou_ada', 'ou_grace'] });
      expect(input).toHaveValue('');

      store.state.updateChannel.mockClear();
      fireEvent.change(input, { target: { value: 'ou_ada' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(store.state.updateChannel).not.toHaveBeenCalled();
      expect(input).toHaveValue('');

      fireEvent.click(within(screen.getByText('ou_ada').parentElement!).getByRole('button'));
      expect(store.state.updateChannel).toHaveBeenCalledExactlyOnceWith('ch-1', { allowedUsers: [] });
    });

    it('offers the user-id hint only while no user is listed', () => {
      show(channel());
      ui.expand();
      expect(screen.getByPlaceholderText('输入用户 ID，回车添加')).toBeInTheDocument();
    });

    it('shows the callback address of the platform and copies exactly that', () => {
      vi.useFakeTimers();
      const writeText = vi.fn();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      show(channel());
      ui.expand();
      const url = 'http://127.0.0.1:18080/im/feishu/webhook';
      expect(screen.getByText(url)).toBeInTheDocument();
      expect(ui.copyButton().querySelector('.lucide-copy')).not.toBeNull();

      fireEvent.click(ui.copyButton());
      expect(writeText).toHaveBeenCalledExactlyOnceWith(url);
      expect(ui.copyButton().querySelector('.lucide-check')).not.toBeNull();

      act(() => { vi.advanceTimersByTime(2000); });
      expect(ui.copyButton().querySelector('.lucide-copy')).not.toBeNull();
    });

    it('shows the last error of the channel', () => {
      show(channel({ status: 'error', lastError: 'Callback rejected' }));
      ui.expand();
      expect(screen.getByText('Callback rejected')).toBeInTheDocument();
    });

    it('asks in the app before deleting, names the channel, and keeps it when the question is cancelled', async () => {
      show(channel());
      ui.expand();
      fireEvent.click(ui.deleteButton());
      const question = await ui.deleteQuestion();
      expect(question).toHaveAccessibleDescription('Team bot');
      expect(store.state.removeChannel).not.toHaveBeenCalled();
      fireEvent.click(within(question).getByRole('button', { name: '取消' }));
      await settled();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(store.state.removeChannel).not.toHaveBeenCalled();
      expect(ui.isExpanded()).toBe(true);
      expect(nativeConfirm).not.toHaveBeenCalled();
    });

    it('keeps the channel when the question is closed with Escape', async () => {
      show(channel());
      ui.expand();
      fireEvent.click(ui.deleteButton());
      await ui.deleteQuestion();
      await userEvent.keyboard('{Escape}');
      await settled();
      expect(store.state.removeChannel).not.toHaveBeenCalled();
      expect(ui.isExpanded()).toBe(true);
    });

    it('deletes the channel once after the question is confirmed, and closes it', async () => {
      show(channel());
      ui.expand();
      fireEvent.click(ui.deleteButton());
      const question = await ui.deleteQuestion();
      expect(store.state.removeChannel).not.toHaveBeenCalled();
      const confirmButton = within(question).getByRole('button', { name: '删除' });
      expect(confirmButton).toHaveClass('text-danger');
      fireEvent.click(confirmButton);
      await settled();
      expect(store.state.removeChannel).toHaveBeenCalledExactlyOnceWith('ch-1');
      expect(ui.isExpanded()).toBe(false);
      expect(nativeConfirm).not.toHaveBeenCalled();
    });

    it('deletes nothing when the channel has gone by the time the question is confirmed', async () => {
      show(channel());
      ui.expand();
      fireEvent.click(ui.deleteButton());
      const question = await ui.deleteQuestion();
      store.state.channels = {};
      fireEvent.click(within(question).getByRole('button', { name: '删除' }));
      await settled();
      expect(store.state.removeChannel).not.toHaveBeenCalled();
    });
  });

  describe('a WeChat channel', () => {
    const wechat = (overrides: Partial<IMChannel> = {}) => channel({
      platform: 'wechat', name: 'WeChat bot', appId: 'bot-bound-not-real', appSecret: JSON.stringify({ botToken: SECRET }), ...overrides,
    });

    it('shows the bound account instead of an app id and a secret field', () => {
      show(wechat());
      ui.expand('WeChat bot');
      expect(screen.getByText('bot-bound-not-real')).toBeInTheDocument();
      expect(document.querySelector('input[type="password"]')).toBeNull();
      expect(screen.queryByText('回调地址')).toBeNull();
      expect(screen.queryByText('微信登录已过期，请重新扫码绑定')).toBeNull();
      expect(readableOutsideFields()).not.toContain(SECRET);
    });

    it('offers a new scan once the WeChat login has expired, and stores what the scan returns', () => {
      show(wechat({ status: 'error' }));
      ui.expand('WeChat bot');
      expect(screen.getByText('微信登录已过期，请重新扫码绑定')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Finish scan' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '重新扫码绑定' }));
      expect(screen.queryByText('微信登录已过期，请重新扫码绑定')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Finish scan' }));
      expect(store.state.updateChannel).toHaveBeenCalledExactlyOnceWith('ch-1', {
        appId: 'bot-not-real',
        appSecret: JSON.stringify(WECHAT_CREDENTIALS),
      });
      expect(screen.queryByRole('button', { name: 'Finish scan' })).toBeNull();
    });
  });

  describe('adding a channel', () => {
    it('opens the form in place of the add button, and Cancel puts the button back without adding', () => {
      show();
      ui.openAddForm();
      expect(screen.getByRole('heading', { name: '添加频道' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '添加' })).toBeNull();
      expect(screen.queryByText('暂无 IM 频道')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(screen.queryByRole('heading', { name: '添加频道' })).toBeNull();
      expect(screen.getByRole('button', { name: '添加' })).toBeInTheDocument();
      expect(store.state.addChannel).not.toHaveBeenCalled();
    });

    it('cannot save until the name, the app id and the secret are all filled', () => {
      show();
      ui.openAddForm();
      expect(ui.saveButton()).toBeDisabled();
      ui.type('例如：研发群机器人', 'Team bot');
      expect(ui.saveButton()).toBeDisabled();
      ui.type('输入应用 ID', 'cli_app_not_real');
      expect(ui.saveButton()).toBeDisabled();
      ui.type('输入应用密钥', '   ');
      expect(ui.saveButton()).toBeDisabled();
      ui.type('输入应用密钥', SECRET);
      expect(ui.saveButton()).toBeEnabled();
      expect(store.state.addChannel).not.toHaveBeenCalled();
    });

    it('masks the secret it is given and keeps it out of everything readable on the page', () => {
      show();
      ui.openAddForm();
      ui.type('输入应用密钥', SECRET);
      expect(screen.getByPlaceholderText('输入应用密钥')).toHaveAttribute('type', 'password');
      expect(readableOutsideFields()).not.toContain(SECRET);
    });

    it('adds the channel once with trimmed values and the chosen platform and ability, then closes the form', async () => {
      show();
      ui.openAddForm();
      ui.pickPlatform('钉钉');
      ui.type('例如：研发群机器人', '  Team bot ');
      ui.type('输入应用 ID', ' cli_app_not_real ');
      ui.type('输入应用密钥', ` ${SECRET} `);
      await ui.choose('能力等级', '只读（可查看文件）');
      fireEvent.click(ui.saveButton());
      expect(store.state.addChannel).toHaveBeenCalledExactlyOnceWith({
        platform: 'dingtalk',
        name: 'Team bot',
        appId: 'cli_app_not_real',
        appSecret: SECRET,
        capability: 'read_tools',
      });
      expect(screen.queryByRole('heading', { name: '添加频道' })).toBeNull();
    });

    it('offers the platforms as one named choice, moves only the focus on arrow keys, and fills Save alone', async () => {
      const user = userEvent.setup();
      show();
      ui.openAddForm();
      const platforms = screen.getByRole('group', { name: '平台' });
      expect(within(platforms).getAllByRole('radio').map((radio) => radio.textContent)).toEqual(['飞书', '钉钉', '微信']);
      expect(within(platforms).getByRole('radio', { name: '飞书' })).toHaveAttribute('aria-checked', 'true');
      within(platforms).getByRole('radio', { name: '飞书' }).focus();
      await user.keyboard('{ArrowRight}');
      expect(within(platforms).getByRole('radio', { name: '钉钉' })).toHaveFocus();
      expect(within(platforms).getByRole('radio', { name: '飞书' })).toHaveAttribute('aria-checked', 'true');
      await user.keyboard(' ');
      expect(within(platforms).getByRole('radio', { name: '钉钉' })).toHaveAttribute('aria-checked', 'true');

      const filled = screen.getAllByRole('button').filter((button) => button.classList.contains('bg-emphasis'));
      expect(filled).toEqual([ui.saveButton()]);
    });

    it('starts on Feishu with the standard ability', () => {
      show();
      ui.openAddForm();
      ui.type('例如：研发群机器人', 'Team bot');
      ui.type('输入应用 ID', 'cli_app_not_real');
      ui.type('输入应用密钥', SECRET);
      fireEvent.click(ui.saveButton());
      expect(store.state.addChannel).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ platform: 'feishu', capability: 'safe_tools' }));
    });

    it('asks for a scan instead of an app id on WeChat, and saves what the scan returned under a ready-made name', () => {
      show();
      ui.openAddForm();
      ui.pickPlatform('微信');
      expect(screen.queryByPlaceholderText('输入应用 ID')).toBeNull();
      expect(screen.queryByPlaceholderText('输入应用密钥')).toBeNull();
      expect(ui.saveButton()).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Finish scan' }));
      expect(screen.getByPlaceholderText('例如：研发群机器人')).toHaveValue('微信');
      fireEvent.click(ui.saveButton());
      expect(store.state.addChannel).toHaveBeenCalledExactlyOnceWith({
        platform: 'wechat',
        name: '微信',
        appId: 'bot-not-real',
        appSecret: JSON.stringify(WECHAT_CREDENTIALS),
        capability: 'safe_tools',
      });
    });

    it('keeps a name that was typed before the scan, and forgets the scan when the platform changes', () => {
      show();
      ui.openAddForm();
      ui.pickPlatform('微信');
      ui.type('例如：研发群机器人', 'Family');
      fireEvent.click(screen.getByRole('button', { name: 'Finish scan' }));
      expect(screen.getByPlaceholderText('例如：研发群机器人')).toHaveValue('Family');
      ui.pickPlatform('飞书');
      ui.pickPlatform('微信');
      expect(ui.saveButton()).toBeDisabled();
      expect(store.state.addChannel).not.toHaveBeenCalled();
    });
  });
});
