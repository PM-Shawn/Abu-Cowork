import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Tauri APIs before importing the module
vi.mock('@tauri-apps/api/path', () => ({
  resolveResource: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
}));

describe('nodeRuntime', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getEmbeddedNodePath', () => {
    it('resolves bin/node on macOS', async () => {
      vi.doMock('./platform', () => ({
        isWindows: () => false,
        isMacOS: () => true,
        getPlatform: () => 'macos',
      }));
      const { resolveResource } = await import('@tauri-apps/api/path');
      const { exists } = await import('@tauri-apps/plugin-fs');
      vi.mocked(resolveResource).mockResolvedValue('/app/Resources/node-runtime/bin/node');
      vi.mocked(exists).mockResolvedValue(true);

      const { getEmbeddedNodePath } = await import('./nodeRuntime');
      const path = await getEmbeddedNodePath();
      expect(resolveResource).toHaveBeenCalledWith('node-runtime/bin/node');
      expect(path).toBe('/app/Resources/node-runtime/bin/node');
    });

    it('resolves node.exe on Windows', async () => {
      vi.doMock('./platform', () => ({
        isWindows: () => true,
        isMacOS: () => false,
        getPlatform: () => 'windows',
      }));
      const { resolveResource } = await import('@tauri-apps/api/path');
      const { exists } = await import('@tauri-apps/plugin-fs');
      vi.mocked(resolveResource).mockResolvedValue('C:\\app\\node-runtime\\node.exe');
      vi.mocked(exists).mockResolvedValue(true);

      const { getEmbeddedNodePath } = await import('./nodeRuntime');
      const path = await getEmbeddedNodePath();
      expect(resolveResource).toHaveBeenCalledWith('node-runtime/node.exe');
      expect(path).toBe('C:\\app\\node-runtime\\node.exe');
    });

    it('caches the resolved path (resolveResource called once)', async () => {
      const { resolveResource } = await import('@tauri-apps/api/path');
      const { exists } = await import('@tauri-apps/plugin-fs');
      vi.mocked(resolveResource).mockResolvedValue('/app/Resources/node-runtime/bin/node');
      vi.mocked(exists).mockResolvedValue(true);
      // The mock fn persists across tests (vi.mock is hoisted); reset the call
      // counter so this test measures only its own two calls.
      vi.mocked(resolveResource).mockClear();

      const { getEmbeddedNodePath } = await import('./nodeRuntime');
      await getEmbeddedNodePath();
      await getEmbeddedNodePath();
      expect(resolveResource).toHaveBeenCalledTimes(1);
    });

    it('returns null when neither bundled nor dev runtime exists', async () => {
      const { resolveResource } = await import('@tauri-apps/api/path');
      const { exists } = await import('@tauri-apps/plugin-fs');
      // Bundled resolveResource resolves a path but it does not exist; dev
      // candidates (via dynamic import of resolve) also do not exist.
      vi.mocked(resolveResource).mockResolvedValue('/app/Resources/node-runtime/bin/node');
      vi.mocked(exists).mockResolvedValue(false);

      const { getEmbeddedNodePath } = await import('./nodeRuntime');
      const path = await getEmbeddedNodePath();
      expect(path).toBeNull();
    });
  });

  describe('hasEmbeddedNode', () => {
    it('true when embedded node resolves', async () => {
      const { resolveResource } = await import('@tauri-apps/api/path');
      const { exists } = await import('@tauri-apps/plugin-fs');
      vi.mocked(resolveResource).mockResolvedValue('/app/Resources/node-runtime/bin/node');
      vi.mocked(exists).mockResolvedValue(true);

      const { hasEmbeddedNode } = await import('./nodeRuntime');
      expect(await hasEmbeddedNode()).toBe(true);
    });

    it('false when embedded node is unavailable', async () => {
      const { resolveResource } = await import('@tauri-apps/api/path');
      vi.mocked(resolveResource).mockRejectedValue(new Error('not found'));
      const { exists } = await import('@tauri-apps/plugin-fs');
      vi.mocked(exists).mockResolvedValue(false);

      const { hasEmbeddedNode } = await import('./nodeRuntime');
      expect(await hasEmbeddedNode()).toBe(false);
    });
  });
});
