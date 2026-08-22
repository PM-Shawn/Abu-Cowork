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

  it('incident journey: clicking 检查更新 on a disabled-updater build flips the caption', async () => {
    // Regression anchor (2026-08-22): a non-official Windows install clicked
    // "检查更新" and read "已是最新版本" while the updater was silently
    // disabled. The check must surface the unsupported state instead.
    resetUpdateState(null);
    vi.mocked(checkForUpdate).mockImplementation(async () => {
      useSettingsStore.getState().setUpdaterUnsupported(true);
      return null;
    });
    const user = userEvent.setup();
    render(<AboutSection />);

    // Before the check the flag is unknown → legacy caption is acceptable.
    expect(screen.getByText('已是最新版本')).toBeInTheDocument();

    await user.click(screen.getByText('检查更新'));

    expect(
      await screen.findByText('此安装包不支持自动更新，请前往官网下载最新版本'),
    ).toBeInTheDocument();
    expect(screen.queryByText('已是最新版本')).not.toBeInTheDocument();
  });
});
