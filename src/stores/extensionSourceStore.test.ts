// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SOURCES, useExtensionSourceStore } from './extensionSourceStore';

/**
 * 市场 | 我的, remembered per tab. 市场 is the default everywhere because it is
 * the only shelf a fresh install has anything on; each tab then remembers the
 * user's own last pick across restarts, which is what makes it persisted state
 * rather than component state.
 */
describe('extensionSourceStore', () => {
  beforeEach(() => {
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    localStorage.removeItem('abu-extension-source');
  });

  it('starts every tab on 市场', () => {
    expect(useExtensionSourceStore.getState().sources).toEqual({
      plugins: 'market', skills: 'market', mcp: 'market', members: 'market', teams: 'market',
    });
  });

  it('setSource changes only the tab it names', () => {
    useExtensionSourceStore.getState().setSource('skills', 'mine');
    expect(useExtensionSourceStore.getState().sources).toEqual({ ...DEFAULT_SOURCES, skills: 'mine' });
  });

  it('persists the picks under abu-extension-source, and nothing else', () => {
    useExtensionSourceStore.getState().setSource('teams', 'mine');
    const raw = localStorage.getItem('abu-extension-source');
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!) as { state: Record<string, unknown>; version: number };
    // Only the picks are written — `setSource` is a function, and a persisted
    // one would come back as dead JSON and shadow the real action.
    expect(Object.keys(persisted.state)).toEqual(['sources']);
    expect(persisted.state.sources).toEqual({ ...DEFAULT_SOURCES, teams: 'mine' });
    expect(persisted.version).toBe(1);
  });
});
