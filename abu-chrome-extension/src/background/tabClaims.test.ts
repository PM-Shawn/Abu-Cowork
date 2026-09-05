/**
 * Task-level tab claims in the Chrome extension channel.
 *
 * The contract under test is the extension-side reading of
 * `electron/browserHost.cjs`'s ownership rules (see `tabClaims.ts`'s header for
 * the side-by-side table). Before it, every handler resolved its target from a
 * bare numeric `tabId` and fell back to the user's last active tab, so two
 * tasks could drive the same signed-in page and a tabId-less `query_js`
 * followed the user around their browser.
 *
 * `chrome.*` is injected as a fake rather than mocked globally: the fake also
 * records every call, which is how "refused with zero side effects" is asserted
 * (a refusal must not reach `tabs.update` / `tabs.sendMessage`, and must not
 * write to the claim table either).
 */

import { describe, expect, it } from 'vitest';
import {
  NO_ACTIVE_TAB_MESSAGE,
  NO_CLAIMED_TAB_MESSAGE,
  classifyInbound,
  createTabClaimStore,
  makeOwner,
  resolveTargetTab,
  type TabClaimStore,
  type TabResolutionDeps,
} from './tabClaims';

const CONVERSATION_A = 'conversation-a';
const CONVERSATION_B = 'conversation-b';
const RUN_1 = 'sar-1';
const RUN_2 = 'sar-2';

/** Fixed clock — `claimedAt` must never be read from the real one (TESTING.md §3). */
const NOW = 1_700_000_000_000;

/**
 * The slice of `chrome.tabs` the background script uses, plus a call log.
 * `open` is the set of live tab ids; `close()` is the user closing a tab.
 */
function fakeChrome(open: number[], lastActive: number | null = null) {
  const live = new Set(open);
  const calls: string[] = [];
  return {
    calls,
    live,
    close(tabId: number) {
      live.delete(tabId);
    },
    tabs: {
      async get(tabId: number) {
        calls.push(`get:${tabId}`);
        if (!live.has(tabId)) throw new Error(`No tab with id: ${tabId}`);
        return { id: tabId, windowId: 1, active: false };
      },
      async update(tabId: number) {
        calls.push(`update:${tabId}`);
        return { id: tabId };
      },
      sendMessage(tabId: number) {
        calls.push(`sendMessage:${tabId}`);
      },
    },
    lastActiveTabId: () => lastActive,
  };
}

function depsFor(chrome: ReturnType<typeof fakeChrome>): TabResolutionDeps {
  return {
    tabExists: async (tabId) => {
      try {
        await chrome.tabs.get(tabId);
        return true;
      } catch {
        return false;
      }
    },
    lastActiveTabId: chrome.lastActiveTabId,
    now: () => NOW,
  };
}

/** One request as the bridge sends it: action + payload carrying the owner. */
function resolve(
  store: TabClaimStore,
  chrome: ReturnType<typeof fakeChrome>,
  action: string,
  payload: Record<string, unknown>,
) {
  return resolveTargetTab(store, action, payload, depsFor(chrome));
}

