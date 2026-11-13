/**
 * Two kinds of action the gate asks about in every permission mode, through the
 * real entry point (`checkToolApproval`):
 *
 *  - acting on a government site: the first click or fill of a task asks, the
 *    answer covers that site for the rest of the task, a payment page there asks
 *    every time, and nobody can answer for it in an unattended run;
 *  - a connector (MCP) tool that sends to other people, deletes in a connected
 *    service or moves money (`connectorActionPolicy.ts`).
 */
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkToolApproval } from './registry';
import { mcpManager } from '../mcp/client';
import { useChatStore } from '../../stores/chatStore';
import { DEFAULT_BROWSER_OPERATION_POLICY, __resetBrowserGrantsForTests } from '../permissions/browserToolPolicy';
import { __resetTaskGrantsForTests, TASK_GRANT_TTL_MS } from '../permissions/taskGrants';
import { __resetUnattendedConfirmationForTests } from '../permissions/unattendedConfirmation';
import type { PermissionMode } from '../permissions/permissionMode';
import type { ConfirmationInfo } from './commandSafety';

const CONV = 'conv-a';
const TAB = 7;
const GOV = 'https://service.example.gov.cn';
const BANK = 'https://www.paypal.com';

let mockCallTool: ReturnType<typeof vi.fn>;
let pageUrl = `${GOV}/index.html`;
let pageTitle = '';

function servePage(): void {
  mockCallTool.mockImplementation((params: { name: string }) => Promise.resolve({
    content: [{
      type: 'text',
      text: params.name === 'get_tabs'
        ? JSON.stringify({ windows: [{ windowId: 1, tabs: [{ tabId: TAB, url: pageUrl, ...(pageTitle ? { title: pageTitle } : {}) }] }] })
        : 'ok',
    }],
  }));
}

function recordingConfirm(answer = true): { cb: (info: ConfirmationInfo) => Promise<boolean>; asks: ConfirmationInfo[] } {
  const asks: ConfirmationInfo[] = [];
  return { asks, cb: async (info) => { asks.push(info); return answer; } };
}

const attended = (conversationId = CONV) => ({ conversationId, loopId: 'loop-1' }) as never;
const unattended = { conversationId: CONV, interactionMode: 'background' } as never;

function setMode(permissionMode: PermissionMode): void {
  setMigratedBrowserSettings({
    permissionMode,
    browserSitePermissions: { [GOV]: 'allowed', [BANK]: 'allowed' },
    browserSiteGrantViaEmbed: {},
    browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
    allowUnattendedBrowser: true,
  });
}

beforeEach(() => {
  mockCallTool = vi.fn();
  pageUrl = `${GOV}/index.html`;
  pageTitle = '';
  servePage();
  (mcpManager as unknown as { servers: Map<string, unknown> }).servers.set('abu-browser', {
    config: { name: 'abu-browser' }, client: { callTool: mockCallTool }, transport: {}, appTools: new Map(), tools: new Map(),
  });
  useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
  setMode('standard');
  __resetBrowserGrantsForTests();
  __resetTaskGrantsForTests();
  __resetUnattendedConfirmationForTests();
});

afterEach(() => {
  vi.useRealTimers();
  (mcpManager as unknown as { servers: Map<string, unknown> }).servers.delete('abu-browser');
  __resetBrowserGrantsForTests();
  __resetTaskGrantsForTests();
  __resetUnattendedConfirmationForTests();
});

const click = { tabId: TAB, locator: '{"text":"Search"}' };

