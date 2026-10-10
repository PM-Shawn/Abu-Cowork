// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render as renderBare, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import AboutSection from './AboutSection';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkForUpdate, downloadAndInstallUpdate, restartApp } from '@/core/updates/checker';
import { OFFICIAL_WEBSITE_URL } from '@/utils/helpDocs';

const openUrl = vi.fn();
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...a: unknown[]) => openUrl(...a),
}));

vi.mock('@/utils/deviceId', () => ({ getDeviceId: () => 'device-1234-abcd' }));

vi.mock('@/core/updates/checker', () => ({
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
  restartApp: vi.fn(),
  refreshUpdateNotes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    locale: 'zh-CN',
    t: {
      common: { appName: 'Abu', appSlogan: 'Your desktop agent', version: '版本' },
      updates: {
        currentVersion: '当前版本',
        checkForUpdates: '检查更新',
        checking: '检查中...',
        upToDate: '已是最新版本',
        justChecked: '刚刚已检查',
        checkFailed: '检查更新失败',
        unsupportedBuild: '此安装包不支持自动更新，请前往官网下载最新版本',
        getFromWebsite: '前往官网下载',
        preparingDownload: '正在准备下载...',
        downloading: '正在下载更新...',
        verifying: '正在验证更新...',
        restartToInstall: '重启以完成更新',
        downloadUpdate: '下载更新',
        downloadFailed: '下载更新失败',
        retry: '重试',
        newVersionAvailable: '发现新版本',
        releaseNotes: '更新日志',
        viewOnGitHub: '在 GitHub 查看完整更新说明',
      },
      about: {
        deviceId: '设备 ID',
        versionDescription: '当前版本与更新',
        disclaimerLink: '免责声明',
        disclaimerTitle: '免责声明',
        disclaimerFullSuffix: '全文',
        disclaimerClose: '收起',
      },
      disclaimerBanner: { line1: 'l1', line2: 'l2', line3: 'l3' },
    },
  }),
}));

function render(page: ReactElement) {
  return renderBare(page, { wrapper: DesignSystemProvider });
}

function resetUpdateState(updaterUnsupported: boolean | null) {
  useSettingsStore.setState({
    updateInfo: null,
    updateChecking: false,
    updateDownloadProgress: null,
    updateInstalling: false,
    updaterUnsupported,
    // The page lives in the settings window; it downloads and restarts only while that window is open.
    systemSettingsOpen: true,
  });
}

