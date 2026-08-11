import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';
import { useSettingsStore } from '@/stores/settingsStore';

// Controllable UI locale (checker.ts picks notes by getLocale()).
let mockLocale: 'zh-CN' | 'en-US' = 'zh-CN';
vi.mock('@/i18n', async (importActual) => {
  const actual = await importActual<typeof import('@/i18n')>();
  return { ...actual, getLocale: () => mockLocale };
});

// electron-updater: check() returns our fake Update. The Electron feed carries
// NO release notes, so `update.body` is typically empty in production; tests
// give it a value so the "fall back to the updater body" path is observable.
const mockCheck = vi.fn();
const mockDownloadAndInstall = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: () => mockCheck(),
}));

// Silence the notice bus (irrelevant to notes-language behavior).
vi.mock('@/core/notice/bus', () => ({ publish: vi.fn() }));

import { checkForUpdate, downloadAndInstallUpdate } from './checker';
import { publish } from '@/core/notice/bus';

// The updater's own body — last-resort fallback (empty in real Electron builds).
const EN_BODY = 'Updater body fallback for v0.32.0 — shown only if the feed is unusable.';
// The release-metadata feed's per-locale notes (electron/latest-release.json).
const EN_META = 'English release notes for v0.32.0 from the metadata feed — long enough to render.';
const ZH_NOTES = '中文更新说明：多页签工作区、卡片化改版等，内容足够长以通过丰富度判断。';

function fakeUpdate() {
  return {
    version: 'v0.32.0',
    date: '2026-07-19T00:00:00Z',
    body: EN_BODY,
    downloadAndInstall: mockDownloadAndInstall,
  };
}

// Stub the release-metadata feed (electron/latest-release.json) as raw JSON, so
// each test controls schema_version / version / notes_i18n exactly.
function mockFeed(data: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => data }),
  );
}

