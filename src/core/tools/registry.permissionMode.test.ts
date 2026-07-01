import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { PermissionMode } from '../permissions/permissionMode';

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
