import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';
import { useSettingsStore } from '@/stores/settingsStore';

// Controllable UI locale (checker.ts picks notes by getLocale()).
let mockLocale: 'zh-CN' | 'en-US' = 'zh-CN';
vi.mock('@/i18n', async (importActual) => {
  const actual = await importActual<typeof import('@/i18n')>();
  return { ...actual, getLocale: () => mockLocale };
});

// checker.ts invokes `plugin:updater|check` directly (the plugin's check()
// wrapper cannot carry the Electron host's `{ status: 'disabled' }` marker)
// and wraps genuine metadata in the plugin's Update class itself. mockCheck
// therefore stands in for the raw invoke result: metadata, null, or the
// marker. The Electron feed carries NO release notes, so `body` is typically
// empty in production; tests give it a value so the "fall back to the updater
// body" path is observable.
const mockCheck = vi.fn();
const mockDownloadAndInstall = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) => {
    if (cmd === 'plugin:updater|check') return mockCheck();
    return Promise.resolve(undefined);
  },
}));
vi.mock('@tauri-apps/plugin-updater', () => ({
  Update: class {
    version: string;
    date?: string;
    body?: string;
    constructor(metadata: { version: string; date?: string; body?: string }) {
      this.version = metadata.version;
      this.date = metadata.date;
      this.body = metadata.body;
    }
    downloadAndInstall(onEvent?: (event: DownloadEvent) => void) {
      return mockDownloadAndInstall(onEvent);
    }
  },
}));

// Silence the notice bus (irrelevant to notes-language behavior).
vi.mock('@/core/notice/bus', () => ({ publish: vi.fn() }));

import { checkForUpdate, downloadAndInstallUpdate, refreshUpdateNotes } from './checker';
import { publish } from '@/core/notice/bus';

function requireUpdateInfo(result: Awaited<ReturnType<typeof checkForUpdate>>) {
  expect(result.kind).toBe('update');
  if (result.kind !== 'update') throw new Error(`Expected update result, received ${result.kind}`);
  return result.info;
}

// The updater's own body — last-resort fallback (empty in real Electron builds).
const EN_BODY = 'Updater body fallback for v0.32.0 — shown only if the feed is unusable.';
// The release-metadata feed's per-locale notes (electron/latest-release.json).
const EN_META = 'English release notes for v0.32.0 from the metadata feed — long enough to render.';
const ZH_NOTES = '中文更新说明：多页签工作区、卡片化改版等，内容足够长以通过丰富度判断。';