describe('task-level tab claims', () => {
  it('gives two conversations their own tab and never crosses them', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11, 22]);

    expect(await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A })).toBe(11);
    expect(await resolve(store, chrome, 'click', { tabId: 22, ownerId: CONVERSATION_B })).toBe(22);

    expect(store.holderOf(11)?.conversationId).toBe(CONVERSATION_A);
    expect(store.holderOf(22)?.conversationId).toBe(CONVERSATION_B);
    expect(store.currentTabOf(makeOwner(CONVERSATION_A))).toBe(11);
    expect(store.currentTabOf(makeOwner(CONVERSATION_B))).toBe(22);
  });

  it('refuses an explicit tabId another conversation holds, naming the holder, with zero side effects', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11]);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A });

    const before = store.entries();
    chrome.calls.length = 0;

    await expect(
      resolve(store, chrome, 'fill', { tabId: 11, ownerId: CONVERSATION_B }),
    ).rejects.toThrow(
      `Browser tab 11 belongs to another conversation's task (${CONVERSATION_A}).`,
    );

    // Ownership untouched, B given no current tab, and nothing was driven:
    // the only chrome call a refusal may make is the liveness probe.
    expect(store.entries()).toEqual(before);
    expect(store.holderOf(11)?.conversationId).toBe(CONVERSATION_A);
    expect(store.currentTabOf(makeOwner(CONVERSATION_B))).toBeNull();
    expect(chrome.calls).toEqual(['get:11']);
  });

  it('lets a sibling run of the same conversation act on an explicitly named tab, without moving ownership', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11]);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A, runId: RUN_1 });

    expect(
      await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A, runId: RUN_2 }),
    ).toBe(11);

    expect(store.holderOf(11)?.runKey).toBe(RUN_1);
    expect(store.currentTabOf(makeOwner(CONVERSATION_A, RUN_2))).toBe(11);
  });

  it("falls back to the task's own tab when tabId is omitted, never to the user's active tab", async () => {
    const store = createTabClaimStore();
    // 99 is where the USER is; the task claimed 11.
    const chrome = fakeChrome([11, 99], 99);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A });

    expect(await resolve(store, chrome, 'get_html', { ownerId: CONVERSATION_A })).toBe(11);
  });

  it("tells a task with no tab of its own to call get_tabs, rather than reaching for the user's page", async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([99], 99);

    await expect(resolve(store, chrome, 'get_html', { ownerId: CONVERSATION_A })).rejects.toThrow(
      NO_CLAIMED_TAB_MESSAGE,
    );
  });

  it('reports a closed tab as gone instead of switching to another one', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11, 99], 99);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A });

    chrome.close(11);

    await expect(
      resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A }),
    ).rejects.toThrow('Browser tab 11 is no longer open');
    // The tabId-less path answers the same way rather than drifting onto 99.
    await expect(resolve(store, chrome, 'get_html', { ownerId: CONVERSATION_A })).rejects.toThrow(
      'Browser tab 11 is no longer open',
    );
  });

  it('drops a claim when the tab closes, so the tab is claimable again', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11]);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A });

    // What `chrome.tabs.onRemoved` does in the background script.
    store.releaseTab(11);

    expect(store.holderOf(11)).toBeNull();
    expect(store.currentTabOf(makeOwner(CONVERSATION_A))).toBeNull();
  });

  it("lets another conversation claim a tab once the holder's run is released", async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11]);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A, runId: RUN_1 });

    expect(store.releaseOwner(CONVERSATION_A, RUN_1)).toBe(1);

    expect(await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_B })).toBe(11);
    expect(store.holderOf(11)?.conversationId).toBe(CONVERSATION_B);
  });

  it('releases every run of a conversation when no runId is given', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11, 12]);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A, runId: RUN_1 });
    await resolve(store, chrome, 'click', { tabId: 12, ownerId: CONVERSATION_A, runId: RUN_2 });

    expect(store.releaseOwner(CONVERSATION_A)).toBe(2);
    expect(store.entries()).toEqual([]);
  });

  it('keeps the pre-ownership behaviour for a request that carries no ownerId', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11, 99], 99);
    // A claimed tab must not make the legacy path refuse or re-target.
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A });

    expect(await resolve(store, chrome, 'get_html', {})).toBe(99);
    expect(await resolve(store, chrome, 'click', { tabId: 11 })).toBe(11);
    // …and it claims nothing on the way through.
    expect(store.holderOf(99)).toBeNull();
    expect(store.holderOf(11)?.conversationId).toBe(CONVERSATION_A);
  });

  it('keeps the pre-ownership error when no owner and no active tab exist', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([], null);

    await expect(resolve(store, chrome, 'get_html', {})).rejects.toThrow(NO_ACTIVE_TAB_MESSAGE);
  });

  it('accepts a stringified tabId, the way the host coerces it', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11]);

    expect(await resolve(store, chrome, 'click', { tabId: '11', ownerId: CONVERSATION_A })).toBe(11);
  });
});

describe('inbound message classification', () => {
  it('routes an untyped message to the request path, unchanged', () => {
    expect(classifyInbound({ id: 'r1', action: 'click', payload: {} })).toEqual({ kind: 'request' });
    expect(classifyInbound({ id: 'r1' })).toEqual({ kind: 'request' });
  });

  it("recognises the bridge's cancel and release messages", () => {
    expect(classifyInbound({ type: 'cancel', requestId: 'req_1' })).toEqual({
      kind: 'cancel',
      requestId: 'req_1',
    });
    expect(classifyInbound({ type: 'release', ownerId: CONVERSATION_A, runId: RUN_1 })).toEqual({
      kind: 'release',
      ownerId: CONVERSATION_A,
      runId: RUN_1,
    });
    expect(classifyInbound({ type: 'release', ownerId: CONVERSATION_A })).toEqual({
      kind: 'release',
      ownerId: CONVERSATION_A,
      runId: undefined,
    });
  });

  it('does not mistake an unknown or malformed control message for a request', () => {
    expect(classifyInbound({ type: 'something-new' })).toEqual({
      kind: 'unknown',
      type: 'something-new',
    });
    expect(classifyInbound({ type: 'release' })).toEqual({ kind: 'unknown', type: 'release' });
  });
});
