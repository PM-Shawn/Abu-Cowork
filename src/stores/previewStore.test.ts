import { describe, it, expect, beforeEach } from 'vitest';
import { usePreviewStore, type WorkspaceTab } from './previewStore';

function reset() {
  usePreviewStore.setState({
    tabs: [],
    activeTabId: null,
    previewFilePath: null,
    chatWidth: null,
    reloadNonce: 0,
    fileTreeMode: false,
  });
}

/** Ids of the current tabs, in order, for concise assertions. */
function kinds(): string[] {
  return usePreviewStore.getState().tabs.map((t) => `${t.kind}:${describeTab(t)}`);
}
function describeTab(t: WorkspaceTab): string {
  if (t.kind === 'preview') return t.filePath;
  if (t.kind === 'browser') return t.url;
  return '';
}

describe('previewStore', () => {
  beforeEach(reset);

  describe('reloadNonce (legacy signal)', () => {
    it('starts at 0 and increments per refreshPreview call', () => {
      expect(usePreviewStore.getState().reloadNonce).toBe(0);
      usePreviewStore.getState().refreshPreview();
      usePreviewStore.getState().refreshPreview();
      expect(usePreviewStore.getState().reloadNonce).toBe(2);
    });
  });

  describe('openPreview', () => {
    it('creates a preview tab, activates it, and syncs previewFilePath', () => {
      usePreviewStore.getState().openPreview('/a/b.html');
      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0]).toMatchObject({ kind: 'preview', filePath: '/a/b.html' });
      expect(s.activeTabId).toBe(s.tabs[0].id);
      expect(s.previewFilePath).toBe('/a/b.html');
    });

    it('dedups by filePath — re-opening the same path activates the existing tab, no new tab', () => {
      usePreviewStore.getState().openPreview('/a/b.html');
      usePreviewStore.getState().openPreview('/a/c.html');
      usePreviewStore.getState().openPreview('/a/b.html');
      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(2);
      expect(s.previewFilePath).toBe('/a/b.html');
    });

    it('opens multiple distinct files as coexisting tabs', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openPreview('/a/2.md');
      usePreviewStore.getState().openPreview('/a/3.md');
      expect(usePreviewStore.getState().tabs).toHaveLength(3);
    });
  });

  describe('openBrowser / openTerminal', () => {
    it('openBrowser creates a browser tab and nulls previewFilePath', () => {
      usePreviewStore.getState().openPreview('/a/b.html');
      usePreviewStore.getState().openBrowser('http://localhost:5173');
      const s = usePreviewStore.getState();
      expect(s.tabs.at(-1)).toMatchObject({ kind: 'browser', url: 'http://localhost:5173' });
      expect(s.previewFilePath).toBeNull();
    });

    it('openBrowser dedups by url', () => {
      usePreviewStore.getState().openBrowser('http://x');
      usePreviewStore.getState().openBrowser('http://x');
      expect(usePreviewStore.getState().tabs).toHaveLength(1);
    });

    it('openTerminal always creates a new tab (never deduped)', () => {
      usePreviewStore.getState().openTerminal();
      usePreviewStore.getState().openTerminal();
      const s = usePreviewStore.getState();
      expect(s.tabs.filter((t) => t.kind === 'terminal')).toHaveLength(2);
      expect(s.previewFilePath).toBeNull();
    });
  });

  describe('activateTab', () => {
    it('switches active + resyncs previewFilePath (null for non-preview)', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      const previewId = usePreviewStore.getState().tabs[0].id;
      usePreviewStore.getState().openTerminal();
      expect(usePreviewStore.getState().previewFilePath).toBeNull();
      usePreviewStore.getState().activateTab(previewId);
      expect(usePreviewStore.getState().previewFilePath).toBe('/a/1.md');
    });

    it('is a no-op for an unknown id', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      const before = usePreviewStore.getState().activeTabId;
      usePreviewStore.getState().activateTab('nope');
      expect(usePreviewStore.getState().activeTabId).toBe(before);
    });
  });

  describe('closeTab', () => {
    it('activates the next tab when the active one is closed', () => {
      usePreviewStore.getState().openPreview('/a/1.md'); // idx0
      usePreviewStore.getState().openPreview('/a/2.md'); // idx1
      usePreviewStore.getState().openPreview('/a/3.md'); // idx2 (active)
      const [t0, t1] = usePreviewStore.getState().tabs;
      usePreviewStore.getState().activateTab(t1.id); // active = middle
      usePreviewStore.getState().closeTab(t1.id);
      // next (was idx2 /3.md) shifts into the slot and becomes active
      expect(usePreviewStore.getState().previewFilePath).toBe('/a/3.md');
      expect(usePreviewStore.getState().tabs.map((t) => t.id)).not.toContain(t1.id);
      expect(usePreviewStore.getState().tabs[0].id).toBe(t0.id);
    });

    it('falls back to the previous tab when closing the last (active) tab', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openPreview('/a/2.md'); // active, last
      const last = usePreviewStore.getState().tabs[1];
      usePreviewStore.getState().closeTab(last.id);
      expect(usePreviewStore.getState().previewFilePath).toBe('/a/1.md');
    });

    it('closing the only tab nulls active + previewFilePath + chatWidth', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.setState({ chatWidth: 400 });
      const id = usePreviewStore.getState().tabs[0].id;
      usePreviewStore.getState().closeTab(id);
      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(0);
      expect(s.activeTabId).toBeNull();
      expect(s.previewFilePath).toBeNull();
      expect(s.chatWidth).toBeNull();
    });

    it('closing an inactive tab leaves the active one untouched', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openPreview('/a/2.md'); // active
      const [t0] = usePreviewStore.getState().tabs;
      usePreviewStore.getState().closeTab(t0.id);
      expect(usePreviewStore.getState().previewFilePath).toBe('/a/2.md');
    });
  });

  describe('closeOtherTabs / closeAllTabs', () => {
    it('closeOtherTabs keeps only the given tab and activates it', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openPreview('/a/2.md');
      usePreviewStore.getState().openTerminal();
      const keep = usePreviewStore.getState().tabs[1];
      usePreviewStore.getState().closeOtherTabs(keep.id);
      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.activeTabId).toBe(keep.id);
      expect(s.previewFilePath).toBe('/a/2.md');
    });

    it('closeAllTabs empties everything (closePreview is an alias)', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openTerminal();
      usePreviewStore.getState().closePreview();
      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(0);
      expect(s.activeTabId).toBeNull();
      expect(s.previewFilePath).toBeNull();
    });
  });

  describe('reorderTabs', () => {
    it('moves a tab to another tab position', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openPreview('/a/2.md');
      usePreviewStore.getState().openPreview('/a/3.md');
      const [t0, , t2] = usePreviewStore.getState().tabs;
      usePreviewStore.getState().reorderTabs(t2.id, t0.id); // move 3 to front
      expect(kinds()).toEqual(['preview:/a/3.md', 'preview:/a/1.md', 'preview:/a/2.md']);
    });

    it('is a no-op for unknown ids or same-position', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openPreview('/a/2.md');
      const [t0] = usePreviewStore.getState().tabs;
      usePreviewStore.getState().reorderTabs(t0.id, 'nope');
      usePreviewStore.getState().reorderTabs(t0.id, t0.id);
      expect(kinds()).toEqual(['preview:/a/1.md', 'preview:/a/2.md']);
    });
  });

  describe('updateBrowserUrl', () => {
    it('updates only the matching browser tab', () => {
      usePreviewStore.getState().openBrowser('http://a');
      const id = usePreviewStore.getState().tabs[0].id;
      usePreviewStore.getState().updateBrowserUrl(id, 'http://b');
      expect(describeTab(usePreviewStore.getState().tabs[0])).toBe('http://b');
    });
  });

  describe('closePreviewTabsForPath (file-tree delete)', () => {
    it('closes the preview tab for an exact file path, leaving other tabs alive', () => {
      usePreviewStore.getState().openPreview('/proj/a.md');
      usePreviewStore.getState().openPreview('/proj/b.md');
      usePreviewStore.getState().openTerminal();
      usePreviewStore.getState().closePreviewTabsForPath('/proj/a.md');
      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(2);
      expect(s.tabs.some((t) => t.kind === 'preview' && t.filePath === '/proj/a.md')).toBe(false);
      expect(s.tabs.some((t) => t.kind === 'terminal')).toBe(true); // terminal survives!
    });

    it('closes ALL preview tabs under a deleted folder (active + hidden)', () => {
      usePreviewStore.getState().openPreview('/proj/src/x.ts');
      usePreviewStore.getState().openPreview('/proj/src/y.ts');
      usePreviewStore.getState().openPreview('/proj/readme.md'); // outside folder, active
      usePreviewStore.getState().closePreviewTabsForPath('/proj/src');
      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0]).toMatchObject({ filePath: '/proj/readme.md' });
    });

    it('re-activates a survivor when the active tab is closed', () => {
      usePreviewStore.getState().openPreview('/proj/a.md'); // survivor
      usePreviewStore.getState().openPreview('/proj/gone.md'); // active, will be deleted
      usePreviewStore.getState().closePreviewTabsForPath('/proj/gone.md');
      expect(usePreviewStore.getState().previewFilePath).toBe('/proj/a.md');
    });

    it('is a no-op when no tab matches', () => {
      usePreviewStore.getState().openPreview('/proj/a.md');
      usePreviewStore.getState().closePreviewTabsForPath('/proj/other.md');
      expect(usePreviewStore.getState().tabs).toHaveLength(1);
    });
  });

  describe('retargetPreviewPath (file-tree rename)', () => {
    it('re-points a renamed file in place (no new tab)', () => {
      usePreviewStore.getState().openPreview('/proj/old.md');
      usePreviewStore.getState().retargetPreviewPath('/proj/old.md', '/proj/new.md');
      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(1);
      expect(s.tabs[0]).toMatchObject({ filePath: '/proj/new.md' });
      expect(s.previewFilePath).toBe('/proj/new.md');
    });

    it('remaps files under a renamed folder across all tabs (active + hidden)', () => {
      usePreviewStore.getState().openPreview('/proj/old/a.ts');
      usePreviewStore.getState().openPreview('/proj/old/sub/b.ts');
      usePreviewStore.getState().openPreview('/proj/keep.md'); // active, unaffected
      usePreviewStore.getState().retargetPreviewPath('/proj/old', '/proj/renamed');
      expect(kinds()).toEqual([
        'preview:/proj/renamed/a.ts',
        'preview:/proj/renamed/sub/b.ts',
        'preview:/proj/keep.md',
      ]);
    });

    it('is a no-op when no tab matches', () => {
      usePreviewStore.getState().openPreview('/proj/a.md');
      usePreviewStore.getState().retargetPreviewPath('/proj/other.md', '/proj/x.md');
      expect(usePreviewStore.getState().tabs[0]).toMatchObject({ filePath: '/proj/a.md' });
    });
  });
});
