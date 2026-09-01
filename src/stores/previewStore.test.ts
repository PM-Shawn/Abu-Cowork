import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { makeBatchKey, type BatchIdentity } from '@/types';
import {
  BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
  useBatchProgressStore,
} from './batchProgressStore';
import { getVisibleTabs, subagentTabId, usePreviewStore, type WorkspaceTab } from './previewStore';

function reset() {
  usePreviewStore.setState({
    tabs: [],
    activeTabId: null,
    focusTabId: null,
    menuOpen: false,
    appModalOpen: false,
    previewFilePath: null,
    chatWidth: null,
    reloadNonce: 0,
    fileTreeMode: false,
    currentConversationId: null,
    lastActiveTabByConversation: {},
  });
  useBatchProgressStore.setState({
    batches: {},
    activeVisibleBatchKey: undefined,
    richAccessClock: 0,
    richContentDiagnostics: {
      totalRetainedRichBytes: 0,
      retainedRichBytesCap: BATCH_PROGRESS_GLOBAL_RICH_CONTENT_BYTES,
      overageBytes: 0,
      evictionCount: 0,
      releasedBatchCount: 0,
      lastEvictedKey: undefined,
    },
  });
}

/** Ids of the current tabs, in order, for concise assertions. */
function kinds(): string[] {
  return usePreviewStore.getState().tabs.map((t) => `${t.kind}:${describeTab(t)}`);
}
function describeTab(t: WorkspaceTab): string {
  if (t.kind === 'preview') return t.filePath;
  if (t.kind === 'browser') return t.url;
  if (t.kind === 'subagent') return `${makeBatchKey(t.identity)}:${t.taskIndex}`;
  return '';
}

function identity(conversationId: string, batchToolCallId = 'tool-call'): BatchIdentity {
  return { conversationId, batchToolCallId };
}

function initBatch(identityValue: BatchIdentity) {
  useBatchProgressStore.getState().initBatch(identityValue, ['Subagent']);
}

