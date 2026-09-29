// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
 * 语言和外观两行各带一个下拉框。下拉框的列表是账户菜单里面再打开的一层，
 * 选中一项只关掉这一层：设置写进去，账户菜单保持打开，用户能看到改动生效。
 * 检查更新同样留在菜单里，把结果显示在这一行。
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

  it('选中语言选项后写入设置，账户菜单保持打开', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: '我' }));
    await user.click(screen.getByRole('combobox', { name: '语言' }));
    await user.click(screen.getByRole('option', { name: '简体中文' }));

    expect(useSettingsStore.getState().language).toBe('zh-CN');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('选中外观选项后写入设置，账户菜单保持打开', async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(screen.getByRole('button', { name: '我' }));
    expect(screen.getByRole('combobox', { name: '外观' })).toHaveTextContent('亮色');
    await user.click(screen.getByRole('combobox', { name: '外观' }));
    await user.click(screen.getByRole('option', { name: '暗色' }));

    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(screen.getByRole('menu')).toBeInTheDocument();
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
  });
});
