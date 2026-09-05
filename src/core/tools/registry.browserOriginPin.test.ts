// U5 — the two execution-time compensating controls that need the FULL chain
// (`executeAnyTool` → `mcpManager.callTool` → MCP `_meta`), not just the gate:
//
//  1. the origin pin: the origin the gate approved rides `_meta` down to the
//     browser host, never the tool's input schema (the model must be able to
//     neither read nor forge it);
//  2. `get_downloads` origin filtering: the one browser tool that is exempt
//     from every site verdict (pageless + read-only) and still returns URLs.
//
// Harness mirrors registry.mcpConversationId.test.ts (fake ConnectedServer
// injected into the real mcpManager singleton) plus the get_tabs fake from
// registry.operationPolicy.test.ts, because a browser tool's approval resolves
// its target through get_tabs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval, executeAnyTool, filterDownloadsByOrigin, filterTabsBySitePermissions } from './registry';
import { mcpManager } from '../mcp/client';
import { getI18n } from '../../i18n';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  __resetBrowserGrantsForTests,
} from '../permissions/browserToolPolicy';

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: () => ({ decision: 'allow' as const }),
}));

const ALLOWED_SITE = 'https://allowed.com';
const ALLOWED_URL = `${ALLOWED_SITE}/report`;
const BLOCKED_SITE = 'https://blocked.com';
const OWNER = 'run-owner';
const OWNED_TAB_ID = 77;

interface FakeConnectedServer {
  config: { name: string };
  client: { callTool: ReturnType<typeof vi.fn> };
  transport: unknown;
  tools: Map<string, never>;
}

let mockCallTool: ReturnType<typeof vi.fn>;

/** get_tabs answers with the owned tab on `url`; every other tool answers `text`. */
function serveTabs(url: string, text = 'ok') {
  mockCallTool.mockImplementation((params: { name: string; _meta?: Record<string, unknown> }) => {
    if (params.name === 'get_tabs') {
      return Promise.resolve({
        content: [{
          type: 'text',
          text: JSON.stringify(
            params._meta?.['abu/conversationId'] === OWNER
              ? { windows: [{ windowId: 1, tabs: [{ tabId: OWNED_TAB_ID, url }] }] }
              : { windows: [] },
          ),
        }],
      });
    }
    return Promise.resolve({ content: [{ type: 'text', text }] });
  });
}

function metaOf(toolName: string): Record<string, unknown> | undefined {
  const call = mockCallTool.mock.calls.find(
    (c) => (c[0] as { name: string }).name === toolName,
  );
  return (call?.[0] as { _meta?: Record<string, unknown> } | undefined)?._meta;
}

const unattendedOwner = { conversationId: OWNER, interactionMode: 'background' } as never;
const attendedOwner = { conversationId: OWNER } as never;

