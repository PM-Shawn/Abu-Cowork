import { describe, it, expect, beforeEach } from 'vitest';

// Note: @tauri-apps/plugin-http is globally mocked in src/test/setup.ts.
// In happy-dom, window.__TAURI_INTERNALS__ is undefined, so getTauriFetch()
// should short-circuit and return globalThis.fetch without importing the plugin.

describe('getTauriFetch', () => {
  beforeEach(async () => {
    // Reset module cache so _loadPromise singleton is cleared between tests
    const { vi } = await import('vitest');
    vi.resetModules();
    // Ensure __TAURI_INTERNALS__ is absent (already absent in happy-dom)
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('returns globalThis.fetch when __TAURI_INTERNALS__ is absent (web/E2E mode)', async () => {
    // Dynamic import after resetModules() gives a fresh module with cleared singleton
    const { getTauriFetch } = await import('./tauriFetch');
    const fetchFn = await getTauriFetch();
    expect(fetchFn).toBe(globalThis.fetch);
  });
});