describe('checkForUpdate — locale-aware release notes', () => {
  beforeEach(() => {
    mockCheck.mockReset();
    mockDownloadAndInstall.mockReset();
    mockDownloadAndInstall.mockResolvedValue(undefined);
    mockCheck.mockResolvedValue(fakeUpdate());
    useSettingsStore.setState({
      lastUpdateCheck: 0,
      updateInfo: null,
      updateChecking: false,
      updateDownloadProgress: null,
      updateInstalling: false,
    });
    mockLocale = 'zh-CN';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('zh-CN user gets the Chinese notes from the release-metadata feed', async () => {
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES, 'en-US': EN_META } });

    const info = await checkForUpdate(true);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(info?.releaseNotes).toBe(ZH_NOTES);
    expect(useSettingsStore.getState().updateInfo?.releaseNotes).toBe(ZH_NOTES);
  });

  it('en-US user gets the English notes from the feed, not the empty updater body', async () => {
    mockLocale = 'en-US';
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES, 'en-US': EN_META } });

    const info = await checkForUpdate(true);

    // The Electron feed carries no notes, so English MUST come from the metadata
    // feed now — a bare updater body would be empty for real builds.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(info?.releaseNotes).toBe(EN_META);
  });

  it('falls back to the updater body when the metadata fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const info = await checkForUpdate(true);

    expect(info?.releaseNotes).toBe(EN_BODY);
  });

  it('falls back to the feed English notes when the user locale is missing', async () => {
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'en-US': EN_META } }); // no zh-CN, zh-CN user

    const info = await checkForUpdate(true);

    expect(info?.releaseNotes).toBe(EN_META);
  });

  it('falls back to the updater body when the feed has no usable notes', async () => {
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: {} });

    const info = await checkForUpdate(true);

    expect(info?.releaseNotes).toBe(EN_BODY);
  });

  it('ignores feed notes when its version is behind the offered update', async () => {
    // Guard: the metadata feed is a SEPARATE file from the electron-updater feed
    // that produced the offered version. If it lags (e.g. a superseded release),
    // a zh-CN user offered vNEW must not read vOLD's notes → fall back.
    mockFeed({ schema_version: 1, version: 'v0.30.0', notes_i18n: { 'zh-CN': ZH_NOTES } });

    const info = await checkForUpdate(true);

    expect(info?.releaseNotes).toBe(EN_BODY);
  });

  it('ignores feed notes on an unexpected schema_version', async () => {
    mockFeed({ schema_version: 2, version: 'v0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES } });

    const info = await checkForUpdate(true);

    expect(info?.releaseNotes).toBe(EN_BODY);
  });

  it('still uses feed notes when it omits a version (backward compat)', async () => {
    mockFeed({ schema_version: 1, notes_i18n: { 'zh-CN': ZH_NOTES } }); // no version field

    const info = await checkForUpdate(true);

    expect(info?.releaseNotes).toBe(ZH_NOTES);
  });

  it('accepts feed notes when the version matches without the v prefix', async () => {
    mockFeed({ schema_version: 1, version: '0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES } }); // no leading v

    const info = await checkForUpdate(true);

    expect(info?.releaseNotes).toBe(ZH_NOTES);
  });
});

describe('checkForUpdate — silent option (background/observer callers)', () => {
  beforeEach(() => {
    mockCheck.mockReset();
    mockCheck.mockResolvedValue(fakeUpdate());
    (publish as unknown as ReturnType<typeof vi.fn>).mockClear();
    useSettingsStore.setState({
      lastUpdateCheck: 0,
      updateInfo: null,
      updateChecking: false,
    });
    mockLocale = 'en-US';
    // en-US now reads the metadata feed too, so the fetch must be stubbed.
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'en-US': EN_META, 'zh-CN': ZH_NOTES } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('silent: never fires the update_available notification', async () => {
    await checkForUpdate(true, { silent: true });
    expect(publish).not.toHaveBeenCalled();
  });

  it('silent: never flips the global updateChecking spinner flag', async () => {
    const spy = vi.spyOn(useSettingsStore.getState(), 'setUpdateChecking');
    await checkForUpdate(true, { silent: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it('silent: still records updateInfo so observer callers can read the result', async () => {
    const info = await checkForUpdate(true, { silent: true });
    expect(info?.version).toBe('0.32.0');
    expect(useSettingsStore.getState().updateInfo?.version).toBe('0.32.0');
  });

  it('non-silent (default): fires the notification and toggles updateChecking', async () => {
    const spy = vi.spyOn(useSettingsStore.getState(), 'setUpdateChecking');
    await checkForUpdate(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(true);
    expect(spy).toHaveBeenCalledWith(false);
  });
});

async function primePendingUpdate(): Promise<void> {
  mockLocale = 'en-US';
  await checkForUpdate(true);
}

function controlledDownload() {
  let emit: ((event: DownloadEvent) => void) | undefined;
  let finish = () => {};

  mockDownloadAndInstall.mockImplementation(
    (onEvent?: (event: DownloadEvent) => void) => new Promise<void>((resolve) => {
      emit = onEvent;
      finish = resolve;
    }),
  );

  return {
    emit: (event: DownloadEvent) => {
      if (!emit) throw new Error('download callback is not ready');
      emit(event);
    },
    finish: () => finish(),
  };
}

describe('downloadAndInstallUpdate — progress lifecycle', () => {
  beforeEach(() => {
    mockCheck.mockReset();
    mockDownloadAndInstall.mockReset();
    mockCheck.mockResolvedValue(fakeUpdate());
    useSettingsStore.setState({
      lastUpdateCheck: 0,
      updateInfo: null,
      updateChecking: false,
      updateDownloadProgress: null,
      updateInstalling: false,
    });
    // primePendingUpdate() runs a real checkForUpdate() which now fetches the
    // metadata feed; stub it so these progress tests stay offline/deterministic.
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'en-US': EN_META } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('shows preparing immediately while the first byte is delayed', async () => {
    const download = controlledDownload();
    await primePendingUpdate();

    const pending = downloadAndInstallUpdate();

    expect(useSettingsStore.getState().updateDownloadProgress).toEqual({
      phase: 'preparing',
      downloaded: 0,
      total: 0,
    });

    download.finish();
    await pending;
  });

  it('prefers Electron absolute counters and enters verification at 100%', async () => {
    const download = controlledDownload();
    await primePendingUpdate();
    const pending = downloadAndInstallUpdate();

    download.emit({ event: 'Started', data: { contentLength: 1_000 } });
    download.emit({
      event: 'Progress',
      data: { chunkLength: 100, transferred: 400, total: 1_000 },
    } as DownloadEvent);
    expect(useSettingsStore.getState().updateDownloadProgress).toEqual({
      phase: 'downloading',
      downloaded: 400,
      total: 1_000,
    });

    download.emit({
      event: 'Progress',
      data: { chunkLength: 100, transferred: 1_000, total: 1_000 },
    } as DownloadEvent);
    expect(useSettingsStore.getState().updateDownloadProgress?.phase).toBe('verifying');

    download.finish();
    await pending;
    expect(useSettingsStore.getState().updateDownloadProgress).toBeNull();
    expect(useSettingsStore.getState().updateInstalling).toBe(true);
  });

  it('keeps unknown-length downloads active and verifies after Finished', async () => {
    const download = controlledDownload();
    await primePendingUpdate();
    const pending = downloadAndInstallUpdate();

    download.emit({ event: 'Started', data: {} });
    download.emit({ event: 'Progress', data: { chunkLength: 512 } });
    expect(useSettingsStore.getState().updateDownloadProgress).toEqual({
      phase: 'downloading',
      downloaded: 512,
      total: 0,
    });

    download.emit({ event: 'Finished' });
    expect(useSettingsStore.getState().updateDownloadProgress).toEqual({
      phase: 'verifying',
      downloaded: 512,
      total: 0,
    });

    download.finish();
    await pending;
  });

  it('does not replace a known total with a later zero total', async () => {
    const download = controlledDownload();
    await primePendingUpdate();
    const pending = downloadAndInstallUpdate();

    download.emit({ event: 'Started', data: { contentLength: 1_000 } });
    download.emit({
      event: 'Progress',
      data: { chunkLength: 100, transferred: 400, total: 0 },
    } as DownloadEvent);

    expect(useSettingsStore.getState().updateDownloadProgress).toEqual({
      phase: 'downloading',
      downloaded: 400,
      total: 1_000,
    });

    download.finish();
    await pending;
  });

  it('clears the active progress state when the updater rejects', async () => {
    mockDownloadAndInstall.mockRejectedValue(new Error('network failed'));
    await primePendingUpdate();

    await expect(downloadAndInstallUpdate()).rejects.toThrow('network failed');
    expect(useSettingsStore.getState().updateDownloadProgress).toBeNull();
    expect(useSettingsStore.getState().updateInstalling).toBe(false);
  });
});