// Raw `plugin:updater|check` metadata as updaterHost returns it.
function fakeUpdate() {
  return {
    rid: 90001,
    currentVersion: '0.31.0',
    version: 'v0.32.0',
    date: '2026-07-19T00:00:00Z',
    body: EN_BODY,
    rawJson: {},
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

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(info?.releaseNotes).toBe(ZH_NOTES);
    expect(useSettingsStore.getState().updateInfo?.releaseNotes).toBe(ZH_NOTES);
  });

  it('en-US user gets the English notes from the feed, not the empty updater body', async () => {
    mockLocale = 'en-US';
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES, 'en-US': EN_META } });

    const info = requireUpdateInfo(await checkForUpdate(true));

    // The Electron feed carries no notes, so English MUST come from the metadata
    // feed now — a bare updater body would be empty for real builds.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(info?.releaseNotes).toBe(EN_META);
  });

  it('falls back to the updater body when the metadata fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(info?.releaseNotes).toBe(EN_BODY);
  });

  it('falls back to the feed English notes when the user locale is missing', async () => {
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'en-US': EN_META } }); // no zh-CN, zh-CN user

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(info?.releaseNotes).toBe(EN_META);
  });

  it('falls back to the updater body when the feed has no usable notes', async () => {
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: {} });

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(info?.releaseNotes).toBe(EN_BODY);
  });

  it('ignores feed notes when its version is behind the offered update', async () => {
    // Guard: the metadata feed is a SEPARATE file from the electron-updater feed
    // that produced the offered version. If it lags (e.g. a superseded release),
    // a zh-CN user offered vNEW must not read vOLD's notes → fall back.
    mockFeed({ schema_version: 1, version: 'v0.30.0', notes_i18n: { 'zh-CN': ZH_NOTES } });

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(info?.releaseNotes).toBe(EN_BODY);
  });

  it('ignores feed notes on an unexpected schema_version', async () => {
    mockFeed({ schema_version: 2, version: 'v0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES } });

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(info?.releaseNotes).toBe(EN_BODY);
  });

  it('still uses feed notes when it omits a version (backward compat)', async () => {
    mockFeed({ schema_version: 1, notes_i18n: { 'zh-CN': ZH_NOTES } }); // no version field

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(info?.releaseNotes).toBe(ZH_NOTES);
  });

  it('accepts feed notes when the version matches without the v prefix', async () => {
    mockFeed({ schema_version: 1, version: '0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES } }); // no leading v

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(info?.releaseNotes).toBe(ZH_NOTES);
  });

  it('refreshUpdateNotes re-picks the pending update notes for the new locale', async () => {
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES, 'en-US': EN_META } });
    mockLocale = 'zh-CN';
    await checkForUpdate(true);
    expect(useSettingsStore.getState().updateInfo?.releaseNotes).toBe(ZH_NOTES);

    // User switches language, then the panel re-picks the notes.
    mockLocale = 'en-US';
    await refreshUpdateNotes();
    expect(useSettingsStore.getState().updateInfo?.releaseNotes).toBe(EN_META);
    // Version is locale-independent and must be preserved.
    expect(useSettingsStore.getState().updateInfo?.version).toBe('0.32.0');
  });

  it('refreshUpdateNotes is a no-op when there is no pending update result', async () => {
    useSettingsStore.setState({ updateInfo: null });
    await refreshUpdateNotes();
    expect(useSettingsStore.getState().updateInfo).toBeNull();
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
    const info = requireUpdateInfo(await checkForUpdate(true, { silent: true }));
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

describe('checkForUpdate — disabled marker (updater never armed in this build)', () => {
  // Regression anchor (2026-08-22): a non-official Windows package returned
  // bare null from check() and the UI claimed "已是最新版本" while the updater
  // was silently disabled. The host now answers `{ status: 'disabled' }`.
  beforeEach(() => {
    mockCheck.mockReset();
    (publish as unknown as ReturnType<typeof vi.fn>).mockClear();
    useSettingsStore.setState({
      lastUpdateCheck: 0,
      updateInfo: null,
      updateChecking: false,
      updaterUnsupported: null,
    });
    mockLocale = 'zh-CN';
    mockFeed({ schema_version: 1, version: 'v0.32.0', notes_i18n: { 'zh-CN': ZH_NOTES } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('marker → disabled result, updaterUnsupported=true, and NOT "up to date"', async () => {
    mockCheck.mockResolvedValue({ status: 'disabled', reason: 'unofficial-build' });

    const result = await checkForUpdate(true);

    expect(result).toEqual({ kind: 'disabled' });
    const state = useSettingsStore.getState();
    expect(state.updaterUnsupported).toBe(true);
    expect(state.updateInfo).toBeNull();
    // No feed was contacted: the throttle timestamp must stay untouched so the
    // diagnostic app-check does not read this as a confirmed comparison, and
    // the next startup check re-learns the flag.
    expect(state.lastUpdateCheck).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('a real feed answer of null marks the updater supported and up to date', async () => {
    mockCheck.mockResolvedValue(null);

    const result = await checkForUpdate(true);

    expect(result).toEqual({ kind: 'up-to-date' });
    const state = useSettingsStore.getState();
    expect(state.updaterUnsupported).toBe(false);
    expect(state.lastUpdateCheck).toBeGreaterThan(0);
  });

  it('an offered update also marks the updater supported', async () => {
    mockCheck.mockResolvedValue(fakeUpdate());

    const info = requireUpdateInfo(await checkForUpdate(true));

    expect(info?.version).toBe('0.32.0');
    expect(useSettingsStore.getState().updaterUnsupported).toBe(false);
  });

  it('a thrown check leaves the unsupported flag unknown (not false)', async () => {
    mockCheck.mockRejectedValue(new Error('feed unreachable'));

    const result = await checkForUpdate(true);

    expect(result).toEqual({ kind: 'error', updaterUnsupported: null });
    // Offline ≠ unsupported: the flag stays unknown and is carried in the
    // result so callers can preserve their existing presentation without a
    // second store read.
    expect(useSettingsStore.getState().updaterUnsupported).toBeNull();
    expect(useSettingsStore.getState().lastUpdateCheck).toBe(0);
  });
});

describe('checkForUpdate — throttled result', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T00:00:00Z'));
    mockCheck.mockReset();
    useSettingsStore.setState({ lastUpdateCheck: Date.parse('2026-08-24T23:00:00Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns throttled without invoking the updater inside the check interval', async () => {
    const result = await checkForUpdate();

    expect(result).toEqual({ kind: 'throttled' });
    expect(mockCheck).not.toHaveBeenCalled();
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
