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
import { runBatch, type BatchDeps } from '../../../abu-browser-bridge/src/batch.js';
import { batchInvocationFromExtra, withOwnerFields } from '../../../abu-browser-bridge/src/tools.js';
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

  it('refuses a batch whose SECOND region was never allowed, even though the first was', async () => {
    // The hole this closes: with several regions under one approval, judging
    // only the page (or only the first region) lets a step reach a site the
    // user never authorized on the strength of one they did.
    const CDN = 'https://cdn.example.org';
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: true },
      { frameId: 'f5', origin: CDN, url: `${CDN}/widget`, sameOriginAsTop: false, accessible: true },
    ]);
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed' },
    });

    const decision = await checkToolApproval(
      'abu-browser__batch',
      {
        tabId: TAB,
        steps: JSON.stringify([
          { action: 'fill', frameId: 'f4', locator: { css: '#name' }, value: '张三' },
          { action: 'click', frameId: 'f5', locator: { text: '提交' } },
        ]),
      },
      unattended,
    );

    expect(decision.decision).toBe('deny');
  });

  it('allows it once every region a step targets is allowed', async () => {
    const CDN = 'https://cdn.example.org';
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: true },
      { frameId: 'f5', origin: CDN, url: `${CDN}/widget`, sameOriginAsTop: false, accessible: true },
    ]);
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed', [CDN]: 'allowed' },
    });

    const decision = await checkToolApproval(
      'abu-browser__batch',
      {
        tabId: TAB,
        steps: JSON.stringify([
          { action: 'fill', frameId: 'f4', locator: { css: '#name' }, value: '张三' },
          { action: 'click', frameId: 'f5', locator: { text: '提交' } },
        ]),
      },
      unattended,
    );

    expect(decision.decision).toBe('allow');
    expect(decision.browserExecution?.expectedFrameOrigins).toEqual({ f4: VENDOR, f5: CDN });
  });

  it('refuses a batch whose region is a money-movement site, however ordinary the page is', async () => {
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: true },
      { frameId: 'f3', origin: BANK, url: BANK_URL, sameOriginAsTop: false, accessible: true },
    ]);
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed', [BANK]: 'allowed' },
    });

    const decision = await checkToolApproval(
      'abu-browser__batch',
      {
        tabId: TAB,
        steps: JSON.stringify([
          { action: 'fill', frameId: 'f4', locator: { css: '#name' }, value: '张三' },
          { action: 'click', frameId: 'f3', locator: { text: '确认转账' } },
        ]),
      },
      unattended,
    );

    expect(decision.decision).toBe('deny');
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

/**
 * Round-2 F1 — the whole chain, from the real entry point.
 *
 * The gate, the `_meta` carrier, the run and the step payload were each
 * individually sane and the JOIN was broken: the gate handed a batch the
 * REGION's origin as its page-level pin, the run compared that against the
 * TAB's address (never equal for a third-party region) and stopped before step
 * 0 — reporting "the tab left vendor.example.net" about a tab that had never
 * been there. Every unit test passed, because every fixture supplied the value
 * the gate was supposed to produce rather than the one it did (TESTING §13.3).
 *
 * So this walks it end to end: `executeAnyTool` → the `_meta` the MCP client
 * really writes → `batchInvocationFromExtra` (the bridge's own extraction) →
 * `runBatch` → the payload each step puts on the wire. The transport stands in
 * for the CONTENT half by applying the same rule the frame's own
 * `assertOriginPin` applies — the origin a step carries must equal the origin
 * of the document it lands in — so a step pinned to the page and delivered
 * into a region fails here exactly as it does in a real frame.
 */
