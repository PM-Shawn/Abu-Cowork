/**
 * T4 — a call that targets an EMBEDDED REGION (iframe) is authorized against
 * that region's own site, not against the page embedding it.
 *
 * The question this file answers is the one the ruling turns on: a page can
 * embed anything. If a grant for `oa.example.com` carried into every iframe it
 * hosts, then "always allow this site" would quietly mean "always allow every
 * site this site chooses to embed" — which is not what anyone agreed to, and
 * is a one-line change away from being an exfiltration channel.
 *
 * So: each origin passes the site gate on its own account, the STRICTER of the
 * two verdicts decides, and — because asking region by region would turn one
 * form into a wall of prompts — the attended ask names the regions together
 * and its "always allow" writes a separate grant for each.
 *
 * Everything here goes through the REAL entry point (`checkToolApproval` /
 * `executeAnyTool`), per TESTING.md §13.3: a test that pins a value onto a
 * callback proves nothing about the pipe the gate actually uses. The gate's
 * only probe is `get_tabs`, so the fake serves the frame tree there, in the
 * shape both channels really send.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval, executeAnyTool } from './registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import {
  DEFAULT_BROWSER_OPERATION_POLICY,
  __resetBrowserGrantsForTests,
} from '../permissions/browserToolPolicy';
import type { ConfirmationInfo } from './commandSafety';

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));
vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: () => ({ decision: 'allow' as const }),
}));

const PAGE = 'https://oa.example.com';
const PAGE_URL = `${PAGE}/apply`;
const VENDOR = 'https://vendor.example.net';
const VENDOR_URL = `${VENDOR}/form`;
const BANK = 'https://bank.example.com';
const BANK_URL = `${BANK}/transfer`;
const OWNER = 'run-owner';
const TAB = 42;

interface FrameRow {
  frameId: string;
  origin: string | null;
  url?: string;
  sameOriginAsTop: boolean;
  accessible: boolean;
}

let mockCallTool: ReturnType<typeof vi.fn>;

/** The page, with whatever regions the case is about, served the way `get_tabs` does. */
function servePage(url: string, frames: FrameRow[]): void {
  mockCallTool.mockImplementation((params: { name: string; _meta?: Record<string, unknown> }) => {
    if (params.name === 'get_tabs') {
      const owned = params._meta?.['abu/conversationId'] === OWNER;
      return Promise.resolve({
        content: [{
          type: 'text',
          text: JSON.stringify(
            owned
              ? { windows: [{ windowId: 1, tabs: [{ tabId: TAB, url, ...(frames.length ? { frames } : {}) }] }] }
              : { windows: [] },
          ),
        }],
      });
    }
    return Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
  });
}

