// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { ChromeSetupView } from './CapabilitySetupView';

const props = () => ({
  installation: 'not-installed' as 'installed' | 'not-installed' | 'unknown',
  capabilityEnabled: true, requestedByTask: false, runtimeReady: true,
  extensionConnected: false as boolean | undefined,
  extensionPath: '/test/browser-extension', connecting: false, openingInstaller: false,
  onBack: vi.fn(), onPrepare: vi.fn(), onOpenInstaller: vi.fn(), onDone: vi.fn(),
});
beforeEach(() => initLanguage('zh-CN'));
afterEach(cleanup);
describe('Chrome installation settings', () => {
  it('opens installation steps from the install action without a connection check', () => {
    const p = props();
    render(<ChromeSetupView {...p} />);
    expect(screen.getByText('未安装扩展')).toBeVisible();
    expect(screen.queryByText(/加载已解压/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '安装扩展' }));
    expect(screen.getByText('首次连接需要在 Chrome 中安装阿布扩展。')).toBeVisible();
    expect(screen.getByText(/加载已解压/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '打开拓展管理页' }));
    expect(p.onOpenInstaller).toHaveBeenLastCalledWith('page');
    fireEvent.click(screen.getByRole('button', { name: '打开扩展文件夹' }));
    expect(p.onOpenInstaller).toHaveBeenLastCalledWith('folder');
    expect(screen.queryByRole('button', { name: '检查连接' })).toBeNull();
    expect(p.onPrepare).not.toHaveBeenCalled();
  });
  it('shows installed with Chrome closed or its bridge unavailable, and collapses installation', () => {
    const p = props();
    const view = render(<ChromeSetupView {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '安装扩展' }));
    view.rerender(<ChromeSetupView {...p} installation="installed" />);
    expect(screen.getByText('已安装')).toBeVisible();
    expect(screen.queryByText(/加载已解压/)).toBeNull();
    view.rerender(<ChromeSetupView {...p} installation="installed" runtimeReady={false} extensionConnected={undefined} />);
    expect(screen.getByText('已安装')).toBeVisible();
    expect(screen.queryByText('未连接')).toBeNull();
    expect(screen.queryByText('连接中断')).toBeNull();
    expect(screen.queryByRole('button', { name: /检查连接|重新连接 Chrome|断开/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看安装帮助' }));
    expect(screen.getByText(/加载已解压/)).toBeVisible();
  });
  it('returns to not installed when installation metadata confirms removal', () => {
    const p = props();
    const view = render(<ChromeSetupView {...p} installation="installed" />);
    view.rerender(<ChromeSetupView {...p} installation="not-installed" />);
    expect(screen.getByText('未安装扩展')).toBeVisible();
    expect(screen.getByRole('button', { name: '安装扩展' })).toBeVisible();
    expect(screen.queryByText('已安装')).toBeNull();
  });
  it('never turns a failed installation read into an uninstalled claim', () => {
    render(<ChromeSetupView {...props()} installation="unknown" />);
    expect(screen.getByText('暂时无法确认安装状态')).toBeVisible();
    expect(screen.queryByText('未安装扩展')).toBeNull();
  });
  it('does not silently enable a disabled bridge; installation is an explicit action', () => {
    const p = { ...props(), capabilityEnabled: false, runtimeReady: false };
    render(<ChromeSetupView {...p} />);
    expect(p.onPrepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '安装扩展' }));
    expect(p.onPrepare).toHaveBeenCalledOnce();
  });
  it('requires a live task connection before offering return to the requesting task', () => {
    const p = { ...props(), requestedByTask: true, capabilityEnabled: false, runtimeReady: false };
    const view = render(<ChromeSetupView {...p} installation="installed" />);
    expect(screen.queryByRole('button', { name: '返回当前任务' })).toBeNull();
    expect(p.onPrepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '连接 Chrome' }));
    expect(p.onPrepare).toHaveBeenCalledOnce();
    view.rerender(<ChromeSetupView {...p} installation="installed" capabilityEnabled runtimeReady extensionConnected />);
    expect(p.onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回当前任务' }));
    expect(p.onDone).toHaveBeenCalledOnce();
  });
  // The window a task opens puts focus on its first control. That control is 取消.
  it('starts a page a task opened with 取消, which goes back and does nothing else', () => {
    const p = { ...props(), requestedByTask: true };
    render(<ChromeSetupView {...p} installation="installed" capabilityEnabled runtimeReady extensionConnected
      breadcrumb={['能力', '我的 Chrome']} />);
    const first = screen.getAllByRole('button')[0];
    expect(first.textContent).toBe('取消');
    expect(screen.queryByRole('button', { name: '返回能力' })).toBeNull();
    fireEvent.click(first);
    expect(p.onBack).toHaveBeenCalledOnce();
    expect(p.onDone).not.toHaveBeenCalled();
    expect(p.onPrepare).not.toHaveBeenCalled();
  });
  it('never offers both 连接 Chrome and 返回当前任务', () => {
    const p = { ...props(), requestedByTask: true, capabilityEnabled: false, runtimeReady: false };
    const view = render(<ChromeSetupView {...p} installation="installed" />);
    expect(screen.getByRole('button', { name: '连接 Chrome' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '返回当前任务' })).toBeNull();
    view.rerender(<ChromeSetupView {...p} installation="installed" connecting />);
    expect(screen.getByRole('button', { name: '连接 Chrome' }).hasAttribute('disabled')).toBe(true);
    view.rerender(<ChromeSetupView {...p} installation="installed" capabilityEnabled runtimeReady extensionConnected />);
    expect(screen.queryByRole('button', { name: '连接 Chrome' })).toBeNull();
    expect(screen.getByRole('button', { name: '返回当前任务' })).toBeVisible();
  });
  it('holds the installer buttons while one of them is opening, and the folder button without a folder', () => {
    const p = props();
    const view = render(<ChromeSetupView {...p} />);
    fireEvent.click(screen.getByRole('button', { name: '安装扩展' }));
    view.rerender(<ChromeSetupView {...p} openingInstaller />);
    for (const name of ['安装扩展', '打开拓展管理页', '打开扩展文件夹']) {
      expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
    }
    view.rerender(<ChromeSetupView {...p} extensionPath={null} />);
    expect(screen.getByRole('button', { name: '打开拓展管理页' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: '打开扩展文件夹' }).hasAttribute('disabled')).toBe(true);
  });
  it('reports a setup error as an alert', () => {
    render(<ChromeSetupView {...props()} error="连接组件启动失败" />);
    expect(screen.getByRole('alert').textContent).toContain('连接组件启动失败');
  });
});
