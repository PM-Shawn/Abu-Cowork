// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
 * 语言和外观两行用的是 Select，它的下拉面板渲染到 document.body，不在账户菜单
 * 的 DOM 子树里。账户菜单判断「点在外面」只看自己的子树，所以按下选项的那一刻
 * 整个菜单就关掉了，选项按钮跟着消失，click 再也到不了它的处理函数——下拉看得
 * 见、点不动。这两条用例钉住修好后的行为。
 */
describe('AccountMenu 里的下拉选项', () => {
  beforeEach(() => {
    setLanguage('zh-CN');
    useSettingsStore.setState({
      userNickname: '我',
      userAvatar: '',
      // 外观固定成「亮色」，这样「跟随系统」只会出现在语言那一行，定位不会撞车
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

  it('选中语言选项后写入设置，账户菜单保持打开', async () => {
    const user = userEvent.setup();
    render(<AccountMenu onEditProfile={() => {}} />);

    await user.click(screen.getByRole('button', { name: /我/ }));
    await user.click(screen.getByRole('button', { name: '跟随系统' }));
    await user.click(screen.getByRole('button', { name: '简体中文' }));

    expect(useSettingsStore.getState().language).toBe('zh-CN');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('选中外观选项后写入设置，账户菜单保持打开', async () => {
    const user = userEvent.setup();
    render(<AccountMenu onEditProfile={() => {}} />);

    await user.click(screen.getByRole('button', { name: /我/ }));
    await user.click(screen.getByRole('button', { name: '亮色' }));
    await user.click(screen.getByRole('button', { name: '暗色' }));

    expect(useSettingsStore.getState().theme).toBe('dark');
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
