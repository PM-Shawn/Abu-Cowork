import { describe, it, expect, beforeEach, vi } from 'vitest';
import { exists, stat } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { setPlatformForTest } from '../../test/helpers';
import { TOOL_NAMES } from './toolNames';
import { getI18n } from '../../i18n';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { PermissionMode } from '../permissions/permissionMode';
import { __resetBrowserGrantsForTests } from '../permissions/browserToolPolicy';
import { setPluginServerNames, forgetPluginGrants } from '../permissions/pluginToolPolicy';
import { buildTriggerRunPermissionCeiling } from '../permissions/runPermissionCeiling';
import { checkToolApproval } from './registry';
import {
  createAuthorizationScope,
  disposeAuthorizationScope,
  scopedAuthorizeWorkspace,
} from './pathSafety';

const policyMocks = vi.hoisted(() => ({
  checkTool: vi.fn(() => ({ decision: 'allow' as const })),
  showPolicyConfirm: vi.fn(async () => true),
}));

vi.mock('@/core/enterprise/policy/enforcer', () => ({
  getCurrentPolicy: () => ({ mode: 'test-policy' }),
}));

vi.mock('@/core/enterprise/policy/matcher', () => ({
  checkTool: (...args: unknown[]) => policyMocks.checkTool(...args),
}));

vi.mock('@/components/enterprise/policyConfirmQueue', () => ({
  showPolicyConfirm: (...args: unknown[]) => policyMocks.showPolicyConfirm(...args),
}));

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

// Test the conversation-level permission mode resolution formula used in registry.ts.
// We test the logic in isolation via store state rather than calling executeTool directly
// (executeTool has too many Tauri/LLM dependencies).
function resolvePermissionMode(conversationId: string | undefined): PermissionMode {
  const convMode = conversationId
    ? useChatStore.getState().conversations[conversationId]?.permissionMode
    : undefined;
  return convMode ?? useSettingsStore.getState().permissionMode;
}

describe('permission mode resolution', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard' });
  });

  it('returns global setting when no conversationId given', () => {
    expect(resolvePermissionMode(undefined)).toBe('standard');
  });

  it('returns global setting when conversation has no override', () => {
    const id = useChatStore.getState().createConversation();
    expect(resolvePermissionMode(id)).toBe('standard');
  });

  it('returns conversation override when set', () => {
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().setConversationPermissionMode(id, 'autonomous');
    expect(resolvePermissionMode(id)).toBe('autonomous');
  });

  it('conversation override takes precedence over global setting', () => {
    useSettingsStore.setState({ permissionMode: 'autonomous' });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().setConversationPermissionMode(id, 'standard');
    expect(resolvePermissionMode(id)).toBe('standard');
  });

  it('falls back to global when conversation override is cleared to undefined', () => {
    useSettingsStore.setState({ permissionMode: 'smart' });
    const id = useChatStore.getState().createConversation();
    useChatStore.getState().setConversationPermissionMode(id, 'autonomous');
    useChatStore.getState().setConversationPermissionMode(id, undefined);
    expect(resolvePermissionMode(id)).toBe('smart');
  });
});