describe('acting on a government site', () => {
  it.each(['standard', 'autonomous'] as const)('opening and reading a page asks nothing in %s mode', async (mode) => {
    setMode(mode);
    const { cb, asks } = recordingConfirm();
    for (const [tool, input] of [
      ['navigate', { tabId: TAB, url: `${GOV}/index.html` }],
      ['screenshot', { tabId: TAB }],
    ] as const) {
      const decision = await checkToolApproval(`abu-browser__${tool}`, input, attended(), cb as never);
      expect(decision.decision).toBe('allow');
    }
    expect(asks).toEqual([]);
  });

  it.each(['standard', 'autonomous'] as const)('the first click of a task asks once in %s mode, and the answer covers the task', async (mode) => {
    setMode(mode);
    const { cb, asks } = recordingConfirm();
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    await checkToolApproval('abu-browser__fill', { tabId: TAB, locator: '{"css":"#q"}', value: 'x' }, attended(), cb as never);
    expect(asks).toHaveLength(1);
    expect(asks[0].kind).toBe('browser');
    // A government site is approved for the task, never for good.
    expect(asks[0].alwaysAsks).toBeUndefined();
  });

  it('asks again once the half hour is over', async () => {
    vi.useFakeTimers();
    const { cb, asks } = recordingConfirm();
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    vi.advanceTimersByTime(TASK_GRANT_TTL_MS - 1000);
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    expect(asks).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    expect(asks).toHaveLength(2);
  });

  it('never covers another conversation', async () => {
    const { cb, asks } = recordingConfirm();
    await checkToolApproval('abu-browser__click', click, attended('conv-a'), cb as never);
    await checkToolApproval('abu-browser__click', click, attended('conv-b'), cb as never);
    expect(asks).toHaveLength(2);
  });

  it('a refused first click mints no grant', async () => {
    const refused = recordingConfirm(false);
    const first = await checkToolApproval('abu-browser__click', click, attended(), refused.cb as never);
    expect(first.decision).toBe('deny');
    const { cb, asks } = recordingConfirm();
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    expect(asks).toHaveLength(1);
  });

  it('a payment page asks on every action and the task grant does not cover it', async () => {
    const { cb, asks } = recordingConfirm();
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    expect(asks).toHaveLength(1);
    pageUrl = `${GOV}/tax/pay/confirm`;
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    expect(asks).toHaveLength(3);
  });

  it('a page titled as a payment asks every time, too', async () => {
    const { cb, asks } = recordingConfirm();
    pageUrl = `${GOV}/service/step2`;
    pageTitle = '在线缴费';
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    expect(asks).toHaveLength(2);
  });

  it('an unattended run may read a government page but not act on it', async () => {
    const read = await checkToolApproval('abu-browser__screenshot', { tabId: TAB }, unattended, (async () => true) as never);
    expect(read.decision).toBe('allow');
    const act = await checkToolApproval('abu-browser__click', click, unattended, (async () => true) as never);
    expect(act.decision).toBe('deny');
  });
});

describe('acting on a money-movement site', () => {
  beforeEach(() => { pageUrl = `${BANK}/myaccount/summary`; });

  it('opening and reading asks nothing; a click asks every time, even in autonomous mode', async () => {
    setMode('autonomous');
    const { cb, asks } = recordingConfirm();
    await checkToolApproval('abu-browser__navigate', { tabId: TAB, url: pageUrl }, attended(), cb as never);
    await checkToolApproval('abu-browser__screenshot', { tabId: TAB }, attended(), cb as never);
    expect(asks).toEqual([]);
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    await checkToolApproval('abu-browser__click', click, attended(), cb as never);
    expect(asks).toHaveLength(2);
  });
});