describe('U5 execution-time controls through executeAnyTool', () => {
  beforeEach(() => {
    mockCallTool = vi.fn();
    serveTabs(ALLOWED_URL);
    const fakeServer: FakeConnectedServer = {
      config: { name: 'abu-browser' },
      client: { callTool: mockCallTool },
      transport: {},
      tools: new Map(),
    };
    (mcpManager as unknown as { servers: Map<string, FakeConnectedServer> }).servers.set(
      'abu-browser',
      fakeServer,
    );
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({
      permissionMode: 'standard',
      browserSitePermissions: { [ALLOWED_SITE]: 'allowed' },
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      allowUnattendedBrowser: true,
    });
    __resetBrowserGrantsForTests();
  });

  afterEach(() => {
    (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
    __resetBrowserGrantsForTests();
  });

  describe('origin pin travels over _meta, not the tool schema', () => {
    it('an unattended click carries the approved origin and the unattended marker', async () => {
      await executeAnyTool(
        'abu-browser__click', { tabId: OWNED_TAB_ID }, (async () => true) as never,
        undefined, unattendedOwner,
      );

      const meta = metaOf('click');
      expect(meta?.['abu/expectedOrigin']).toBe(ALLOWED_SITE);
      expect(meta?.['abu/unattended']).toBe(true);
    });

    it('the pin is NOT in the arguments the model can see or forge', async () => {
      await executeAnyTool(
        'abu-browser__click', { tabId: OWNED_TAB_ID }, (async () => true) as never,
        undefined, unattendedOwner,
      );

      const call = mockCallTool.mock.calls.find((c) => (c[0] as { name: string }).name === 'click');
      const args = (call?.[0] as { arguments: Record<string, unknown> }).arguments;
      expect(args).toEqual({ tabId: OWNED_TAB_ID });
    });

    it('a model-supplied expectedOrigin in the INPUT is not forwarded as the pin', async () => {
      await executeAnyTool(
        'abu-browser__click',
        { tabId: OWNED_TAB_ID, expectedOrigin: 'https://evil.example.com' },
        (async () => true) as never, undefined, unattendedOwner,
      );

      // It rode the arguments (where the host ignores it); the `_meta` pin is
      // still the origin the GATE resolved.
      expect(metaOf('click')?.['abu/expectedOrigin']).toBe(ALLOWED_SITE);
    });

    it('an attended call carries no unattended marker — the host leaves it alone', async () => {
      await executeAnyTool(
        'abu-browser__click', { tabId: OWNED_TAB_ID }, (async () => true) as never,
        undefined, attendedOwner,
      );

      const meta = metaOf('click');
      expect(meta?.['abu/unattended']).toBeUndefined();
      expect(meta?.['abu/expectedOrigin']).toBe(ALLOWED_SITE);
    });
  });

  /**
   * U6 / F2.4, attended half. The action is NOT refused — a human is here, and
   * they may well be the one signing in — but the result now says the session
   * expired, so the model asks instead of retrying into the wall.
   */
  describe('login-expiry note on an attended result', () => {
    function serveLoggedOut(text = 'clicked') {
      mockCallTool.mockImplementation((params: { name: string; _meta?: Record<string, unknown> }) => {
        if (params.name === 'get_tabs') {
          return Promise.resolve({
            content: [{
              type: 'text',
              text: JSON.stringify(
                params._meta?.['abu/conversationId'] === OWNER
                  ? {
                    windows: [{
                      windowId: 1,
                      tabs: [{ tabId: OWNED_TAB_ID, url: ALLOWED_URL, authState: 'login_required' }],
                    }],
                  }
                  : { windows: [] },
              ),
            }],
          });
        }
        return Promise.resolve({ content: [{ type: 'text', text }] });
      });
    }

    it('appends the sign-in note to the result the model reads', async () => {
      serveLoggedOut();

      const result = await executeAnyTool(
        'abu-browser__click', { tabId: OWNED_TAB_ID }, (async () => true) as never,
        undefined, attendedOwner,
      ) as string;

      expect(result).toContain('clicked');
      expect(result).toContain('needs a fresh sign-in');
    });

    it('does not send the flag on to the host — it came from there', async () => {
      serveLoggedOut();

      await executeAnyTool(
        'abu-browser__click', { tabId: OWNED_TAB_ID }, (async () => true) as never,
        undefined, attendedOwner,
      );

      expect(metaOf('click')?.['abu/loginRequired']).toBeUndefined();
    });

    it('adds nothing when the site is healthy (attended byte-compat)', async () => {
      serveTabs(ALLOWED_URL, 'clicked');

      const result = await executeAnyTool(
        'abu-browser__click', { tabId: OWNED_TAB_ID }, (async () => true) as never,
        undefined, attendedOwner,
      ) as string;

      expect(result).toBe('clicked');
    });
  });

  describe('get_downloads origin filtering', () => {
    function serveDownloads(entries: Array<{ url: string; filename: string }>) {
      mockCallTool.mockImplementation((params: { name: string }) =>
        Promise.resolve({
          content: [{
            type: 'text',
            text: params.name === 'get_downloads'
              ? JSON.stringify(entries.map((e, i) => ({ id: `d${i}`, state: 'completed', ...e })), null, 2)
              : JSON.stringify({ windows: [] }),
          }],
        }),
      );
    }

    it('drops a download from a BLOCKED site in an attended run', async () => {
      useSettingsStore.setState({
        browserSitePermissions: { [ALLOWED_SITE]: 'allowed', [BLOCKED_SITE]: 'denied' },
      });
      serveDownloads([
        { url: `${BLOCKED_SITE}/secret.pdf`, filename: 'secret.pdf' },
        { url: `${ALLOWED_SITE}/report.pdf`, filename: 'report.pdf' },
      ]);

      const result = await executeAnyTool(
        'abu-browser__get_downloads', {}, (async () => true) as never, undefined, attendedOwner,
      ) as string;

      expect(result).not.toContain('secret.pdf');
      expect(result).toContain('report.pdf');
    });

    it('an attended run still sees downloads from UNLISTED sites', async () => {
      serveDownloads([{ url: 'https://unknown.com/a.pdf', filename: 'a.pdf' }]);

      const result = await executeAnyTool(
        'abu-browser__get_downloads', {}, (async () => true) as never, undefined, attendedOwner,
      ) as string;

      expect(result).toContain('a.pdf');
    });

    it('an unattended run sees ONLY downloads from sites it was granted', async () => {
      serveDownloads([
        { url: 'https://unknown.com/a.pdf', filename: 'a.pdf' },
        { url: `${ALLOWED_SITE}/report.pdf`, filename: 'report.pdf' },
      ]);

      const result = await executeAnyTool(
        'abu-browser__get_downloads', {}, (async () => true) as never, undefined, unattendedOwner,
      ) as string;

      expect(result).not.toContain('a.pdf');
      expect(result).toContain('report.pdf');
    });
  });

  // U9 / I1 — the sibling leak. `get_tabs` is pageless + read-only, so no site
  // verdict is ever resolved for it, and the extension channel (the one
  // driving the user's real logged-in Chrome) answers from
  // `chrome.tabs.query({})` — every tab's url and title, plus
  // `summary.currentTabUrl`, with no permission check.
  describe('get_tabs site scoping', () => {
    const SECRET_TITLE = 'Private banking — statements';

    /** The real payload shape both channels emit (electron/browserHost.cjs's
     *  `get_tabs` branch and abu-chrome-extension's handler agree on it). */
    function serveTabListing(tabs: Array<{ tabId: number; url: string; title: string }>) {
      mockCallTool.mockImplementation(() =>
        Promise.resolve({
          content: [{
            type: 'text',
            text: JSON.stringify({
              summary: {
                totalWindows: 1,
                totalTabs: tabs.length,
                currentWindowId: 1,
                currentTabId: tabs[0]?.tabId ?? null,
                currentTabUrl: tabs[0]?.url ?? '',
                currentTabTitle: tabs[0]?.title ?? '',
                detectionStrategy: 'test',
              },
              windows: [{
                windowId: 1,
                isCurrentWindow: true,
                tabs: tabs.map((t) => ({ ...t, active: true, isCurrentTab: true })),
              }],
            }, null, 2),
          }],
        }),
      );
    }

    beforeEach(() => {
      useSettingsStore.setState({
        browserSitePermissions: { [ALLOWED_SITE]: 'allowed', [BLOCKED_SITE]: 'denied' },
      });
    });

    it('hides a BLOCKED site\'s address and title from an unattended run', async () => {
      serveTabListing([
        { tabId: 1, url: `${BLOCKED_SITE}/accounts`, title: SECRET_TITLE },
        { tabId: 2, url: ALLOWED_URL, title: 'Report' },
      ]);

      const result = await executeAnyTool(
        'abu-browser__get_tabs', {}, (async () => true) as never, undefined, unattendedOwner,
      ) as string;

      expect(result).not.toContain('blocked.com');
      expect(result).not.toContain(SECRET_TITLE);
      expect(result).toContain('Report');
    });

    it('keeps the row (and the count) rather than dropping it — the model is told a tab is there', async () => {
      serveTabListing([
        { tabId: 1, url: `${BLOCKED_SITE}/accounts`, title: SECRET_TITLE },
        { tabId: 2, url: ALLOWED_URL, title: 'Report' },
      ]);

      const result = await executeAnyTool(
        'abu-browser__get_tabs', {}, (async () => true) as never, undefined, unattendedOwner,
      ) as string;
      const parsed = JSON.parse(result) as {
        summary: { totalTabs: number };
        windows: Array<{ tabs: Array<{ tabId: number; url: string }> }>;
      };

      expect(parsed.windows[0].tabs).toHaveLength(2);
      // The host-computed count still says 2, so dropping the row would have
      // made the listing contradict itself.
      expect(parsed.summary.totalTabs).toBe(2);
      expect(parsed.windows[0].tabs[0].tabId).toBe(1);
      expect(parsed.windows[0].tabs[0].url).toContain('hidden');
    });

    it('redacts the summary\'s current-tab address too', async () => {
      serveTabListing([{ tabId: 1, url: `${BLOCKED_SITE}/accounts`, title: SECRET_TITLE }]);

      const result = await executeAnyTool(
        'abu-browser__get_tabs', {}, (async () => true) as never, undefined, unattendedOwner,
      ) as string;
      const parsed = JSON.parse(result) as { summary: { currentTabUrl: string; currentTabTitle: string } };

      expect(parsed.summary.currentTabUrl).not.toContain('blocked.com');
      expect(parsed.summary.currentTabTitle).not.toBe(SECRET_TITLE);
    });

    it('changes NOTHING for an attended run — a human looking at their own browser', async () => {
      serveTabListing([{ tabId: 1, url: `${BLOCKED_SITE}/accounts`, title: SECRET_TITLE }]);

      const result = await executeAnyTool(
        'abu-browser__get_tabs', {}, (async () => true) as never, undefined, attendedOwner,
      ) as string;

      expect(result).toContain('blocked.com');
      expect(result).toContain(SECRET_TITLE);
    });

    it('leaves an unattended listing untouched when no tab is blocked', async () => {
      serveTabListing([{ tabId: 1, url: ALLOWED_URL, title: 'Report' }]);

      const result = await executeAnyTool(
        'abu-browser__get_tabs', {}, (async () => true) as never, undefined, unattendedOwner,
      ) as string;

      expect(result).toContain(ALLOWED_SITE);
      expect(result).toContain('Report');
    });

    // The redaction must not blind the GATE: its origin probe calls
    // mcpManager directly and never passes through this filter, so an action
    // on the blocked tab is still refused for being on a blocked site — not
    // waved through because its origin became unreadable.
    it('does not stop the gate from seeing the blocked tab\'s real origin', async () => {
      serveTabs(`${BLOCKED_SITE}/accounts`);

      const decision = await checkToolApproval(
        'abu-browser__click', { tabId: OWNED_TAB_ID }, unattendedOwner, (async () => true) as never,
      );

      expect(decision.decision).toBe('deny');
      // For the RIGHT reason: "you blocked this site", not "the origin could
      // not be determined" — the latter is what a probe blinded by this
      // filter would have produced.
      expect(decision.reason).toContain(getI18n().commandConfirm.browserSiteDenied);
    });
  });
});

describe('filterTabsBySitePermissions (unit)', () => {
  const perms = { 'https://blocked.com': 'denied' } as const;
  const listing = (url: string): string => JSON.stringify({
    summary: { totalTabs: 1, currentTabUrl: url, currentTabTitle: 'T' },
    windows: [{ windowId: 1, tabs: [{ tabId: 1, url, title: 'T' }] }],
  });

  it('returns the input untouched when nothing was blocked', () => {
    const json = listing('https://ok.com/a');
    expect(filterTabsBySitePermissions(json, 'unattended', { ...perms })).toBe(json);
  });

  it('returns the input untouched for an attended run, blocked or not', () => {
    const json = listing('https://blocked.com/a');
    expect(filterTabsBySitePermissions(json, 'attended', { ...perms })).toBe(json);
  });

  it('withholds an unparseable listing from an unattended run, passes it through attended', () => {
    expect(filterTabsBySitePermissions('<html>', 'unattended', { ...perms })).toMatch(/^Error: /);
    expect(filterTabsBySitePermissions('<html>', 'attended', { ...perms })).toBe('<html>');
  });

  it('leaves an error string and non-string results alone', () => {
    expect(filterTabsBySitePermissions('Error: boom', 'unattended', { ...perms })).toBe('Error: boom');
    const rich = [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'x' } }];
    expect(filterTabsBySitePermissions(rich, 'unattended', { ...perms })).toBe(rich);
  });

  it('survives a listing whose windows/tabs are not the expected shape', () => {
    const odd = JSON.stringify({ windows: [null, { tabs: 'nope' }, { tabs: [null, 7] }] });
    expect(filterTabsBySitePermissions(odd, 'unattended', { ...perms })).toBe(odd);
  });

  it('hides only the denied rows, leaving the rest of the entry intact', () => {
    const json = JSON.stringify({
      windows: [{ tabs: [
        { tabId: 1, url: 'https://blocked.com/x', title: 'secret', active: true },
        { tabId: 2, url: 'https://ok.com/y', title: 'fine', active: false },
      ] }],
    });
    const out = filterTabsBySitePermissions(json, 'unattended', { ...perms }) as string;
    const parsed = JSON.parse(out) as { windows: Array<{ tabs: Array<Record<string, unknown>> }> };

    expect(parsed.windows[0].tabs[0]).toMatchObject({ tabId: 1, active: true });
    expect(parsed.windows[0].tabs[0].url).not.toContain('blocked.com');
    expect(parsed.windows[0].tabs[0].title).not.toBe('secret');
    expect(parsed.windows[0].tabs[1]).toMatchObject({ tabId: 2, url: 'https://ok.com/y', title: 'fine' });
  });
});

