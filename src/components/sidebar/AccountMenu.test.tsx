// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import AccountMenu from './AccountMenu';
import { useSettingsStore } from '@/stores/settingsStore';
import { setLanguage } from '@/i18n';

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
vi.mock('@/core/updates/checker', () => ({
  checkForUpdate: vi.fn().mockResolvedValue({ kind: 'up-to-date' }),
  downloadAndInstallUpdate: vi.fn(),
  restartApp: vi.fn(),
}));

/**
 * 语言和外观各是一个子菜单，里面的选项只能选一个，当前选项带勾。
 * 键盘和鼠标都能走完：打开菜单、进入子菜单、选中、退出。
 * 检查更新留在菜单里，把结果显示在这一行。
 */
describe('AccountMenu 里的下拉选项', () => {
  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll APIs Radix menus and selects call.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    setLanguage('zh-CN');
    useSettingsStore.setState({
      userNickname: '我',
      userAvatar: '',
      theme: 'light',
      language: 'system',
      updateInfo: null,
      updateChecking: false,
      updateDownloadProgress: null,
      updateInstalling: false,
      updaterUnsupported: false,
    });
  });

  afterEach(() => {
    cleanup();
    setLanguage('system');
  });

  function renderMenu() {
    return render(<AccountMenu onEditProfile={() => {}} />, { wrapper: DesignSystemProvider });
  }

  it('全程用键盘选语言：方向键进入「语言」子菜单，回车选中，写入设置', async () => {
    const user = userEvent.setup();
    renderMenu();

    screen.getByRole('button', { name: '我' }).focus();
    // 键盘打开时焦点在第一项「编辑资料」，往下是「设置」「语言」
    await user.keyboard('{Enter}');
    expect(screen.getByRole('menuitem', { name: '编辑资料' })).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: /^语言/ })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    const current = await screen.findByRole('menuitemradio', { name: '跟随系统' });
    expect(current).toHaveFocus();
    expect(current).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(useSettingsStore.getState().language).toBe('zh-CN');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('左方向键退回上一层，Escape 关掉整个菜单且不改设置', async () => {
    const user = userEvent.setup();
    renderMenu();

    const trigger = screen.getByRole('button', { name: '我' });
    trigger.focus();
    await user.keyboard('{Enter}{ArrowDown}{ArrowDown}{ArrowRight}');
    await screen.findByRole('menuitemradio', { name: '简体中文' });
    await user.keyboard('{ArrowLeft}');
    expect(screen.queryByRole('menuitemradio', { name: '简体中文' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /^语言/ })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('menuitemradio', { name: '简体中文' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(useSettingsStore.getState().language).toBe('system');
  });

  it('外观子菜单显示当前选择，选中后写入设置', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: '我' }));
    const appearance = screen.getByRole('menuitem', { name: /^外观/ });
    expect(appearance).toHaveTextContent('亮色');
    await user.click(appearance);
    expect(await screen.findByRole('menuitemradio', { name: '亮色' })).toHaveAttribute('aria-checked', 'true');
    // happy-dom has no layout for Radix's pointer path into a submenu; choose from the keyboard.
    act(() => screen.getByRole('menuitemradio', { name: '暗色' }).focus());
    await user.keyboard('{Enter}');

    expect(useSettingsStore.getState().theme).toBe('dark');
  });

  it('检查更新后菜单保持打开，结果显示在这一行', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: '我' }));
    await user.click(screen.getByRole('menuitem', { name: /更新/ }));

    expect(await screen.findByRole('menuitem', { name: '已是最新版本' })).toBeInTheDocument();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('检查中的这一行不可点，并显示正在检查', async () => {
    useSettingsStore.setState({ updateChecking: true });
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: '我' }));
    const row = screen.getByRole('menuitem', { name: '检查中...' });
    expect(row).toHaveAttribute('data-disabled');
    expect(screen.getByRole('status')).toHaveTextContent('检查中...');
    // The words are the size of every other menu item's name.
    expect(within(screen.getByRole('status')).getByText('检查中...')).toHaveClass('text-ui');
  });
});
