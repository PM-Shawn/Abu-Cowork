// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AboutSection from './AboutSection';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkForUpdate } from '@/core/updates/checker';
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
      common: { appName: 'Abu', appSlogan: 'Your desktop agent' },
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
        disclaimerLink: '免责声明',
        disclaimerTitle: '免责声明',
        disclaimerFullSuffix: '全文',
        disclaimerClose: '收起',
      },
      disclaimerBanner: { line1: 'l1', line2: 'l2', line3: 'l3' },
    },
  }),
}));

function resetUpdateState(updaterUnsupported: boolean | null) {
  useSettingsStore.setState({
    updateInfo: null,
    updateChecking: false,
    updateDownloadProgress: null,
    updateInstalling: false,
    updaterUnsupported,
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