describe('AboutSection — update status caption (three-state)', () => {
  beforeEach(() => {
    openUrl.mockReset();
    openUrl.mockResolvedValue(undefined);
    vi.mocked(checkForUpdate).mockReset();
  });

  afterEach(cleanup);

  it('updater disabled: shows the unsupported caption, never "up to date"', () => {
    resetUpdateState(true);
    render(<AboutSection />);

    expect(
      screen.getByText('此安装包不支持自动更新，请前往官网下载最新版本'),
    ).toBeInTheDocument();
    expect(screen.queryByText('已是最新版本')).not.toBeInTheDocument();
  });

  it('updater disabled: the caption links to the official download site', async () => {
    resetUpdateState(true);
    const user = userEvent.setup();
    render(<AboutSection />);

    await user.click(screen.getByText('前往官网下载'));

    expect(openUrl).toHaveBeenCalledWith(OFFICIAL_WEBSITE_URL);
  });

  it('feed-confirmed current version keeps the up-to-date caption', () => {
    resetUpdateState(false);
    render(<AboutSection />);

    expect(screen.getByText('已是最新版本')).toBeInTheDocument();
    expect(
      screen.queryByText('此安装包不支持自动更新，请前往官网下载最新版本'),
    ).not.toBeInTheDocument();
  });

  it('unknown state (no check answered yet) claims nothing — neither up-to-date nor unsupported', () => {
    // Absence of a check must never read as "up to date": with a persisted
    // recent lastUpdateCheck the throttled startup check can leave the flag
    // null, and the old code rendered the green claim in that window.
    resetUpdateState(null);
    // Mount probe stays pending → the flag remains null for this render.
    vi.mocked(checkForUpdate).mockReturnValue(new Promise(() => {}));
    render(<AboutSection />);

    expect(screen.queryByText('已是最新版本')).not.toBeInTheDocument();
    expect(
      screen.queryByText('此安装包不支持自动更新，请前往官网下载最新版本'),
    ).not.toBeInTheDocument();
  });

  it('incident journey: opening About on a disabled-updater build resolves the unknown state', async () => {
    // Regression anchor (2026-08-22): a non-official Windows install read
    // "已是最新版本" while the updater was silently disabled. Opening the
    // panel now probes (silent, forced) and surfaces the unsupported state
    // without any click.
    resetUpdateState(null);
    vi.mocked(checkForUpdate).mockImplementation(async () => {
      useSettingsStore.getState().setUpdaterUnsupported(true);
      return { kind: 'disabled' };
    });
    render(<AboutSection />);

    expect(
      await screen.findByText('此安装包不支持自动更新，请前往官网下载最新版本'),
    ).toBeInTheDocument();
    expect(vi.mocked(checkForUpdate)).toHaveBeenCalledWith(true, { silent: true });
    expect(screen.queryByText('已是最新版本')).not.toBeInTheDocument();
  });

  it('clicking 检查更新 on a disabled build never marks "just checked"', async () => {
    // The just-checked state must stay reserved for real feed comparisons.
    resetUpdateState(true);
    vi.mocked(checkForUpdate).mockResolvedValue({ kind: 'disabled' });
    const user = userEvent.setup();
    render(<AboutSection />);

    await user.click(screen.getByText('检查更新'));

    expect(
      await screen.findByText('此安装包不支持自动更新，请前往官网下载最新版本'),
    ).toBeInTheDocument();
    expect(screen.queryByText('刚刚已检查')).not.toBeInTheDocument();
    expect(screen.queryByText('已是最新版本')).not.toBeInTheDocument();
  });

  it('clicking 检查更新 marks a feed-confirmed current version as just checked', async () => {
    resetUpdateState(false);
    vi.mocked(checkForUpdate).mockResolvedValue({ kind: 'up-to-date' });
    const user = userEvent.setup();
    render(<AboutSection />);

    await user.click(screen.getByText('检查更新'));

    expect(await screen.findByText('· 刚刚已检查')).toBeInTheDocument();
  });

  it('preserves the existing checked caption when a supported updater check fails', async () => {
    resetUpdateState(false);
    vi.mocked(checkForUpdate).mockResolvedValue({ kind: 'error', updaterUnsupported: false });
    const user = userEvent.setup();
    render(<AboutSection />);

    await user.click(screen.getByText('检查更新'));

    expect(await screen.findByText('· 刚刚已检查')).toBeInTheDocument();
    expect(screen.queryByText('检查更新失败')).not.toBeInTheDocument();
  });

  it('preserves the unsupported caption when a disabled updater check fails', async () => {
    resetUpdateState(true);
    vi.mocked(checkForUpdate).mockResolvedValue({ kind: 'error', updaterUnsupported: true });
    const user = userEvent.setup();
    render(<AboutSection />);

    await user.click(screen.getByText('检查更新'));

    expect(
      await screen.findByText('此安装包不支持自动更新，请前往官网下载最新版本'),
    ).toBeInTheDocument();
    expect(screen.queryByText('刚刚已检查')).not.toBeInTheDocument();
  });

  it('does not probe on mount when the support state is already known', () => {
    resetUpdateState(false);
    render(<AboutSection />);

    expect(vi.mocked(checkForUpdate)).not.toHaveBeenCalled();
  });
});