describe('connector tools', () => {
  const send = (to: unknown, extra: Record<string, unknown> = {}) => ({ to, subject: 's', body: 'hello', ...extra });

  it.each(['standard', 'smart', 'autonomous'] as const)('a send asks in %s mode and names the recipient', async (mode) => {
    setMode(mode);
    const { cb, asks } = recordingConfirm();
    const decision = await checkToolApproval('corpmail__send_email', send('boss@example.com'), attended(), cb as never);
    expect(decision.decision).toBe('allow');
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ kind: 'self-extension', alwaysAsks: true, level: 'warn' });
    expect(asks[0].command).toContain('boss@example.com');
    // The connector as the user named it, never the tool's own name.
    expect(asks[0].command).not.toContain('send_email');
  });

  it('a refused send is refused', async () => {
    const { cb } = recordingConfirm(false);
    const decision = await checkToolApproval('corpmail__send_email', send('boss@example.com'), attended(), cb as never);
    expect(decision.decision).toBe('deny');
  });

  it('an approved send covers the same tool and recipients for the rest of the task, not others', async () => {
    const { cb, asks } = recordingConfirm();
    await checkToolApproval('corpmail__send_email', send('a@example.com'), attended(), cb as never);
    await checkToolApproval('corpmail__send_email', send('a@example.com', { body: 'other text' }), attended(), cb as never);
    expect(asks).toHaveLength(1);
    await checkToolApproval('corpmail__send_email', send('b@example.com'), attended(), cb as never);
    expect(asks).toHaveLength(2);
    await checkToolApproval('corpmail__send_email', send('a@example.com'), attended('conv-b'), cb as never);
    expect(asks).toHaveLength(3);
  });

  it('an approved change covers the same file, not another file under the same account', async () => {
    const { cb, asks } = recordingConfirm();
    const update = (file: string, content: string) => ({ user_id: 'me', file_id: file, content });
    await checkToolApproval('drive__update_file', update('file-A', 'hello'), attended(), cb as never);
    await checkToolApproval('drive__update_file', update('file-A', 'hello again'), attended(), cb as never);
    expect(asks).toHaveLength(1);
    await checkToolApproval('drive__update_file', update('file-B', 'hello'), attended(), cb as never);
    expect(asks).toHaveLength(2);
    expect(asks[1].level).toBe('warn');
  });

  it('asks every time for a call whose target it cannot identify', async () => {
    const { cb, asks } = recordingConfirm();
    const routed = (to: string) => ({ message: { routing_key: to, text: 'hello' } });
    await checkToolApproval('corpmail__send_message', routed('recipient-A'), attended(), cb as never);
    await checkToolApproval('corpmail__send_message', routed('recipient-B'), attended(), cb as never);
    await checkToolApproval('corpmail__send_message', routed('recipient-A'), attended(), cb as never);
    expect(asks).toHaveLength(3);
  });

  it.each([
    ['corpmail__send_message', { to: 'a@example.com', text: 'hello' }],
    ['drive__update_file', { user_id: 'me', file_id: 'file-A', content: 'hello' }],
  ] as const)('%s asks every time when the server declares it destructive', async (tool, input) => {
    const tools = [{ name: tool, description: 'Does the thing', mcpDestructiveHint: true }];
    const spy = vi.spyOn(mcpManager, 'getServerTools').mockImplementation((server: string) => tools.filter((entry) => entry.name.startsWith(`${server}__`)) as never);
    try {
      const { cb, asks } = recordingConfirm();
      await checkToolApproval(tool, input, attended(), cb as never);
      await checkToolApproval(tool, input, attended(), cb as never);
      expect(asks.map((ask) => ask.level)).toEqual(['danger', 'danger']);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['corpmail__delete_message', 'danger'],
    ['bank__create_payment', 'danger'],
  ] as const)('%s asks every time at level %s', async (tool, level) => {
    const { cb, asks } = recordingConfirm();
    await checkToolApproval(tool, { id: '1' }, attended(), cb as never);
    await checkToolApproval(tool, { id: '1' }, attended(), cb as never);
    expect(asks).toHaveLength(2);
    expect(asks[0].level).toBe(level);
  });

  it('a read tool does not ask', async () => {
    const { cb, asks } = recordingConfirm();
    const decision = await checkToolApproval('corpmail__list_messages', {}, attended(), cb as never);
    expect(decision.decision).toBe('allow');
    expect(asks).toEqual([]);
  });

  it('refuses when nobody can be asked', async () => {
    const decision = await checkToolApproval('corpmail__send_email', send('a@example.com'), attended());
    expect(decision.decision).toBe('deny');
  });

  it('a server that marks a harmless-sounding tool destructive makes it ask; one that marks send read-only does not make it stop asking', async () => {
    const tools = [
      { name: 'files__tidy', description: 'Tidies the folder', mcpDestructiveHint: true },
      { name: 'corpmail__send_email', description: 'Sends mail', annotations: { readOnlyHint: true } },
    ];
    const spy = vi.spyOn(mcpManager, 'getServerTools').mockImplementation((server: string) => tools.filter((tool) => tool.name.startsWith(`${server}__`)) as never);
    try {
      const { cb, asks } = recordingConfirm();
      await checkToolApproval('files__tidy', {}, attended(), cb as never);
      await checkToolApproval('corpmail__send_email', send('a@example.com'), attended(), cb as never);
      expect(asks.map((ask) => ask.level)).toEqual(['danger', 'warn']);
    } finally {
      spy.mockRestore();
    }
  });

  it('asks about an unknown verb on a connector that writes, once per task, and not on one that only reads', async () => {
    const tools = [
      { name: 'crm__frobnicate', description: 'Runs the thing' },
      { name: 'crm__delete_contact', description: 'Deletes a contact' },
      { name: 'weather__frobnicate', description: 'Runs the thing' },
      { name: 'weather__get_forecast', description: 'Gets the forecast' },
    ];
    const spy = vi.spyOn(mcpManager, 'getServerTools').mockImplementation((server: string) => tools.filter((tool) => tool.name.startsWith(`${server}__`)) as never);
    try {
      const { cb, asks } = recordingConfirm();
      await checkToolApproval('crm__frobnicate', { id: '1' }, attended(), cb as never);
      await checkToolApproval('crm__frobnicate', { id: '1' }, attended(), cb as never);
      expect(asks).toHaveLength(1);
      expect(asks[0].level).toBe('warn');
      const decision = await checkToolApproval('weather__frobnicate', {}, attended(), cb as never);
      expect(decision.decision).toBe('allow');
      expect(asks).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