// ── write_file overwrite-safety read-precheck must not dead-end on $TMPDIR ──
// Regression for the R3.4 asymmetry: checkWritePath allows a macOS temp-dir
// write via its implicit-root match, but the overwrite-safety read-precheck was
// handed the CANONICAL resolved path (/private/var/folders/...), which breaks
// checkReadPath's lexical implicit-root match — so the write dead-ended at a read
// grant that no dialog could satisfy. The precheck must receive the lexical path.
describe('write_file $TMPDIR overwrite-safety precheck', () => {
  const runtimeTemp = '/var/folders/ab/cdef/T';

  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard' });
    vi.mocked(tempDir).mockResolvedValue(runtimeTemp);
    // macOS canonicalizes /var → /private/var; this is exactly the lexical↔canonical
    // divergence that broke the precheck when the canonical form was passed in.
    vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => {
      const value = String(candidate);
      return value.startsWith('/var/') ? `/private${value}` : value;
    });
    // Fresh, non-existent (or small) target: the large-write size guard is a no-op.
    vi.mocked(exists).mockResolvedValue(false);
  });

  it('allows a temp-dir write instead of dead-ending at "requires read authorization"', async () => {
    const cleanup = setPlatformForTest('macos');
    // Fail the test loudly if any code path tries to raise a permission dialog:
    // the temp dir is an implicit root, so no read grant should be needed.
    const onRequireFilePermission = vi.fn(async () => false);
    try {
      const decision = await checkToolApproval(
        TOOL_NAMES.WRITE_FILE,
        { path: `${runtimeTemp}/scratch.txt`, content: 'abu-test-ok' },
        { conversationId: 'conv-tmp' } as never,
        undefined,
        onRequireFilePermission as never,
      );
      expect(decision.decision).toBe('allow');
      expect(onRequireFilePermission).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

// ── Browser automation gate (end-to-end through checkToolApproval) ──
// Browser tools reach the user's logged-in sessions, the same consequence
// Computer Use already gates for browser apps. These pin the gate itself, not
// just the classifier, because the failure mode being fixed was a policy that
// existed but was never wired into the approval chain.
describe('browser automation approval gate', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard' });
    __resetBrowserGrantsForTests();
  });

  it('asks before a state-changing browser action, then not again in the same conversation', async () => {
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    const first = await checkToolApproval(
      'abu-browser__click', { ref: 'e1' }, { conversationId: 'conv-1' } as never, confirm as never,
    );
    const second = await checkToolApproval(
      'abu-browser__fill', { ref: 'e2', value: 'x' }, { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(first.decision).toBe('allow');
    expect(second.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('abu-browser__click');
  });

  it('a team browser approval never silently becomes a broader conversation grant (F1)', async () => {
    const confirm = vi.fn(async () => true);
    const context = { conversationId: 'team-browser', teamRoster: ['A'], agentName: 'A', loopId: 'l', toolCallId: 't' };
    await checkToolApproval('abu-browser__click', { ref: 'e1' }, context, confirm);
    await checkToolApproval('abu-browser__fill', { ref: 'e2', value: 'other action' }, context, confirm);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('denies the action when the user declines', async () => {
    const decision = await checkToolApproval(
      'abu-browser__execute_js', { code: 'fetch("/transfer")' },
      { conversationId: 'conv-1' } as never, (async () => false) as never,
    );
    expect(decision.decision).toBe('deny');
  });

  it('keeps asking in another conversation — the grant does not leak', async () => {
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    await checkToolApproval('abu-browser__click', {}, { conversationId: 'conv-1' } as never, confirm as never);
    await checkToolApproval('abu-browser__click', {}, { conversationId: 'conv-2' } as never, confirm as never);

    expect(asked).toHaveLength(2);
  });

  it('never asks for read-only browser tools', async () => {
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    const snapshotDecision = await checkToolApproval(
      'abu-browser__snapshot', { tabId: 1 }, { conversationId: 'conv-1' } as never, confirm as never,
    );
    const queryDecision = await checkToolApproval(
      'abu-browser__query_js', { tabId: 1, code: 'document.title' }, { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(snapshotDecision.decision).toBe('allow');
    expect(queryDecision.decision).toBe('allow');
    expect(asked).toHaveLength(0);
  });

  it('still asks in autonomous mode — this surface is approval-required in every mode', async () => {
    useSettingsStore.setState({ permissionMode: 'autonomous' });
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    await checkToolApproval('abu-browser__click', {}, { conversationId: 'conv-1' } as never, confirm as never);

    expect(asked).toHaveLength(1);
  });

  it('fails closed when there is no confirmation channel (headless/background run)', async () => {
    const decision = await checkToolApproval(
      'abu-browser__click', {}, { conversationId: 'conv-1' } as never, undefined,
    );
    expect(decision.decision).toBe('deny');
  });
});

// ── Persistent per-site verdicts ──
// "Always allow this site" from the confirmation dialog writes an exact-origin
// verdict into settings; the gate resolves it with denied > allowed > default.
// navigate carries its destination in the input, so these tests need no tab
// lookup (and thus no MCP server).
describe('browser site permission verdicts', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard', browserSitePermissions: {} });
    __resetBrowserGrantsForTests();
  });

  it('lets an allowed site through without asking', async () => {
    useSettingsStore.setState({ browserSitePermissions: { 'https://example.com': 'allowed' } });
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    const decision = await checkToolApproval(
      'abu-browser__navigate', { tabId: 1, url: 'https://example.com/report' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(decision.decision).toBe('allow');
    expect(asked).toHaveLength(0);
  });

  it('lets an allowed site through even with no confirmation channel (headless run; the scheduler itself passes an auto-deny callback, same outcome)', async () => {
    useSettingsStore.setState({ browserSitePermissions: { 'https://example.com': 'allowed' } });

    const decision = await checkToolApproval(
      'abu-browser__navigate', { tabId: 1, url: 'https://example.com/report' },
      { conversationId: 'sched-run-1' } as never, undefined,
    );

    expect(decision.decision).toBe('allow');
  });

  it('denies a blocked site outright, without offering confirmation', async () => {
    useSettingsStore.setState({ browserSitePermissions: { 'https://evil.com': 'denied' } });
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    const decision = await checkToolApproval(
      'abu-browser__navigate', { tabId: 1, url: 'https://evil.com/login' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(decision.decision).toBe('deny');
    expect(asked).toHaveLength(0);
  });

  it('a denied site stays denied even after a conversation grant — denied wins', async () => {
    useSettingsStore.setState({ browserSitePermissions: { 'https://evil.com': 'denied' } });
    const confirm = async () => true;

    // Earn a conversation grant on an unrelated action first.
    await checkToolApproval(
      'abu-browser__click', {}, { conversationId: 'conv-1' } as never, confirm as never,
    );
    const decision = await checkToolApproval(
      'abu-browser__navigate', { tabId: 1, url: 'https://evil.com/' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(decision.decision).toBe('deny');
  });

  it('an allowed parent domain does not cover a subdomain — exact origins only', async () => {
    useSettingsStore.setState({ browserSitePermissions: { 'https://example.com': 'allowed' } });
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    await checkToolApproval(
      'abu-browser__navigate', { tabId: 1, url: 'https://sub.example.com/' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(asked).toHaveLength(1);
  });

  it('a decoy url on navigate back/forward/reload cannot ride an allowed-site verdict', async () => {
    // The executor ignores `url` unless action === 'goto', so the gate must
    // not let a crafted allowed-site url approve a history navigation whose
    // real destination is unknown.
    useSettingsStore.setState({ browserSitePermissions: { 'https://allowed.com': 'allowed' } });
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    await checkToolApproval(
      'abu-browser__navigate', { tabId: 1, url: 'https://allowed.com/', action: 'back' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(asked).toHaveLength(1);
  });

  it('denies navigate back with a decoy allowed url when headless — no silent unattended ride', async () => {
    useSettingsStore.setState({ browserSitePermissions: { 'https://allowed.com': 'allowed' } });

    const decision = await checkToolApproval(
      'abu-browser__navigate', { tabId: 1, url: 'https://allowed.com/', action: 'reload' },
      { conversationId: 'sched-run-1' } as never, undefined,
    );

    expect(decision.decision).toBe('deny');
  });

  it('execute_js does not ride the conversation grant earned by a non-scripting approval', async () => {
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    // Approving a click mints the conversation grant…
    await checkToolApproval(
      'abu-browser__click', {}, { conversationId: 'conv-1' } as never, confirm as never,
    );
    // …but a script run in the same conversation must still ask.
    await checkToolApproval(
      'abu-browser__execute_js', { code: 'document.cookie' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(asked).toHaveLength(2);
  });

  it('approving a script does not mint the conversation grant for other browser actions', async () => {
    const asked: string[] = [];
    const confirm = async (info: { command: string }) => { asked.push(info.command); return true; };

    await checkToolApproval(
      'abu-browser__execute_js', { code: '1+1' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );
    await checkToolApproval(
      'abu-browser__click', {}, { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(asked).toHaveLength(2);
  });

  it('denies headless execute_js even on an allowed site — fail-closed pinned', async () => {
    useSettingsStore.setState({ browserSitePermissions: { 'https://example.com': 'allowed' } });

    const decision = await checkToolApproval(
      'abu-browser__execute_js', { tabId: 1, code: '1+1' },
      { conversationId: 'sched-run-1' } as never, undefined,
    );

    expect(decision.decision).toBe('deny');
  });

  it('execute_js never rides a site grant — scripts ask every time', async () => {
    useSettingsStore.setState({ browserSitePermissions: { 'https://example.com': 'allowed' } });
    const infos: Array<{ command: string; allowPersistentGrant?: boolean }> = [];
    const confirm = async (info: { command: string; allowPersistentGrant?: boolean }) => {
      infos.push(info);
      return true;
    };

    await checkToolApproval(
      'abu-browser__execute_js', { code: '1+1' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(infos).toHaveLength(1);
    expect(infos[0].allowPersistentGrant).toBe(false);
  });

  it('offers the persistent grant only when the origin is known', async () => {
    const infos: Array<{ browserOrigin?: string; allowPersistentGrant?: boolean }> = [];
    const confirm = async (info: { browserOrigin?: string; allowPersistentGrant?: boolean }) => {
      infos.push(info);
      return true;
    };

    // navigate with a URL: origin resolvable → grant offered.
    await checkToolApproval(
      'abu-browser__navigate', { tabId: 1, url: 'https://example.com/x' },
      { conversationId: 'conv-1' } as never, confirm as never,
    );
    __resetBrowserGrantsForTests();
    // click with no resolvable origin (no reachable MCP server in tests) → no grant offered.
    await checkToolApproval(
      'abu-browser__click', {}, { conversationId: 'conv-2' } as never, confirm as never,
    );

    expect(infos[0].browserOrigin).toBe('https://example.com');
    expect(infos[0].allowPersistentGrant).toBe(true);
    expect(infos[1].browserOrigin).toBeUndefined();
    expect(infos[1].allowPersistentGrant).toBe(false);
  });
});

// ── Enterprise policy confirm gate ──
describe('enterprise policy confirm gate', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard' });
    policyMocks.checkTool.mockReturnValue({ decision: 'allow' });
    policyMocks.showPolicyConfirm.mockResolvedValue(true);
    policyMocks.showPolicyConfirm.mockClear();
  });

  it('fails closed instead of showing policy confirmation during background runs', async () => {
    policyMocks.checkTool.mockReturnValue({ decision: 'confirm', reason: 'requires approval' });

    const decision = await checkToolApproval(
      'get_system_info',
      {},
      { interactionMode: 'background' } as never,
    );

    expect(decision.decision).toBe('deny');
    expect(decision.reason).toContain('[policy]');
    expect(policyMocks.showPolicyConfirm).not.toHaveBeenCalled();
  });

  it('preserves policy confirmation UI for foreground runs', async () => {
    policyMocks.checkTool.mockReturnValue({ decision: 'confirm', reason: 'requires approval' });

    const decision = await checkToolApproval(
      'get_system_info',
      {},
      { interactionMode: 'foreground' } as never,
    );

    expect(decision.decision).toBe('allow');
    expect(policyMocks.showPolicyConfirm).toHaveBeenCalledWith('requires approval');
  });

  it('denies by policy before the large-write guard probes file metadata', async () => {
    const scopeId = createAuthorizationScope();
    const path = '/Users/testuser/Projects/policy-denied-large.html';
    try {
      scopedAuthorizeWorkspace(scopeId, path, ['read', 'write']);
      policyMocks.checkTool.mockReturnValue({ decision: 'deny', reason: 'blocked destination' });
      vi.mocked(exists).mockClear();
      vi.mocked(stat).mockClear();
      vi.mocked(exists).mockResolvedValueOnce(true);
      vi.mocked(stat).mockResolvedValueOnce({ size: 16 * 1024 } as never);

      const decision = await checkToolApproval(
        'write_file',
        { path, content: 'replacement' },
        { authorizationScopeId: scopeId, interactionMode: 'background' } as never,
      );

      expect(decision).toEqual({ decision: 'deny', reason: 'Error: [policy] blocked destination' });
      expect(exists).not.toHaveBeenCalled();
      expect(stat).not.toHaveBeenCalled();
    } finally {
      disposeAuthorizationScope(scopeId);
    }
  });
});

describe('command confirmation channel', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard' });
    policyMocks.checkTool.mockReturnValue({ decision: 'allow' });
  });

  it('fails closed when a command requires confirmation but no channel exists', async () => {
    const decision = await checkToolApproval(
      'run_command',
      { command: 'git reset --hard' },
      { interactionMode: 'background' } as never,
    );

    expect(decision.decision).toBe('deny');
  });
});

// ── Self-extension gate ──
// Creating a subagent, installing an MCP server, or rewriting the persona all
// write durable state that shapes every later turn. Each is confirmed on its
// own — unlike browser automation there is no per-conversation grant.
describe('self-extension approval gate', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard' });
  });

  const collectingConfirm = (asked: string[]) =>
    (async (info: { command: string }) => { asked.push(info.command); return true; }) as never;

  it('asks before saving an agent, and names it', async () => {
    const asked: string[] = [];
    const decision = await checkToolApproval(
      'save_agent', { name: 'helper', systemPrompt: 'do things' },
      { conversationId: 'conv-1' } as never, collectingConfirm(asked),
    );

    expect(decision.decision).toBe('allow');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('helper');
  });

  it.each([
    [true, undefined, 'selfExtensionSaveAgentReplace'],
    [true, true, 'selfExtensionSaveAgentReplace'],
    // `overwrite: true` may replace an expert created while the approval waits.
    [false, true, 'selfExtensionSaveAgentReplace'],
    [false, undefined, 'selfExtensionSaveAgentNew'],
  ] as const)('asks to save an agent as "new" only when no AGENT.md is on disk and overwrite is not requested (on disk: %s, overwrite: %s)', async (onDisk, overwrite, label) => {
    const target = '/Users/testuser/.abu/agents/helper/AGENT.md';
    vi.mocked(exists).mockImplementation(async (path) => onDisk && path === target);
    const asked: string[] = [];

    await checkToolApproval(
      'save_agent', { name: 'helper', content: '---\nname: helper\n---\nP', ...(overwrite === undefined ? {} : { overwrite }) },
      { conversationId: 'conv-1' } as never, collectingConfirm(asked),
    );

    expect(asked).toEqual([`save_agent (${getI18n().commandConfirm[label]}): helper`]);
  });

  it.each([
    ['save_agent', { name: 'helper', systemPrompt: 'do things' }],
    ['manage_trigger', { action: 'create', name: 't', prompt: 'p' }],
    ['manage_mcp_server', { action: 'install', name: 'a' }],
  ])('routes the %s confirmation to the loop that raised it', async (name, input) => {
    // The callback stamps the request with a conversation so ChatView can show
    // the dialog in the right chat. Omitting loopId makes permissionBridge fall
    // back to getCurrentLoopContext() — the FIRST entry of the global loop map
    // — so with a second loop registered the dialog is tagged with the wrong
    // conversation, never renders, and the run waits forever on an approval
    // nobody can see.
    const seen: Array<string | undefined> = [];
    const confirm = (async (_info: unknown, loopId?: string) => {
      seen.push(loopId);
      return true;
    }) as never;

    await checkToolApproval(
      name,
      input as Record<string, unknown>,
      { conversationId: 'conv-1', loopId: 'loop-1' } as never,
      confirm,
    );

    expect(seen).toEqual(['loop-1']);
  });

  it('asks before rewriting the persona', async () => {
    const asked: string[] = [];
    await checkToolApproval(
      'update_soul', { content: 'new persona' }, { conversationId: 'conv-1' } as never, collectingConfirm(asked),
    );
    expect(asked).toHaveLength(1);
  });

  it('asks for every install — approving one does not grant the next', async () => {
    const asked: string[] = [];
    const confirm = collectingConfirm(asked);

    await checkToolApproval('manage_mcp_server', { action: 'install', name: 'a' }, { conversationId: 'conv-1' } as never, confirm);
    await checkToolApproval('manage_mcp_server', { action: 'add_custom', name: 'b' }, { conversationId: 'conv-1' } as never, confirm);

    expect(asked).toHaveLength(2);
  });

  it('leaves read-only MCP actions alone', async () => {
    const asked: string[] = [];
    const decision = await checkToolApproval(
      'manage_mcp_server', { action: 'search', query: 'github' },
      { conversationId: 'conv-1' } as never, collectingConfirm(asked),
    );

    expect(decision.decision).toBe('allow');
    expect(asked).toHaveLength(0);
  });

  it('denies when the user declines the install', async () => {
    const decision = await checkToolApproval(
      'manage_mcp_server', { action: 'install', name: 'sketchy' },
      { conversationId: 'conv-1' } as never, (async () => false) as never,
    );
    expect(decision.decision).toBe('deny');
  });

  it('fails closed with no confirmation channel, in every permission mode', async () => {
    for (const mode of ['standard', 'smart', 'autonomous'] as const) {
      useSettingsStore.setState({ permissionMode: mode });
      const decision = await checkToolApproval(
        'save_agent', { name: 'x' }, { conversationId: 'conv-1' } as never, undefined,
      );
      expect(decision.decision).toBe('deny');
    }
  });

  it.each([
    ['manage_trigger', 'update'],
    ['manage_scheduled_task', 'create'],
    ['manage_file_watch', 'add'],
  ])('does not let a custom wildcard trigger persist authority through %s(%s)', async (name, action) => {
    useSettingsStore.setState({ permissionMode: 'autonomous' });
    const confirm = vi.fn(async () => true);
    const decision = await checkToolApproval(
      name,
      { action },
      {
        conversationId: 'conv-1',
        interactionMode: 'background',
        runPermissionCeiling: buildTriggerRunPermissionCeiling({
          prompt: 'legacy custom',
          capability: 'custom',
          permissions: { allowedTools: ['*'] },
        }),
      } as never,
      confirm as never,
    );

    expect(decision.decision).toBe('deny');
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(['manage_trigger', 'manage_scheduled_task', 'manage_file_watch'])(
    'keeps %s(list) available to a custom wildcard trigger',
    async (name) => {
      const confirm = vi.fn(async () => true);
      const decision = await checkToolApproval(
        name,
        { action: 'list' },
        {
          conversationId: 'conv-1',
          interactionMode: 'background',
          runPermissionCeiling: buildTriggerRunPermissionCeiling({
            prompt: 'legacy custom',
            capability: 'custom',
            permissions: { allowedTools: ['*'] },
          }),
        } as never,
        confirm as never,
      );

      expect(decision.decision).toBe('allow');
      expect(confirm).not.toHaveBeenCalled();
    },
  );
});

describe('plugin tool approval gate', () => {
  beforeEach(() => {
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    useSettingsStore.setState({ permissionMode: 'standard' });
    setPluginServerNames(['weather']);
    forgetPluginGrants();
  });

  const collectingConfirm = (asked: string[]) =>
    (async (info: { command: string }) => { asked.push(info.command); return true; }) as never;

  // The whole point of pluginToolPolicy: before it, `consequence` was undefined
  // for every non-browser MCP server, so `decideConsequentialTool` returned
  // 'allow' — identically in all three modes. This asserts the gap is closed
  // in each of them, not just the strictest one.
  it.each(['standard', 'smart', 'full'] as const)(
    'asks before running a plugin-contributed MCP tool in %s mode',
    async (mode) => {
      useSettingsStore.setState({ permissionMode: mode });
      const asked: string[] = [];
      const decision = await checkToolApproval(
        'weather__get_forecast', {}, { conversationId: 'conv-1' } as never, collectingConfirm(asked),
      );

      expect(decision.decision).toBe('allow');
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('weather__get_forecast');
    },
  );

  it('does not ask for an MCP server no plugin contributed', async () => {
    const asked: string[] = [];
    await checkToolApproval(
      'handwired__do_thing', {}, { conversationId: 'conv-1' } as never, collectingConfirm(asked),
    );
    expect(asked).toHaveLength(0);
  });

  it('denies when the user declines', async () => {
    const decision = await checkToolApproval(
      'weather__get_forecast', {}, { conversationId: 'conv-1' } as never,
      (async () => false) as never,
    );
    expect(decision.decision).toBe('deny');
  });

  it('a team plugin approval cannot become a server-wide conversation grant (F1)', async () => {
    const asked: string[] = [];
    const context = { conversationId: 'team-plugin', teamRoster: ['A'], agentName: 'A', loopId: 'l', toolCallId: 't' };
    await checkToolApproval('weather__get_forecast', {}, context, collectingConfirm(asked));
    await checkToolApproval('weather__list_stations', {}, context, collectingConfirm(asked));
    expect(asked).toHaveLength(2);
  });

  it('only asks once per conversation for the same plugin', async () => {
    const asked: string[] = [];
    const confirm = collectingConfirm(asked);
    await checkToolApproval('weather__get_forecast', {}, { conversationId: 'conv-1' } as never, confirm);
    await checkToolApproval('weather__list_stations', {}, { conversationId: 'conv-1' } as never, confirm);
    expect(asked).toHaveLength(1);
  });

  it('does not let one plugin approval cover a different plugin', async () => {
    setPluginServerNames(['weather', 'notes']);
    const asked: string[] = [];
    const confirm = collectingConfirm(asked);
    await checkToolApproval('weather__get_forecast', {}, { conversationId: 'conv-1' } as never, confirm);
    await checkToolApproval('notes__delete_all', {}, { conversationId: 'conv-1' } as never, confirm);
    expect(asked).toHaveLength(2);
  });

  it('fails closed when there is no confirmation channel', async () => {
    // A headless/background run must not become the cheap path to executing
    // third-party plugin code the user never saw.
    const decision = await checkToolApproval(
      'weather__get_forecast', {}, { conversationId: 'conv-1' } as never, undefined,
    );
    expect(decision.decision).toBe('deny');
  });

  it('denies plugin tools under a scheduled run ceiling', async () => {
    const decision = await checkToolApproval(
      'weather__get_forecast', {},
      { conversationId: 'conv-1', runPermissionCeiling: buildTriggerRunPermissionCeiling('scheduled') } as never,
      (async () => true) as never,
    );
    expect(decision.decision).toBe('deny');
  });
});

describe('team file retry boundary (F1/F2)', () => {
  it('approves exact write+overwrite-read parameters in a call scope and disposes it', async () => {
    const { requestFilePermission, setLoopContext, clearLoopContext } = await import('../agent/permissionBridge');
    const { useTeamConfirmationStore } = await import('../../stores/teamConfirmationStore');
    const { usePermissionStore } = await import('../../stores/permissionStore');
    const { isInScopedAuthorizedWorkspace } = await import('./pathSafety');
    useChatStore.setState({ conversations: { 'file-team': { id: 'file-team', teamId: 't', title: 't', createdAt: 1, updatedAt: 1, status: 'running', messages: [] } } });
    useSettingsStore.setState({ permissionMode: 'standard' });
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {}, pendingRequest: null });
    useTeamConfirmationStore.setState({ pending: {}, approvedOnce: {}, runRules: {}, retrySelections: {} });
    policyMocks.checkTool.mockReturnValue({ decision: 'allow' });
    vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (path) => String(path));
    vi.mocked(exists).mockReset().mockResolvedValue(false);
    const path = '/Users/testuser/ExternalReview/exact.txt';
    const input = { path, content: 'approved contents' };
    const context = { conversationId: 'file-team', loopId: 'original-file', toolCallId: 'call-1', agentName: 'A', teamRoster: ['A'],
      teamApprovalDispatch: { id: 'dispatch-1', fingerprint: 'task' } };
    const makeLoop = (loopId: string) => ({ loopId, conversationId: 'file-team', signal: new AbortController().signal,
      commandConfirmCallback: async () => false, filePermissionCallback: requestFilePermission, eventRouter: {} as never, toolCallToStepId: new Map() });
    setLoopContext('original-file', makeLoop('original-file'));
    setLoopContext('retry-file', makeLoop('retry-file'));
    let scope: string | undefined;
    const callback: typeof requestFilePermission = async (request, loopId) => {
      scope = request.teamAuthorizationScopeId;
      return requestFilePermission(request, loopId);
    };
    try {
      expect((await checkToolApproval('write_file', input, context, undefined, callback)).decision).toBe('deny');
      const pending = Object.values(useTeamConfirmationStore.getState().pending)[0];
      expect(pending).toMatchObject({ capability: 'write', additionalCapabilities: ['read'] });
      const selected = useTeamConfirmationStore.getState().selectRetry(pending.id, 'once');
      useTeamConfirmationStore.getState().beginRetry('file-team', 'retry-file', selected);
      useTeamConfirmationStore.getState().claimDispatch('file-team', 'retry-file', 'retry-dispatch', 'task', 'A');
      const retryContext = { ...context, loopId: 'retry-file', toolCallId: 'call-2', teamApprovalDispatch: { id: 'retry-dispatch', fingerprint: 'task' } };
      expect((await checkToolApproval('write_file', { ...input, content: 'different contents' }, retryContext, undefined, callback)).decision).toBe('deny');
      const outcome = await checkToolApproval('write_file', input, retryContext, undefined, callback);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ decision: 'allow' });
      expect(scope).toBeDefined();
      expect(isInScopedAuthorizedWorkspace(path, 'write', scope)).toBe(false);
      expect(isInScopedAuthorizedWorkspace(path, 'read', scope)).toBe(false);
      expect(usePermissionStore.getState().hasPermission(path, 'write')).toBe(false);
      expect((await checkToolApproval('write_file', input, retryContext, undefined, callback)).decision).toBe('deny');
    } finally { clearLoopContext('original-file'); clearLoopContext('retry-file'); useTeamConfirmationStore.getState().clearConversation('file-team'); }
  });
});