describe('a cross-origin batch actually runs, end to end', () => {
  const CDN = 'https://cdn.example.org';

  /** Where each frame handle really is, as the transport (and a real frame) sees it. */
  type FrameMap = Record<string, string>;

  interface Chain {
    deps: BatchDeps;
    /** The two pins the bridge extracted from `_meta`, handed to `runBatch`. */
    approvedOrigin: string | undefined;
    approvedFrameOrigins: Record<string, string> | undefined;
    /** Every page action dispatched, with the origin it was pinned to. */
    dispatched: Array<{ action: string; frameId?: string; expectedOrigin?: string }>;
    refusals: string[];
  }

  /**
   * The bridge's own `_meta` extraction, then a transport that enforces the
   * content script's pin rule.
   */
  function chainFrom(meta: Record<string, unknown> | undefined, frames: FrameMap, top: string): Chain {
    const dispatched: Chain['dispatched'] = [];
    const refusals: string[] = [];
    const { owner, approvedOrigin, approvedFrameOrigins } = batchInvocationFromExtra({ _meta: meta });
    let clock = 0;
    const deps: BatchDeps = {
      now: () => { clock += 1; return clock; },
      send: async (action, payload) => {
        const merged = withOwnerFields(owner, payload) as Record<string, unknown>;
        if (action === 'get_tabs') {
          return {
            success: true,
            data: {
              windows: [{
                tabs: [{
                  tabId: TAB,
                  url: `${top}/apply`,
                  frames: [
                    { frameId: 'f0', origin: top, sameOriginAsTop: true, accessible: true },
                    ...Object.entries(frames).map(([frameId, origin]) => ({
                      frameId,
                      origin,
                      url: `${origin}/widget`,
                      sameOriginAsTop: false,
                      accessible: true,
                    })),
                  ],
                }],
              }],
            },
          };
        }
        const frameId = typeof merged.frameId === 'string' ? merged.frameId : undefined;
        const expectedOrigin = typeof merged.expectedOrigin === 'string' ? merged.expectedOrigin : undefined;
        dispatched.push({ action, ...(frameId ? { frameId } : {}), ...(expectedOrigin ? { expectedOrigin } : {}) });
        // `assertOriginPin`, content-script half: the document this lands in
        // is the region for a framed step and the page otherwise.
        const landsOn = frameId ? frames[frameId] : top;
        if (expectedOrigin !== undefined && expectedOrigin !== landsOn) {
          const refusal = `Refused: this action targeted a frame from a different site than the one `
            + `approved (approved ${expectedOrigin}, this frame is ${landsOn})`;
          refusals.push(refusal);
          return { success: false, error: refusal };
        }
        return { success: true, data: { success: true, message: 'ok' } };
      },
    };
    return { deps, approvedOrigin, approvedFrameOrigins, dispatched, refusals };
  }

  it('runs every step of a batch that names ONE cross-origin region', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed' },
    });
    const steps = JSON.stringify([
      { action: 'fill', frameId: 'f4', locator: { css: '#name' }, value: '张三' },
      { action: 'click', frameId: 'f4', locator: { text: '提交' } },
    ]);

    await executeAnyTool(
      'abu-browser__batch', { tabId: TAB, steps }, (async () => true) as never,
      undefined, unattended,
    );
    const meta = metaOf('batch');
    // The page-level pin is the PAGE's — this is the value that used to be the
    // region's, and the one `driftedBeforeStart` compares the tab against.
    expect(meta?.['abu/expectedOrigin']).toBe(PAGE);
    expect(meta?.['abu/expectedFrameOrigins']).toEqual({ f4: VENDOR });

    const chain = chainFrom(meta, { f4: VENDOR }, PAGE);
    const result = await runBatch(
      chain.deps, TAB,
      [
        { action: 'fill', frameId: 'f4', locator: { css: '#name' }, value: '张三' },
        { action: 'click', frameId: 'f4', locator: { text: '提交' } },
      ],
      chain.approvedOrigin, chain.approvedFrameOrigins,
    );

    expect(result.stopped).toBeUndefined();
    expect(result.completedSteps).toHaveLength(2);
    expect(chain.refusals).toEqual([]);
    expect(chain.dispatched.map((d) => d.expectedOrigin)).toEqual([VENDOR, VENDOR]);
  });

  it('runs every step of a batch that names TWO cross-origin regions', async () => {
    servePage(PAGE_URL, [
      { frameId: 'f0', origin: PAGE, url: PAGE_URL, sameOriginAsTop: true, accessible: true },
      { frameId: 'f4', origin: VENDOR, url: VENDOR_URL, sameOriginAsTop: false, accessible: true },
      { frameId: 'f5', origin: CDN, url: `${CDN}/widget`, sameOriginAsTop: false, accessible: true },
    ]);
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed', [CDN]: 'allowed' },
    });
    const list = [
      { action: 'fill' as const, frameId: 'f4', locator: { css: '#name' }, value: '张三' },
      { action: 'click' as const, frameId: 'f5', locator: { text: '提交' } },
    ];

    await executeAnyTool(
      'abu-browser__batch', { tabId: TAB, steps: JSON.stringify(list) }, (async () => true) as never,
      undefined, unattended,
    );
    const meta = metaOf('batch');
    expect(meta?.['abu/expectedOrigin']).toBe(PAGE);
    expect(meta?.['abu/expectedFrameOrigins']).toEqual({ f4: VENDOR, f5: CDN });

    const chain = chainFrom(meta, { f4: VENDOR, f5: CDN }, PAGE);
    const result = await runBatch(chain.deps, TAB, list, chain.approvedOrigin, chain.approvedFrameOrigins);

    expect(result.stopped).toBeUndefined();
    expect(result.completedSteps).toHaveLength(2);
    expect(chain.refusals).toEqual([]);
    expect(chain.dispatched.map((d) => d.expectedOrigin)).toEqual([VENDOR, CDN]);
  });

  it('still stops the run when the TAB itself left the page the batch was approved for', async () => {
    // The page-level pin has not become decorative: it is simply compared
    // against the thing it describes.
    useSettingsStore.setState({
      browserSitePermissions: { [PAGE]: 'allowed', [VENDOR]: 'allowed' },
    });
    const list = [{ action: 'fill' as const, frameId: 'f4', locator: { css: '#name' }, value: '张三' }];
    await executeAnyTool(
      'abu-browser__batch', { tabId: TAB, steps: JSON.stringify(list) }, (async () => true) as never,
      undefined, unattended,
    );
    const chain = chainFrom(metaOf('batch'), { f4: VENDOR }, 'https://elsewhere.example.com');

    const result = await runBatch(chain.deps, TAB, list, chain.approvedOrigin, chain.approvedFrameOrigins);

    expect(result.stopped).toBe('origin-changed');
    expect(chain.dispatched).toEqual([]);
  });
});
