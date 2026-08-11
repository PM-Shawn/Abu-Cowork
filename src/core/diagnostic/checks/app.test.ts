import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import { APP_VERSION } from '@/utils/version';
import { getI18n } from '@/i18n';
import type { UpdateInfo } from '@/core/updates/types';

// Assert against the resolved dictionary so the test is locale-agnostic
// (vitest boots with whatever the i18n default is).
const t = getI18n().diagnostic;

// The app check forces an update check; we drive its side effects (store
// mutations) from the mock so each scenario is deterministic.
const mockCheckForUpdate = vi.fn();
vi.mock('@/core/updates/checker', () => ({
  checkForUpdate: (...args: unknown[]) => mockCheckForUpdate(...args),
}));

import { runAppChecks } from './app';

function fakeUpdateInfo(version: string): UpdateInfo {
  return { version, releaseNotes: 'notes', releaseUrl: '', publishedAt: '' };
}

describe('runAppChecks', () => {
  beforeEach(() => {
    mockCheckForUpdate.mockReset();
    useSettingsStore.setState({ lastUpdateCheck: 1_000, updateInfo: null });
  });

  it('always renders the live APP_VERSION, never a cached snapshot value', async () => {
    // Feed reached, no update.
    mockCheckForUpdate.mockImplementation(async () => {
      useSettingsStore.setState({ lastUpdateCheck: 2_000, updateInfo: null });
      return null;
    });

    const [row] = await runAppChecks();

    expect(row.metric).toContain(`v${APP_VERSION}`);
  });

  it('shows "up to date" (passed) when the forced check reaches the feed and finds no update', async () => {
    mockCheckForUpdate.mockImplementation(async () => {
      useSettingsStore.setState({ lastUpdateCheck: 2_000, updateInfo: null });
      return null;
    });

    const [row] = await runAppChecks();

    expect(mockCheckForUpdate).toHaveBeenCalledWith(true, { silent: true }); // forced, no global update UI
    expect(row.status).toBe('passed');
    expect(row.metric).toContain(t.appLatest);
    expect(row.suggestedAction).toBeUndefined();
  });

  it('shows "update available" (warning) with the offered version when the feed reports one', async () => {
    mockCheckForUpdate.mockImplementation(async () => {
      const info = fakeUpdateInfo('0.36.0');
      useSettingsStore.setState({ lastUpdateCheck: 2_000, updateInfo: info });
      return info;
    });

    const [row] = await runAppChecks();

    expect(row.status).toBe('warning');
    expect(row.metric).toContain('0.36.0');
    expect(row.metric).toContain(`v${APP_VERSION}`);
    expect(row.suggestedAction).toMatchObject({ type: 'open-settings', target: 'about' });
  });

  it('does NOT claim "up to date" when the feed was never reached (offline)', async () => {
    // checkForUpdate resolves but leaves lastUpdateCheck untouched — its
    // documented signal for "check() never resolved / feed unreachable".
    mockCheckForUpdate.mockResolvedValue(null);

    const [row] = await runAppChecks();

    expect(row.status).toBe('warning');
    expect(row.metric).toContain(t.appCheckFailed);
    expect(row.metric).not.toContain(t.appLatest);
    expect(row.metric).toContain(`v${APP_VERSION}`);
  });

  it('treats a thrown checkForUpdate as "could not check", not a crash', async () => {
    mockCheckForUpdate.mockRejectedValue(new Error('network down'));

    const [row] = await runAppChecks();

    expect(row.status).toBe('warning');
    expect(row.metric).toContain(t.appCheckFailed);
  });

  it('does not hang when the update check never resolves (bounded by timeout)', async () => {
    vi.useFakeTimers();
    try {
      // A feed that never responds: runAppChecks must still settle via its
      // internal timeout instead of blocking the whole diagnostic run forever.
      mockCheckForUpdate.mockReturnValue(new Promise(() => {}));

      const pending = runAppChecks();
      await vi.advanceTimersByTimeAsync(8000);
      const [row] = await pending;

      expect(row.status).toBe('warning');
      expect(row.metric).toContain(t.appCheckFailed); // timeout ⇒ feed not reached
    } finally {
      vi.useRealTimers();
    }
  });
});
