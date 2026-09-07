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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NO_ACTIVE_TAB_MESSAGE,
  NO_CLAIMED_TAB_MESSAGE,
  TAB_TARGETED_ACTIONS,
  classifyInbound,
  createTabClaimStore,
  makeOwner,
  resolveTargetTab,
  tabListingFor,
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

    // The tabId-less path says the tab is gone rather than drifting onto 99,
    // the tab the user is on.
    await expect(resolve(store, chrome, 'get_html', { ownerId: CONVERSATION_A })).rejects.toThrow(
      'Browser tab 11 is no longer open',
    );
  });

  it('forgets a claim on the tab it just proved is gone, on both paths', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11, 22], 99);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A });

    // The tab closed while `chrome.tabs.onRemoved` did not run — a service
    // worker restart between the two is enough. Naming it explicitly must not
    // leave a claim standing on a tab we have just proved is dead: the id can
    // be handed to a new tab, and until then it refuses everyone else.
    chrome.close(11);
    await expect(
      resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A }),
    ).rejects.toThrow('Browser tab 11 is no longer open');

    expect(store.holderOf(11)).toBeNull();
    expect(store.currentTabOf(makeOwner(CONVERSATION_A))).toBeNull();
    // …so when Chrome hands that id to a new tab, B gets it instead of being
    // refused by a ghost that nothing was ever going to clear.
    chrome.live.add(11);
    expect(await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_B })).toBe(11);
    expect(store.holderOf(11)?.conversationId).toBe(CONVERSATION_B);
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

  it("frees the main loop's tab at its run settlement without touching a delegation's", async () => {
    // The shape the app actually puts on the wire now: its run-settlement
    // notification always carries a run key, and the conversation's own loop
    // sends `main` (`abu/runKey`'s "absent ⇒ main" default, resolved on the
    // bridge). A settling main loop must not strip a subagent run that is
    // still driving its own page.
    const store = createTabClaimStore();
    const chrome = fakeChrome([11, 12]);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A });
    await resolve(store, chrome, 'click', { tabId: 12, ownerId: CONVERSATION_A, runId: RUN_1 });

    expect(store.releaseOwner(CONVERSATION_A, 'main')).toBe(1);

    expect(store.holderOf(11)).toBeNull();
    expect(store.holderOf(12)?.runKey).toBe(RUN_1);
    // Freed, so the next conversation to ask for it gets it.
    expect(await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_B })).toBe(11);
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

  it('drops every claim when the bridge connection goes away', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11, 22]);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A, runId: RUN_1 });
    await resolve(store, chrome, 'click', { tabId: 22, ownerId: CONVERSATION_B });

    // What `socket.onclose` does: the owner ids only mean anything for the
    // bridge connection that minted them, so nothing survives it.
    store.releaseAll();

    expect(store.entries()).toEqual([]);
    expect(store.holderOf(11)).toBeNull();
    expect(store.currentTabOf(makeOwner(CONVERSATION_A, RUN_1))).toBeNull();
    expect(store.currentTabOf(makeOwner(CONVERSATION_B))).toBeNull();
  });

  it('refuses an owned request that names no tab and cannot fall back', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([11, 99], 99);
    await resolve(store, chrome, 'click', { tabId: 11, ownerId: CONVERSATION_A });

    // Only `get_html` may fall back to the owner's current tab (the host has
    // the same single exception). Everything else must name its target — and
    // must NOT quietly act on tab 11 just because the task holds it.
    await expect(resolve(store, chrome, 'click', { ownerId: CONVERSATION_A })).rejects.toThrow(
      'Missing tabId for browser action "click".',
    );
  });

  it('refuses a legacy request that names no tab for an action that never had a fallback', async () => {
    const store = createTabClaimStore();
    const chrome = fakeChrome([99], 99);

    // `screenshot` was never in the last-active-tab group, so a legacy caller
    // omitting `tabId` got an error before claims existed too.
    await expect(resolve(store, chrome, 'screenshot', {})).rejects.toThrow(
      'Missing tabId for browser action "screenshot".',
    );
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

/**
 * `get_tabs` is the ONE place a model learns which tab to act on. Resolution
 * refusing to follow the user is only half the fix: a listing that reports the
 * user's active page as "your current tab" hands the same retarget back as an
 * explicit recommendation, and the first action on it would claim the user's
 * page for good.
 *
 * The listing itself stays complete (see `tabListingFor`'s note on why this
 * diverges from the host's owner-filtered list) — a claimed tab is marked, not
 * hidden. `USER_TAB` below is the tab the user is looking at; a fallback thunk
 * that returns it stands in for the legacy `lastActiveTabId` path, so any test
 * where an owned caller sees `USER_TAB` is a test that caught the regression.
 */
describe('get_tabs listing', () => {
  const USER_TAB = 99;
  const userActive = () => USER_TAB;

  it("reports the task's own current tab, never the user's active one", () => {
    const store = createTabClaimStore();
    store.claim(11, makeOwner(CONVERSATION_A), NOW);
    store.touch(11, makeOwner(CONVERSATION_A));

    const listing = tabListingFor(store, makeOwner(CONVERSATION_A), [11, 22, USER_TAB], userActive);

    expect(listing.currentTabId).toBe(11);
  });

  it('gives a task that has acted on nothing no current tab at all', () => {
    const store = createTabClaimStore();
    store.claim(11, makeOwner(CONVERSATION_A), NOW);
    store.touch(11, makeOwner(CONVERSATION_A));

    // B holds nothing. The honest answer is "none" — the same answer the host
    // gives, and what makes a bare `query_js` say so rather than reach for the
    // user's page.
    const listing = tabListingFor(store, makeOwner(CONVERSATION_B), [11, 22, USER_TAB], userActive);

    expect(listing.currentTabId).toBeNull();
  });

  it('drops a current tab that is no longer in the listing', () => {
    const store = createTabClaimStore();
    store.claim(11, makeOwner(CONVERSATION_A), NOW);
    store.touch(11, makeOwner(CONVERSATION_A));

    const listing = tabListingFor(store, makeOwner(CONVERSATION_A), [22, USER_TAB], userActive);

    expect(listing.currentTabId).toBeNull();
  });

  it('marks who is driving each tab without hiding any of them', () => {
    const store = createTabClaimStore();
    store.claim(11, makeOwner(CONVERSATION_A, RUN_1), NOW);
    store.claim(22, makeOwner(CONVERSATION_A, RUN_2), NOW);
    store.claim(33, makeOwner(CONVERSATION_B), NOW);

    const listing = tabListingFor(
      store,
      makeOwner(CONVERSATION_A, RUN_1),
      [11, 22, 33, USER_TAB],
      userActive,
    );

    // A sibling run counts as "someone else is driving this" too: the listing
    // is not how a hand-over is discovered (the parent names the id).
    expect(listing.ownership.get(11)).toBe('you');
    expect(listing.ownership.get(22)).toBe('other');
    expect(listing.ownership.get(33)).toBe('other');
    // Unclaimed tabs carry no marker, and NOTHING is hidden: every tab the
    // user has open is still listed, whoever holds it.
    expect(listing.ownership.has(USER_TAB)).toBe(false);
    expect(listing.ownership.size).toBe(3);
  });

  it("leaves a caller that sent no ownerId with exactly the pre-claims listing", () => {
    const store = createTabClaimStore();
    store.claim(11, makeOwner(CONVERSATION_A), NOW);

    const listing = tabListingFor(store, makeOwner(undefined), [11, USER_TAB], userActive);

    // The legacy path still answers with the user's active tab, and shows no
    // ownership marks at all — its response shape is untouched.
    expect(listing.currentTabId).toBe(USER_TAB);
    expect(listing.ownership.size).toBe(0);
  });
});

/**
 * The gate is only as complete as this set: an action that acts on one tab but
 * is missing from it resolves nothing, so its handler would read `payload.tabId`
 * raw and skip ownership entirely — silently, with no gate anywhere to notice.
 *
 * So the set is re-derived here from the other end of the wire: every action the
 * bridge sends with a `tabId` in its payload. Reading `tools.ts` as text (rather
 * than importing it, which would pull in the MCP server and zod) keeps this
 * deterministic — a file read, no network, no clock.
 */
describe('TAB_TARGETED_ACTIONS', () => {
  /** Every `sendWithSignal(transport, '<action>', { … })` whose payload names a tabId. */
  function bridgeActionsCarryingTabId(source: string): string[] {
    const found = new Set<string>();
    const marker = 'sendWithSignal(';
    for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
      const rest = source.slice(at + marker.length);
      const head = /^\s*transport\s*,\s*'([a-z_]+)'\s*,\s*/.exec(rest);
      if (!head) continue; // the helper's own definition, or a non-literal call
      const payloadStart = rest.slice(head[0].length);
      if (payloadStart[0] !== '{') continue; // payload is not an object literal
      let depth = 0;
      let end = -1;
      for (let i = 0; i < payloadStart.length; i += 1) {
        if (payloadStart[i] === '{') depth += 1;
        else if (payloadStart[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) continue;
      if (/\btabId\b/.test(payloadStart.slice(0, end + 1))) found.add(head[1]);
    }
    return Array.from(found).sort();
  }

  it("matches the bridge's own list of tab-targeted tools", () => {
    const toolsPath = fileURLToPath(new URL('../../../abu-browser-bridge/src/tools.ts', import.meta.url));
    const source = readFileSync(toolsPath, 'utf8');

    const fromBridge = bridgeActionsCarryingTabId(source);

    // Sanity check on the parser itself: a silent zero here would make the
    // comparison below vacuous.
    expect(fromBridge.length).toBeGreaterThan(10);
    expect(Array.from(TAB_TARGETED_ACTIONS).sort()).toEqual(fromBridge);
    // …and the two that name no tab stay out of it.
    expect(TAB_TARGETED_ACTIONS.has('get_tabs')).toBe(false);
    expect(TAB_TARGETED_ACTIONS.has('get_downloads')).toBe(false);
  });
});