describe('filterDownloadsByOrigin (unit)', () => {
  const perms = { [ALLOWED_SITE]: 'allowed', [BLOCKED_SITE]: 'denied' } as const;

  it('returns the input untouched when nothing was dropped', () => {
    const json = JSON.stringify([{ url: `${ALLOWED_SITE}/a` }], null, 2);
    expect(filterDownloadsByOrigin(json, 'unattended', { ...perms })).toBe(json);
  });

  it('drops an entry whose url does not parse, unattended', () => {
    const json = JSON.stringify([{ url: 'not a url' }, { url: `${ALLOWED_SITE}/a` }]);
    const out = filterDownloadsByOrigin(json, 'unattended', { ...perms }) as string;
    expect(JSON.parse(out)).toHaveLength(1);
  });

  it('keeps an unparseable-url entry attended (a human is reading it)', () => {
    const json = JSON.stringify([{ url: 'not a url' }]);
    expect(filterDownloadsByOrigin(json, 'attended', { ...perms })).toBe(json);
  });

  it('withholds an unparseable LISTING from an unattended run, passes it through attended', () => {
    expect(filterDownloadsByOrigin('<html>', 'unattended', { ...perms }))
      .toMatch(/^Error: /);
    expect(filterDownloadsByOrigin('<html>', 'attended', { ...perms })).toBe('<html>');
  });

  it('leaves an error string and non-string results alone', () => {
    expect(filterDownloadsByOrigin('Error: boom', 'unattended', { ...perms })).toBe('Error: boom');
    const rich = [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'x' } }];
    expect(filterDownloadsByOrigin(rich, 'unattended', { ...perms })).toBe(rich);
  });
});