/** The ordinary shape: an OA page hosting one third-party region. */
function pageWithVendorRegion(): void {
  servePage(PAGE_URL, [
    { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
    { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: true },
  ]);
}

const unattended = { conversationId: OWNER, interactionMode: 'background' } as never;
const attended = { conversationId: OWNER } as never;

/** An attended confirm callback that records what it was asked and says yes. */
function recordingConfirm(): {
  cb: (info: ConfirmationInfo) => Promise<boolean>;
  asks: ConfirmationInfo[];
} {
  const asks: ConfirmationInfo[] = [];
  return {
    asks,
    cb: async (info: ConfirmationInfo) => { asks.push(info); return true; },
  };
}

function metaOf(toolName: string): Record<string, unknown> | undefined {
  const call = mockCallTool.mock.calls.find((c) => (c[0] as { name: string }).name === toolName);
  return (call?.[0] as { _meta?: Record<string, unknown> } | undefined)?._meta;
}

beforeEach(() => {
  mockCallTool = vi.fn();
  pageWithVendorRegion();
  (mcpManager as unknown as { servers: Map<string, unknown> }).servers.set('abu-browser', {
    config: { name: 'abu-browser' },
    client: { callTool: mockCallTool },
    transport: {},
    tools: new Map(),
  });
  useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
  useSettingsStore.setState({
    permissionMode: 'standard',
    browserSitePermissions: { [PAGE]: 'allowed' },
    browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
    allowUnattendedBrowser: true,
  });
  __resetBrowserGrantsForTests();
});

afterEach(() => {
  (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
  __resetBrowserGrantsForTests();
});

describe('an embedded region is authorized on its own account', () => {
  it('refuses an unattended action in a region whose site was never allowed', async () => {
    const decision = await checkToolApproval(
      'abu-browser__fill', { tabId: TAB, frameId: 'f4', locator: '{"css":"#name"}', value: '张三' },
      unattended,
    );

    expect(decision.decision).toBe('deny');
    // The page's own grant is not the reason it could have run: the region's
    // site is what was judged, and it has no standing grant.
    expect(decision.reason).toMatch(/vendor\.example\.net|站点|site/i);
  });

  it('allows it once that region\'s own site is allowed too', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed' },
    });

    const decision = await checkToolApproval(
      'abu-browser__fill', { tabId: TAB, frameId: 'f4', locator: '{"css":"#name"}', value: '张三' },
      unattended,
    );

    expect(decision.decision).toBe('allow');
    // And the pin the executor carries is the REGION's origin, so the frame's
    // own runtime compares against the site it is really showing.
    expect(decision.browserExecution?.expectedOrigin).toBe(VENDOR);
  });

  it('refuses even an allowed region when the PAGE embedding it is blocked', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'denied', [VENDOR]: 'allowed' },
    });

    const decision = await checkToolApproval(
      'abu-browser__fill', { tabId: TAB, frameId: 'f4', locator: '{"css":"#name"}', value: '张三' },
      unattended,
    );

    expect(decision.decision).toBe('deny');
  });

  it('does not let the page\'s grant cover the region when the user is watching either', async () => {
    const { cb, asks } = recordingConfirm();

    const decision = await checkToolApproval(
      'abu-browser__fill', { tabId: TAB, frameId: 'f4', locator: '{"css":"#name"}', value: '张三' },
      attended, cb as never,
    );

    expect(decision.decision).toBe('allow');
    // It ASKED — the page being "always allowed" bought nothing here.
    expect(asks).toHaveLength(1);
    expect(asks[0].browserOrigin).toBe(VENDOR);
  });

  it('runs with no dialog inside a SAME-origin region, which the page\'s grant does cover', async () => {
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f2', origin: PAGE, url: `${PAGE}/apply/inner`, sameOriginAsTop: true, accessible: true },
    ]);
    const { cb, asks } = recordingConfirm();

    const decision = await checkToolApproval(
      'abu-browser__fill', { tabId: TAB, frameId: 'f2', locator: '{"css":"#name"}', value: '张三' },
      attended, cb as never,
    );

    expect(decision.decision).toBe('allow');
    expect(asks).toHaveLength(0);
  });

  it('refuses a region the browser could not confirm, instead of falling back to the page', async () => {
    // A region this channel cannot see into reports an origin the EMBEDDING
    // page could have authored, so nothing may be authorized on it.
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: false },
    ]);

    const decision = await checkToolApproval(
      'abu-browser__fill', { tabId: TAB, frameId: 'f4', locator: '{"css":"#name"}', value: '张三' },
      unattended,
    );

    expect(decision.decision).toBe('deny');
  });

  it('refuses a region the page does not have at all', async () => {
    const decision = await checkToolApproval(
      'abu-browser__fill', { tabId: TAB, frameId: 'f9', locator: '{"css":"#name"}', value: '张三' },
      unattended,
    );

    expect(decision.decision).toBe('deny');
  });
});

describe('high-risk applies to each site, not just the outer one', () => {
  it('an unattended action inside a money-movement region is refused, allowed site or not', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [BANK]: 'allowed' },
    });
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f3', origin: BANK, url: BANK_URL, sameOriginAsTop: false, accessible: true },
    ]);

    const decision = await checkToolApproval(
      'abu-browser__click', { tabId: TAB, frameId: 'f3', locator: '{"text":"确认转账"}' },
      unattended,
    );

    expect(decision.decision).toBe('deny');
  });

  it('an attended one still asks, and offers no standing grant', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [BANK]: 'allowed' },
    });
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f3', origin: BANK, url: BANK_URL, sameOriginAsTop: false, accessible: true },
    ]);
    const { cb, asks } = recordingConfirm();

    await checkToolApproval(
      'abu-browser__click', { tabId: TAB, frameId: 'f3', locator: '{"text":"确认转账"}' },
      attended, cb as never,
    );

    expect(asks).toHaveLength(1);
    expect(asks[0].allowPersistentGrant).toBe(false);
  });

  it('a money-movement PAGE makes its ordinary region high-risk too', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [BANK]: 'allowed', [VENDOR]: 'allowed' },
    });
    servePage(BANK_URL, [
      { frameId: 'f0', origin: BANK, url: BANK_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: true },
    ]);

    const decision = await checkToolApproval(
      'abu-browser__click', { tabId: TAB, frameId: 'f4', locator: '{"text":"确定"}' },
      unattended,
    );

    expect(decision.decision).toBe('deny');
  });
});

