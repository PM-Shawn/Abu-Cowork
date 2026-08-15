import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { PermissionMode } from '../permissions/permissionMode';
import { __resetBrowserGrantsForTests } from '../permissions/browserToolPolicy';
import { checkToolApproval } from './registry';

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

    const decision = await checkToolApproval(
      'abu-browser__snapshot', { tabId: 1 }, { conversationId: 'conv-1' } as never, confirm as never,
    );

    expect(decision.decision).toBe('allow');
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
