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
import { executeAnyTool, filterDownloadsByOrigin } from './registry';
import { mcpManager } from '../mcp/client';
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
