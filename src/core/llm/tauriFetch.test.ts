// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Note: @tauri-apps/plugin-http is globally mocked in src/test/setup.ts.
// In happy-dom, window.__TAURI_INTERNALS__ is undefined, so getTauriFetch()
// should short-circuit and return globalThis.fetch without importing the plugin.

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

describe('getTauriFetch', () => {
  beforeEach(async () => {
    // Reset module cache so _loadPromise singleton is cleared between tests
    vi.resetModules();
    // Ensure __TAURI_INTERNALS__ is absent (already absent in happy-dom)
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  it('returns globalThis.fetch when __TAURI_INTERNALS__ is absent (web/E2E mode)', async () => {
    // Dynamic import after resetModules() gives a fresh module with cleared singleton
    const { getTauriFetch } = await import('./tauriFetch');
    const fetchFn = await getTauriFetch();
    expect(fetchFn).toBe(globalThis.fetch);
    expect(await getTauriFetch({ localServer: true })).toBe(globalThis.fetch);
  });

  describe('in the desktop app', () => {
    beforeEach(() => {
      (window as TauriWindow).__TAURI_INTERNALS__ = {};
    });

    afterEach(() => {
      delete (window as TauriWindow).__TAURI_INTERNALS__;
    });

    async function loadWithHost() {
      const { invoke } = await import('@tauri-apps/api/core');
      const invokeMock = vi.mocked(invoke);
      invokeMock.mockReset();
      invokeMock.mockImplementation(async (cmd: string) => {
        if (cmd === 'plugin:http|fetch') return 7;
        if (cmd === 'plugin:http|fetch_send') return { status: 200, statusText: 'OK', url: 'x', headers: [], rid: 8 };
        if (cmd === 'plugin:http|fetch_read_body') return [1];
        return null;
      });
      const pluginHttp = await import('@tauri-apps/plugin-http');
      vi.mocked(pluginHttp.fetch).mockReset();
      const { getTauriFetch } = await import('./tauriFetch');
      return { getTauriFetch, invokeMock, pluginFetch: vi.mocked(pluginHttp.fetch) };
    }

    function sentClientConfig(invokeMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
      const call = invokeMock.mock.calls.find(([cmd]) => cmd === 'plugin:http|fetch');
      expect(call).toBeDefined();
      return (call![1] as { clientConfig: Record<string, unknown> }).clientConfig;
    }

    it('marks local model server requests so the host does not cut the first-response wait, whatever the address', async () => {
      const { getTauriFetch, invokeMock, pluginFetch } = await loadWithHost();
      const fetchFn = await getTauriFetch({ localServer: true });
      const res = await fetchFn('http://192.168.1.20:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      expect(res.status).toBe(200);
      expect(pluginFetch).not.toHaveBeenCalled();
      expect(sentClientConfig(invokeMock)).toMatchObject({
        method: 'POST',
        url: 'http://192.168.1.20:11434/api/chat',
        localServer: true,
      });
    });

    it('leaves other requests to loopback addresses unmarked', async () => {
      const { getTauriFetch, invokeMock } = await loadWithHost();
      const fetchFn = await getTauriFetch();
      await fetchFn('http://127.0.0.1:11434/api/tags');

      expect(sentClientConfig(invokeMock).localServer).toBeUndefined();
    });
  });
});