describe('the merged ask', () => {
  it('names the page\'s other regions before the click that would authorize them', async () => {
    useSettingsStore.setState({ browserSitePermissions: {} });
    const { cb, asks } = recordingConfirm();

    await checkToolApproval(
      'abu-browser__click', { tabId: TAB, locator: '{"text":"提交"}' },
      attended, cb as never,
    );

    expect(asks[0].browserOrigin).toBe(PAGE);
    expect(asks[0].browserEmbeddedOrigins).toEqual([VENDOR]);
  });

  it('lists a region only once, however many frames come from it', async () => {
    useSettingsStore.setState({ browserSitePermissions: {} });
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: true },
      { frameId: 'f5', origin: VENDOR, url: `${VENDOR}/other`, sameOriginAsTop: false, accessible: true },
    ]);
    const { cb, asks } = recordingConfirm();

    await checkToolApproval(
      'abu-browser__click', { tabId: TAB, locator: '{"text":"提交"}' },
      attended, cb as never,
    );

    expect(asks[0].browserEmbeddedOrigins).toEqual([VENDOR]);
  });

  it('never lists the page\'s own origin, or a region the browser could not confirm', async () => {
    useSettingsStore.setState({ browserSitePermissions: {} });
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f1', origin: PAGE, url: `${PAGE}/inner`, sameOriginAsTop: true, accessible: true },
      { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: false },
    ]);
    const { cb, asks } = recordingConfirm();

    await checkToolApproval(
      'abu-browser__click', { tabId: TAB, locator: '{"text":"提交"}' },
      attended, cb as never,
    );

    expect(asks[0].browserEmbeddedOrigins).toBeUndefined();
  });

  it('says nothing about regions on a page that has none', async () => {
    useSettingsStore.setState({ browserSitePermissions: {} });
    servePage(PAGE_URL, []);
    const { cb, asks } = recordingConfirm();

    await checkToolApproval(
      'abu-browser__click', { tabId: TAB, locator: '{"text":"提交"}' },
      attended, cb as never,
    );

    expect(asks[0].browserEmbeddedOrigins).toBeUndefined();
  });
});

describe('a batch is pinned per region', () => {
  const steps = JSON.stringify([
    { action: 'fill', frameId: 'f4', locator: { css: '#name' }, value: '张三' },
    { action: 'click', frameId: 'f4', locator: { text: '提交' } },
  ]);

  it('hands the run the origin each region was approved for', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed' },
    });

    const decision = await checkToolApproval(
      'abu-browser__batch', { tabId: TAB, steps },
      unattended,
    );

    expect(decision.decision).toBe('allow');
    expect(decision.browserExecution?.expectedFrameOrigins).toEqual({ f4: VENDOR });
  });

  it('carries those origins to the run over _meta, where the model cannot forge them', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed' },
    });

    await executeAnyTool(
      'abu-browser__batch', { tabId: TAB, steps }, (async () => true) as never,
      undefined, unattended,
    );

    expect(metaOf('batch')?.['abu/expectedFrameOrigins']).toEqual({ f4: VENDOR });
    const args = (mockCallTool.mock.calls.find(
      (c) => (c[0] as { name: string }).name === 'batch',
    )?.[0] as { arguments: Record<string, unknown> }).arguments;
    expect(args.expectedFrameOrigins).toBeUndefined();
  });

  it('refuses the whole batch when one step\'s region was never allowed', async () => {
    useSettingsStore.setState({ browserSitePermissions: { [PAGE]: 'allowed' } });

    const decision = await checkToolApproval(
      'abu-browser__batch', { tabId: TAB, steps },
      unattended,
    );

    expect(decision.decision).toBe('deny');
  });
});