function batch(identityValue: BatchIdentity) {
  return useBatchProgressStore.getState().batches[makeBatchKey(identityValue)];
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

  describe('openSummary', () => {
    it('creates a single summary tab at the FRONT and activates it', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openSummary();
      const s = usePreviewStore.getState();
      expect(s.tabs[0]).toMatchObject({ kind: 'summary' });
      expect(s.activeTabId).toBe(s.tabs[0].id);
      expect(s.previewFilePath).toBeNull();
    });

    it('dedups — a second openSummary activates the existing one, no new tab', () => {
      usePreviewStore.getState().openSummary();
      usePreviewStore.getState().openSummary();
      expect(usePreviewStore.getState().tabs.filter((t) => t.kind === 'summary')).toHaveLength(1);
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

    it('openBrowser adopts a main-provided id for agent browser views', () => {
      const id = usePreviewStore.getState().openBrowser('about:blank', 'agent-browser-1');
      expect(id).toBe('agent-browser-1');
      expect(usePreviewStore.getState().tabs).toEqual([
        { id: 'agent-browser-1', kind: 'browser', url: 'about:blank' },
      ]);
    });

    it('does not URL-dedupe a main-provided agent browser id', () => {
      const existingId = usePreviewStore.getState().openBrowser('about:blank');
      const agentId = usePreviewStore.getState().openBrowser('about:blank', 'agent-browser-2');

      expect(agentId).toBe('agent-browser-2');
      expect(agentId).not.toBe(existingId);
      expect(usePreviewStore.getState().tabs).toHaveLength(2);
      expect(usePreviewStore.getState().tabs[1]).toEqual({
        id: 'agent-browser-2',
        kind: 'browser',
        url: 'about:blank',
      });
    });

    it('adopting a new agent tab while the user is watching a browser tab adds it without stealing focus', () => {
      const watchedId = usePreviewStore.getState().openBrowser('https://user-is-watching.example');
      const agentId = usePreviewStore.getState().openBrowser('about:blank', 'agent-browser-focus-1');

      expect(agentId).toBe('agent-browser-focus-1');
      expect(usePreviewStore.getState().tabs).toHaveLength(2);
      expect(usePreviewStore.getState().tabs[1]).toEqual({
        id: 'agent-browser-focus-1',
        kind: 'browser',
        url: 'about:blank',
      });
      // Active tab stays the one the user was watching — not stolen by adoption.
      expect(usePreviewStore.getState().activeTabId).toBe(watchedId);
    });

    it('adopting a new agent tab while the active tab is not a browser tab activates it as before', () => {
      usePreviewStore.getState().openPreview('/a/b.html');
      expect(usePreviewStore.getState().tabs.find((t) => t.id === usePreviewStore.getState().activeTabId)?.kind).toBe('preview');

      const agentId = usePreviewStore.getState().openBrowser('about:blank', 'agent-browser-focus-2');

      expect(agentId).toBe('agent-browser-focus-2');
      expect(usePreviewStore.getState().activeTabId).toBe('agent-browser-focus-2');
    });

    it('adopting a new agent tab with no existing tabs activates it (single-task first-tab behavior unchanged)', () => {
      const agentId = usePreviewStore.getState().openBrowser('about:blank', 'agent-browser-focus-3');
      expect(usePreviewStore.getState().activeTabId).toBe(agentId);
    });

    it('re-adopting an already-existing requestedId still re-activates it (adoption-poll re-entry, not a new-tab event)', () => {
      usePreviewStore.getState().openBrowser('https://user-is-watching.example');
      const agentId = usePreviewStore.getState().openBrowser('about:blank', 'agent-browser-focus-4');
      // User looks back at the browser tab they were on.
      usePreviewStore.getState().activateTab(usePreviewStore.getState().tabs[0].id);
      // Main re-polls adoption for the same requestedId — should re-activate it.
      usePreviewStore.getState().openBrowser('about:blank', 'agent-browser-focus-4');
      expect(usePreviewStore.getState().activeTabId).toBe(agentId);
    });

    it('openTerminal always creates a new tab (never deduped)', () => {
      usePreviewStore.getState().openTerminal();
      usePreviewStore.getState().openTerminal();
      const s = usePreviewStore.getState();
      expect(s.tabs.filter((t) => t.kind === 'terminal')).toHaveLength(2);
      expect(s.previewFilePath).toBeNull();
    });
  });

  describe('openSubagent lifecycle', () => {
    it('uses identity+taskIndex as the tab id, dedupes, activates, focuses, and expands the panel', async () => {
      const { useSettingsStore } = await import('./settingsStore');
      const idn = identity('conv-subagent', 'batch-1');
      initBatch(idn);
      useSettingsStore.setState({ rightPanelCollapsed: true });

      const id = usePreviewStore.getState().openSubagent(idn, 0, 'Worker A');
      const duplicate = usePreviewStore.getState().openSubagent(idn, 0, 'Worker A');

      expect(id).toBe(subagentTabId(idn, 0));
      expect(duplicate).toBe(id);
      expect(usePreviewStore.getState().tabs).toHaveLength(1);
      expect(usePreviewStore.getState().activeTabId).toBe(id);
      expect(usePreviewStore.getState().focusTabId).toBe(id);
      expect(useSettingsStore.getState().rightPanelCollapsed).toBe(false);
      expect(batch(idn).viewLeaseCount).toBe(1);
      expect(useBatchProgressStore.getState().activeVisibleBatchKey).toBe(makeBatchKey(idn));
    });

    it('isolates two conversations with the same batch tool call id', () => {
      const a = identity('conv-a', 'shared');
      const b = identity('conv-b', 'shared');
      initBatch(a);
      initBatch(b);

      usePreviewStore.getState().openSubagent(a, 0, 'A');
      usePreviewStore.getState().openSubagent(b, 0, 'B');

      expect(usePreviewStore.getState().tabs.map((tab) => tab.id)).toEqual([
        subagentTabId(a, 0),
        subagentTabId(b, 0),
      ]);
      expect(batch(a).viewLeaseCount).toBe(0);
      expect(batch(b).viewLeaseCount).toBe(1);
    });

    it('holds a view lease only for the active subagent tab across tab lifecycle actions', () => {
      const a = identity('conv-close-a', 'batch');
      const b = identity('conv-close-b', 'batch');
      const c = identity('conv-close-c', 'batch');
      initBatch(a);
      initBatch(b);
      initBatch(c);
      const aTab = usePreviewStore.getState().openSubagent(a, 0, 'A');
      const bTab = usePreviewStore.getState().openSubagent(b, 0, 'B');
      usePreviewStore.getState().openSubagent(c, 0, 'C');

      usePreviewStore.getState().closeTab(bTab);
      expect(batch(a).viewLeaseCount).toBe(0);
      expect(batch(b).viewLeaseCount).toBe(0);
      expect(batch(c).viewLeaseCount).toBe(1);

      usePreviewStore.getState().closeOtherTabs(aTab);
      expect(batch(a).viewLeaseCount).toBe(1);
      expect(batch(c).viewLeaseCount).toBe(0);

      usePreviewStore.getState().closeAllTabs();
      expect(batch(a).viewLeaseCount).toBe(0);

      usePreviewStore.getState().openSubagent(a, 0, 'A');
      usePreviewStore.getState().closePreview();
      expect(batch(a).viewLeaseCount).toBe(0);
    });

    it('closes only subagent tabs owned by a deleted conversation and releases its active lease', () => {
      const deleted = identity('conv-deleted', 'shared');
      const survivor = identity('conv-survivor', 'shared');
      initBatch(deleted);
      initBatch(survivor);
      const deletedTab = usePreviewStore.getState().openSubagent(deleted, 0, 'Deleted');
      const survivorTab = usePreviewStore.getState().openSubagent(survivor, 0, 'Survivor');
      usePreviewStore.getState().activateTab(deletedTab);

      usePreviewStore.getState().closeSubagentTabsForConversation(deleted.conversationId);

      expect(usePreviewStore.getState().tabs.map((tab) => tab.id)).toEqual([survivorTab]);
      expect(usePreviewStore.getState().activeTabId).toBe(survivorTab);
      expect(batch(deleted).viewLeaseCount).toBe(0);
      expect(batch(survivor).viewLeaseCount).toBe(1);
    });

    it('updates active protection on subagent/non-subagent transitions without changing run state', () => {
      const idn = identity('conv-protect', 'batch');
      initBatch(idn);
      useBatchProgressStore.getState().setTaskRunning(idn, 0);
      usePreviewStore.getState().openSubagent(idn, 0, 'Agent');
      expect(useBatchProgressStore.getState().activeVisibleBatchKey).toBe(makeBatchKey(idn));

      usePreviewStore.getState().openBrowser('https://example.com');
      expect(useBatchProgressStore.getState().activeVisibleBatchKey).toBeUndefined();
      expect(batch(idn).viewLeaseCount).toBe(0);
      expect(batch(idn).runLeaseCount).toBe(1);
      expect(batch(idn).tasks[0].status).toBe('running');

      const subagentId = subagentTabId(idn, 0);
      usePreviewStore.getState().activateTab(subagentId);
      expect(useBatchProgressStore.getState().activeVisibleBatchKey).toBe(makeBatchKey(idn));
      expect(batch(idn).viewLeaseCount).toBe(1);
    });

    it('does not treat reorder as a rich-access event', () => {
      const idn = identity('conv-reorder', 'batch');
      initBatch(idn);
      const subagentId = usePreviewStore.getState().openSubagent(idn, 0, 'Agent');
      usePreviewStore.getState().openBrowser('https://example.com');
      const before = batch(idn).lastRichAccessTick;
      usePreviewStore.getState().reorderTabs(subagentId, usePreviewStore.getState().tabs[1].id);
      expect(batch(idn).lastRichAccessTick).toBe(before);
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

  // A browser tab's native WebContentsView is owned by the tab RECORD here, not
  // by the React component that renders it: removing the record destroys the
  // view, and nothing else may.
  describe('native browser view ownership', () => {
    // This suite runs in the `node` environment, so stub the desktop host
    // marker `isTauriEnv()` looks for on `window`.
    const runtime = globalThis as unknown as Record<string, unknown>;
    const invokeMock = vi.mocked(invoke);

    beforeEach(() => {
      runtime.window = { __TAURI_INTERNALS__: {} };
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
      delete runtime.window;
      invokeMock.mockReset();
    });

    it('closeTab destroys the native view behind a browser tab', () => {
      const id = usePreviewStore.getState().openBrowser('https://example.com');
      usePreviewStore.getState().closeTab(id);
      expect(invokeMock).toHaveBeenCalledWith('browser_close', { id });
    });

    it('closeTab of a non-browser tab touches no native view', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      const id = usePreviewStore.getState().tabs[0].id;
      usePreviewStore.getState().closeTab(id);
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('closeOtherTabs and closeAllTabs destroy every browser view they remove', () => {
      const kept = usePreviewStore.getState().openBrowser('https://kept.example');
      const dropped = usePreviewStore.getState().openBrowser('https://dropped.example');

      usePreviewStore.getState().closeOtherTabs(kept);
      expect(invokeMock).toHaveBeenCalledWith('browser_close', { id: dropped });
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', { id: kept });

      invokeMock.mockClear();
      usePreviewStore.getState().closeAllTabs();
      expect(invokeMock).toHaveBeenCalledWith('browser_close', { id: kept });
    });

    it('closeTabsForConversationSwitch keeps browser tabs and their views alive', () => {
      const browserId = usePreviewStore.getState().openBrowser('https://example.com');
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.getState().openSummary();
      usePreviewStore.getState().openTerminal();

      usePreviewStore.getState().closeTabsForConversationSwitch();

      const s = usePreviewStore.getState();
      expect(s.tabs.map((t) => t.id)).toEqual([browserId]);
      expect(s.activeTabId).toBe(browserId);
      expect(s.previewFilePath).toBeNull();
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it('closeTabsForConversationSwitch clears everything when no browser tab is open', () => {
      usePreviewStore.getState().openPreview('/a/1.md');
      usePreviewStore.setState({ chatWidth: 400 });

      usePreviewStore.getState().closeTabsForConversationSwitch();

      const s = usePreviewStore.getState();
      expect(s.tabs).toHaveLength(0);
      expect(s.activeTabId).toBeNull();
      expect(s.chatWidth).toBeNull();
    });
  });

  // An adopted agent browser tab belongs to the conversation that asked for it.
  // Its native view must stay alive across conversation switches (C1), but it
  // must only be listed/activatable in its owner's panel — otherwise switching
  // to another conversation shows that conversation someone else's live page.
  describe('conversation-scoped browser tabs', () => {
    const runtime = globalThis as unknown as Record<string, unknown>;
    const invokeMock = vi.mocked(invoke);

    beforeEach(() => {
      runtime.window = { __TAURI_INTERNALS__: {} };
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
      delete runtime.window;
      invokeMock.mockReset();
    });

    function ids(tabs: WorkspaceTab[]): string[] {
      return tabs.map((tab) => tab.id);
    }

    it('records the owner on an adopted tab and keeps it visible in its own conversation', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      const id = usePreviewStore.getState().openBrowser('about:blank', 'agent-a-1', 'conv-a');

      const s = usePreviewStore.getState();
      expect(s.tabs).toEqual([
        { id: 'agent-a-1', kind: 'browser', url: 'about:blank', ownerConversationId: 'conv-a' },
      ]);
      expect(ids(getVisibleTabs())).toEqual([id]);
      expect(s.activeTabId).toBe(id);
    });

    it('adoption for the CURRENT conversation still respects the no-steal rule', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      const watched = usePreviewStore.getState().openBrowser('https://user-is-watching.example');

      usePreviewStore.getState().openBrowser('about:blank', 'agent-a-2', 'conv-a');

      const s = usePreviewStore.getState();
      expect(ids(getVisibleTabs())).toEqual([watched, 'agent-a-2']);
      expect(s.activeTabId).toBe(watched);
    });

    it('adoption for a BACKGROUND conversation never enters this conversation view', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');
      usePreviewStore.getState().openSummary();
      const summaryId = usePreviewStore.getState().activeTabId;

      usePreviewStore.getState().openBrowser('https://baidu.com', 'agent-a-3', 'conv-a');

      const s = usePreviewStore.getState();
      // Present in the store (its native view is alive) but invisible here.
      expect(ids(s.tabs)).toContain('agent-a-3');
      expect(ids(getVisibleTabs())).toEqual([summaryId!]);
      expect(s.activeTabId).toBe(summaryId);
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', expect.anything());
    });

    it('adoption for a BACKGROUND conversation leaves an empty panel empty', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');

      usePreviewStore.getState().openBrowser('https://baidu.com', 'agent-a-4', 'conv-a');

      const s = usePreviewStore.getState();
      expect(getVisibleTabs()).toEqual([]);
      expect(s.activeTabId).toBeNull();
      expect(ids(s.tabs)).toEqual(['agent-a-4']);
    });

    it('an adopted tab with no owner (legacy) stays visible in every conversation', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openBrowser('about:blank', 'legacy-view');

      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');

      expect(ids(getVisibleTabs())).toEqual(['legacy-view']);
    });

    it('A → B → A hides then restores A’s tabs, keeping every native view alive', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openBrowser('https://one.example', 'agent-a-5', 'conv-a');
      usePreviewStore.getState().openBrowser('https://two.example', 'agent-a-6', 'conv-a');
      usePreviewStore.getState().activateTab('agent-a-6');

      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');
      const inB = usePreviewStore.getState();
      expect(getVisibleTabs()).toEqual([]);
      expect(inB.activeTabId).toBeNull();
      expect(ids(inB.tabs)).toEqual(['agent-a-5', 'agent-a-6']);

      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      const backInA = usePreviewStore.getState();
      expect(ids(getVisibleTabs())).toEqual(['agent-a-5', 'agent-a-6']);
      // A's last active tab comes back, not just the first one.
      expect(backInA.activeTabId).toBe('agent-a-6');
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', expect.anything());
    });

    it('activateTab cannot activate another conversation’s browser tab', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openBrowser('https://one.example', 'agent-a-7', 'conv-a');
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');
      usePreviewStore.getState().openSummary();
      const summaryId = usePreviewStore.getState().activeTabId;

      usePreviewStore.getState().activateTab('agent-a-7');

      expect(usePreviewStore.getState().activeTabId).toBe(summaryId);
    });

    it('closeAllTabs / closeOtherTabs only reach the tabs this conversation can see', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openBrowser('https://one.example', 'agent-a-8', 'conv-a');
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');
      usePreviewStore.getState().openSummary();
      usePreviewStore.getState().openBrowser('https://b.example', 'agent-b-1', 'conv-b');

      usePreviewStore.getState().closeOtherTabs('agent-b-1');
      expect(ids(usePreviewStore.getState().tabs)).toEqual(['agent-a-8', 'agent-b-1']);
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', { id: 'agent-a-8' });

      usePreviewStore.getState().closeAllTabs();
      const s = usePreviewStore.getState();
      expect(ids(s.tabs)).toEqual(['agent-a-8']);
      expect(getVisibleTabs()).toEqual([]);
      expect(invokeMock).toHaveBeenCalledWith('browser_close', { id: 'agent-b-1' });
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', { id: 'agent-a-8' });
    });

    // C2-I1 / N4 — a deleted conversation's browser tab is invisible in every
    // conversation's strip, so nothing in the UI can ever close it. The delete
    // cascade must remove the RECORD (the one thing that destroys the view).
    it('closeOwnedTabsForConversation destroys only the deleted conversation’s views', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');
      usePreviewStore.getState().openBrowser('https://a-one.example', 'agent-a-del-1', 'conv-a');
      usePreviewStore.getState().openBrowser('https://a-two.example', 'agent-a-del-2', 'conv-a');
      usePreviewStore.getState().openBrowser('https://b.example', 'agent-b-keep', 'conv-b');
      const paneTab = usePreviewStore.getState().openBrowser('https://user-opened.example');

      usePreviewStore.getState().closeOwnedTabsForConversation('conv-a');

      expect(ids(usePreviewStore.getState().tabs)).toEqual(['agent-b-keep', paneTab]);
      expect(invokeMock).toHaveBeenCalledWith('browser_close', { id: 'agent-a-del-1' });
      expect(invokeMock).toHaveBeenCalledWith('browser_close', { id: 'agent-a-del-2' });
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', { id: 'agent-b-keep' });
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', { id: paneTab });
    });

    it('closeOwnedTabsForConversation lands the active tab on a visible survivor', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openSummary();
      const summaryId = usePreviewStore.getState().activeTabId!;
      usePreviewStore.getState().openBrowser('https://a.example', 'agent-a-active', 'conv-a');
      usePreviewStore.getState().activateTab('agent-a-active');

      usePreviewStore.getState().closeOwnedTabsForConversation('conv-a');

      const s = usePreviewStore.getState();
      expect(ids(s.tabs)).toEqual([summaryId]);
      expect(s.activeTabId).toBe(summaryId);
    });

    it('closeOwnedTabsForConversation is a no-op when that conversation owns nothing', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openBrowser('https://a.example', 'agent-a-only', 'conv-a');

      usePreviewStore.getState().closeOwnedTabsForConversation('conv-untouched');

      expect(ids(usePreviewStore.getState().tabs)).toEqual(['agent-a-only']);
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', expect.anything());
    });

    // I1 — main withdraws an adoption (`browser://automation-cancel`) when the
    // run was stopped or the owning conversation was deleted. The record must go
    // even though it is invisible here: nothing else could ever remove it, and
    // it is what keeps the native view (and a mounted BrowserTab) alive.
    it('closeAdoptedBrowserTab drops a withdrawn tab from another conversation', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');
      usePreviewStore.getState().openBrowser('about:blank', 'agent-a-cancel', 'conv-a');
      usePreviewStore.getState().openBrowser('https://b.example', 'agent-b-keep', 'conv-b');

      usePreviewStore.getState().closeAdoptedBrowserTab('agent-a-cancel');

      expect(ids(usePreviewStore.getState().tabs)).toEqual(['agent-b-keep']);
      expect(invokeMock).toHaveBeenCalledWith('browser_close', { id: 'agent-a-cancel' });
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', { id: 'agent-b-keep' });
    });

    it('closeAdoptedBrowserTab re-activates a survivor when the withdrawn tab was active', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openSummary();
      const summaryId = usePreviewStore.getState().activeTabId!;
      usePreviewStore.getState().openBrowser('about:blank', 'agent-a-visible', 'conv-a');
      usePreviewStore.getState().activateTab('agent-a-visible');

      usePreviewStore.getState().closeAdoptedBrowserTab('agent-a-visible');

      const s = usePreviewStore.getState();
      expect(ids(s.tabs)).toEqual([summaryId]);
      expect(s.activeTabId).toBe(summaryId);
      expect(invokeMock).toHaveBeenCalledWith('browser_close', { id: 'agent-a-visible' });
    });

    it('closeAdoptedBrowserTab ignores an unknown id and never touches a non-browser tab', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openSummary();
      const summaryId = usePreviewStore.getState().activeTabId!;

      usePreviewStore.getState().closeAdoptedBrowserTab('no-such-tab');
      usePreviewStore.getState().closeAdoptedBrowserTab(summaryId);

      expect(ids(usePreviewStore.getState().tabs)).toEqual([summaryId]);
      expect(invokeMock).not.toHaveBeenCalledWith('browser_close', expect.anything());
    });

    it('a foreign-owned tab never keeps the panel wide or the chat width pinned', () => {
      usePreviewStore.getState().closeTabsForConversationSwitch('conv-a');
      usePreviewStore.getState().openBrowser('https://one.example', 'agent-a-9', 'conv-a');
      usePreviewStore.setState({ chatWidth: 400 });

      usePreviewStore.getState().closeTabsForConversationSwitch('conv-b');

      expect(usePreviewStore.getState().chatWidth).toBeNull();
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

  describe('right-panel expansion on open intent', () => {
    // Regression: with the panel collapsed but the tab still open, re-clicking
    // a chat file card changed no previewStore state, so RightPanel's
    // hasWideContent effect never re-fired and the panel stayed hidden.
    it('openPreview un-collapses the right panel even when the tab already exists and is active', async () => {
      const { useSettingsStore } = await import('./settingsStore');
      usePreviewStore.getState().openPreview('/proj/report.html');
      useSettingsStore.setState({ rightPanelCollapsed: true });
      usePreviewStore.getState().openPreview('/proj/report.html');
      expect(useSettingsStore.getState().rightPanelCollapsed).toBe(false);
    });

    it('openTerminal and user-invoked openBrowser un-collapse the right panel', async () => {
      const { useSettingsStore } = await import('./settingsStore');
      useSettingsStore.setState({ rightPanelCollapsed: true });
      usePreviewStore.getState().openTerminal();
      expect(useSettingsStore.getState().rightPanelCollapsed).toBe(false);

      useSettingsStore.setState({ rightPanelCollapsed: true });
      usePreviewStore.getState().openBrowser('https://example.com');
      expect(useSettingsStore.getState().rightPanelCollapsed).toBe(false);
    });

    it('agent browser-view adoption (openBrowser with requestedId) keeps the collapse state', async () => {
      const { useSettingsStore } = await import('./settingsStore');
      useSettingsStore.setState({ rightPanelCollapsed: true });
      usePreviewStore.getState().openBrowser('about:blank', '__abu-browser-automation__x');
      expect(useSettingsStore.getState().rightPanelCollapsed).toBe(true);
    });
  });
});
