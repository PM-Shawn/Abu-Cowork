import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn(), exists: vi.fn() }));

import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { expandHome, loadMarketplaceFromDir, MARKETPLACE_MANIFEST_CANDIDATES } from './loadMarketplace';

const mockRead = vi.mocked(readTextFile);
const mockExists = vi.mocked(exists);

function mountFiles(files: Record<string, string>) {
  mockExists.mockImplementation(async (p) => String(p) in files);
  mockRead.mockImplementation(async (p) => {
    const path = String(p);
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('expandHome', () => {
  it('expands a leading tilde like a shell does, and leaves other paths alone', () => {
    expect(expandHome('~/plugins/x', '/Users/tester')).toBe('/Users/tester/plugins/x');
    expect(expandHome('~', '/Users/tester')).toBe('/Users/tester');
    expect(expandHome('/abs/path', '/Users/tester')).toBe('/abs/path');
    // Not a home reference — a directory that merely starts with the character.
    expect(expandHome('~weird', '/Users/tester')).toBe('~weird');
  });
});

describe('loadMarketplaceFromDir', () => {
  it('parses .claude-plugin/marketplace.json for ecosystem compatibility', async () => {
    mountFiles({
      '/m/official/.claude-plugin/marketplace.json': JSON.stringify({
        name: 'official',
        plugins: [{ name: 'weather', source: './plugins/weather' }],
      }),
    });

    const marketplace = await loadMarketplaceFromDir('/m/official');
    expect(marketplace.name).toBe('official');
    expect(marketplace.plugins[0].source).toEqual({ kind: 'relative', path: './plugins/weather' });
  });

  it('prefers .abu-plugin so a marketplace can ship an Abu-specific listing', async () => {
    mountFiles({
      '/m/x/.abu-plugin/marketplace.json': JSON.stringify({ name: 'abu-listing', plugins: [] }),
      '/m/x/.claude-plugin/marketplace.json': JSON.stringify({ name: 'claude-listing', plugins: [] }),
    });

    expect((await loadMarketplaceFromDir('/m/x')).name).toBe('abu-listing');
  });

  it('names the paths it looked for when there is no manifest', async () => {
    mountFiles({});
    await expect(loadMarketplaceFromDir('/m/empty')).rejects.toThrow(/No marketplace manifest in \/m\/empty/);
  });

  it('reports malformed JSON with the offending path rather than a raw SyntaxError', async () => {
    mountFiles({ '/m/bad/.abu-plugin/marketplace.json': '{ not json' });
    await expect(loadMarketplaceFromDir('/m/bad')).rejects.toThrow(
      /not valid JSON: \/m\/bad\/\.abu-plugin\/marketplace\.json/,
    );
  });

  it('reads the Codex .agents/plugins/marketplace.json as a third candidate', async () => {
    mountFiles({
      '/m/.agents/plugins/marketplace.json': JSON.stringify({
        name: 'codex-m',
        owner: { name: 'o' },
        plugins: [],
      }),
    });
    const m = await loadMarketplaceFromDir('/m');
    expect(m.name).toBe('codex-m');
    expect(MARKETPLACE_MANIFEST_CANDIDATES[2]).toBe('.agents/plugins/marketplace.json');
  });
});