// A made-up release. Nothing is downloaded or installed: the updater functions are mocks.
const RELEASE = {
  version: '9.9.9',
  releaseNotes: '### Fixes\n\n- A made-up fix, see [the notes](https://example.invalid/notes)',
  releaseUrl: 'https://example.invalid/release',
  publishedAt: '2026-10-02T00:00:00Z',
};

describe('AboutSection — version, device and the update card', () => {
  beforeEach(() => {
    openUrl.mockReset();
    openUrl.mockResolvedValue(undefined);
    vi.mocked(checkForUpdate).mockReset();
    vi.mocked(downloadAndInstallUpdate).mockReset().mockResolvedValue(undefined);
    vi.mocked(restartApp).mockReset().mockResolvedValue(undefined);
    resetUpdateState(false);
  });

  afterEach(cleanup);

  it('shows the short device id and copies the whole one', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<AboutSection />);
    const copy = screen.getByTitle('device-1234-abcd');
    expect(copy).toHaveTextContent('device-1');
    expect(copy).not.toHaveTextContent('device-1234');

    await user.click(copy);

    expect(writeText).toHaveBeenCalledExactlyOnceWith('device-1234-abcd');
  });

  it('shows nothing about a release while there is none', () => {
    render(<AboutSection />);

    expect(screen.getByText('当前版本')).toBeInTheDocument();
    expect(screen.queryByText('发现新版本')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('offers a new release with its notes and starts the download on request', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ updateInfo: RELEASE });
    render(<AboutSection />);

    expect(screen.getByText('发现新版本')).toBeInTheDocument();
    expect(screen.getByText('v9.9.9')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fixes' })).toBeInTheDocument();
    expect(screen.queryByText('已是最新版本')).not.toBeInTheDocument();
    expect(downloadAndInstallUpdate).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '下载更新' }));

    expect(downloadAndInstallUpdate).toHaveBeenCalledTimes(1);
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('opens links in the notes and the full notes outside the app', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ updateInfo: RELEASE });
    render(<AboutSection />);

    await user.click(screen.getByRole('link', { name: 'the notes' }));
    expect(openUrl).toHaveBeenLastCalledWith('https://example.invalid/notes');

    await user.click(screen.getByRole('button', { name: '在 GitHub 查看完整更新说明' }));
    expect(openUrl).toHaveBeenLastCalledWith('https://example.invalid/release');
  });

  it('shows how far the download is and offers neither a second download nor a check', () => {
    useSettingsStore.setState({ updateInfo: RELEASE, updateDownloadProgress: { phase: 'downloading', downloaded: 250, total: 1000 } });
    render(<AboutSection />);

    const bar = screen.getByRole('progressbar', { name: '正在下载更新...' });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(screen.getByText('25.0%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '检查更新' })).toBeDisabled();
  });

  it('gives no percentage while the download is being prepared or verified', () => {
    useSettingsStore.setState({ updateInfo: RELEASE, updateDownloadProgress: { phase: 'preparing', downloaded: 0, total: 0 } });
    const { unmount } = render(<AboutSection />);
    expect(screen.getByRole('progressbar', { name: '正在准备下载...' })).not.toHaveAttribute('aria-valuenow');
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
    unmount();

    useSettingsStore.setState({ updateDownloadProgress: { phase: 'verifying', downloaded: 1000, total: 1000 } });
    render(<AboutSection />);
    expect(screen.getByRole('progressbar', { name: '正在验证更新...' })).not.toHaveAttribute('aria-valuenow');
  });

  it('says the download failed and tries again on request', async () => {
    const user = userEvent.setup();
    vi.mocked(downloadAndInstallUpdate).mockRejectedValueOnce(new Error('made-up network failure'));
    useSettingsStore.setState({ updateInfo: RELEASE });
    render(<AboutSection />);

    await user.click(screen.getByRole('button', { name: '下载更新' }));

    expect(await screen.findByText('下载更新失败')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重试' }));

    expect(downloadAndInstallUpdate).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText('下载更新失败')).not.toBeInTheDocument());
  });

  it('restarts to finish an update that is ready', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ updateInfo: RELEASE, updateInstalling: true });
    render(<AboutSection />);
    expect(screen.queryByRole('button', { name: '下载更新' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '重启以完成更新' }));

    expect(restartApp).toHaveBeenCalledTimes(1);
    expect(downloadAndInstallUpdate).not.toHaveBeenCalled();
  });

  it('takes no second check while one is running', () => {
    useSettingsStore.setState({ updateChecking: true });
    render(<AboutSection />);

    expect(screen.getByText('检查中...')).toBeInTheDocument();
    expect(screen.queryByText('已是最新版本')).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) {
      if (button.getAttribute('title') === 'device-1234-abcd') continue;
      expect(button).toBeDisabled();
    }
  });

  it('turns one indicator beside the check button while a check runs, and none inside it', () => {
    useSettingsStore.setState({ updateChecking: true });
    const { container } = render(<AboutSection />);

    const turning = container.querySelectorAll('[data-ds-spinner]');
    expect(turning).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('检查中...');
    const check = screen.getByRole('button', { name: '检查更新' });
    expect(check).toBeDisabled();
    expect(check.querySelector('[data-ds-spinner]')).toBeNull();
    expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);
  });

  it('has one filled button at most: download, then restart', () => {
    useSettingsStore.setState({ updateInfo: RELEASE });
    const { container, unmount } = render(<AboutSection />);
    expect(container.querySelectorAll('.bg-emphasis')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '下载更新' })).toHaveClass('bg-emphasis');
    unmount();

    useSettingsStore.setState({ updateInstalling: true });
    const second = render(<AboutSection />);
    expect(second.container.querySelectorAll('.bg-emphasis')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '重启以完成更新' })).toHaveClass('bg-emphasis');
    second.unmount();

    useSettingsStore.setState({ updateInfo: null, updateInstalling: false });
    const third = render(<AboutSection />);
    expect(third.container.querySelector('.bg-emphasis')).toBeNull();
  });

  it('lists version and device in one group', () => {
    const { container } = render(<AboutSection />);

    const group = container.querySelector('.rounded-panel');
    expect(group).not.toBeNull();
    expect(group).toHaveTextContent('当前版本');
    expect(group).toHaveTextContent('设备 ID');
    expect(screen.getByTitle('device-1234-abcd')).toHaveClass('font-code');
  });

  describe('while the settings window is closing', () => {
    // The window stays on the page while it fades out; the keyboard can still reach its buttons.
    it('starts no download', async () => {
      const user = userEvent.setup();
      useSettingsStore.setState({ updateInfo: RELEASE });
      render(<AboutSection />);
      useSettingsStore.setState({ systemSettingsOpen: false });

      screen.getByRole('button', { name: '下载更新' }).focus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');

      expect(downloadAndInstallUpdate).not.toHaveBeenCalled();
    });

    it('does not restart', async () => {
      const user = userEvent.setup();
      useSettingsStore.setState({ updateInfo: RELEASE, updateInstalling: true });
      render(<AboutSection />);
      useSettingsStore.setState({ systemSettingsOpen: false });

      screen.getByRole('button', { name: '重启以完成更新' }).focus();
      await user.keyboard('{Enter}');

      expect(restartApp).not.toHaveBeenCalled();
    });
  });

  it('says the check failed when it could not be made', async () => {
    const user = userEvent.setup();
    vi.mocked(checkForUpdate).mockRejectedValue(new Error('made-up failure'));
    render(<AboutSection />);

    await user.click(screen.getByRole('button', { name: '检查更新' }));

    expect(await screen.findByText('检查更新失败')).toBeInTheDocument();
    expect(screen.queryByText('已是最新版本')).not.toBeInTheDocument();
    expect(checkForUpdate).toHaveBeenCalledExactlyOnceWith(true);
  });
});
