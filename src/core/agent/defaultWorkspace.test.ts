import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homeDir } from '@tauri-apps/api/path';
import { exists } from '@tauri-apps/plugin-fs';
import {
  sanitizeWorkspaceName,
  timestampWorkspaceName,
  computeDefaultWorkspaceName,
  ensureDefaultWorkspace,
} from './defaultWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { getI18n } from '@/i18n';

describe('sanitizeWorkspaceName', () => {
  it('strips path-hostile characters', () => {
    expect(sanitizeWorkspaceName('a/b:c*d?e"f<g>h|i')).toBe('a b c d e f g h i');
  });
  it('collapses whitespace and keeps hyphens', () => {
    expect(sanitizeWorkspaceName('  codex-dj   report  ')).toBe('codex-dj report');
  });
  it('caps length to 40 chars', () => {
    expect(sanitizeWorkspaceName('x'.repeat(100))).toBe('x'.repeat(40));
  });
  it('drops trailing dots/spaces (Windows-hostile)', () => {
    expect(sanitizeWorkspaceName('report...  ')).toBe('report');
  });
  it('returns null for empty / whitespace / only-hostile input', () => {
    expect(sanitizeWorkspaceName('')).toBeNull();
    expect(sanitizeWorkspaceName('   ')).toBeNull();
    expect(sanitizeWorkspaceName('///')).toBeNull();
    expect(sanitizeWorkspaceName(undefined)).toBeNull();
  });
});

describe('timestampWorkspaceName', () => {
  it('formats YYYY-MM-DD-HHmmss zero-padded', () => {
    expect(timestampWorkspaceName(new Date(2026, 6, 5, 9, 3, 7))).toBe('2026-07-05-090307');
  });
});

describe('computeDefaultWorkspaceName', () => {
  const date = new Date(2026, 6, 5, 9, 3, 7);
  it('uses a meaningful title', () => {
    expect(computeDefaultWorkspaceName('生成折线图', date)).toBe('生成折线图');
  });
  it('falls back to a timestamp for the generic default title', () => {
    // Passing the actual "new task" default must yield a timestamp, not a
    // folder literally named that.
    const generic = getI18n().chatDefaults.newConversationTitle;
    expect(computeDefaultWorkspaceName(generic, date)).toBe(timestampWorkspaceName(date));
  });
  it('falls back to timestamp for empty title', () => {
    expect(computeDefaultWorkspaceName(undefined, date)).toBe('2026-07-05-090307');
  });
});

describe('ensureDefaultWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homeDir).mockResolvedValue('/Users/test');
    vi.mocked(exists).mockResolvedValue(false);
    useChatStore.setState({ conversations: {}, activeConversationId: null });
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
  });

  it('is a no-op when the conversation already has a workspace', async () => {
    const id = useChatStore.getState().createConversation('/existing/ws', { skipActivate: true });
    const result = await ensureDefaultWorkspace(id);
    // Returning the existing path (not a ~/Abu/... default) proves the early return.
    expect(result).toBe('/existing/ws');
  });

  it('binds a default ~/Abu/<name>/ when the conversation has none', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().renameConversation(id, 'my report');
    const result = await ensureDefaultWorkspace(id);
    expect(result).toBe('/Users/test/Abu/my report');
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBe('/Users/test/Abu/my report');
  });

  it('suffixes with a conversation id when the target folder already exists', async () => {
    vi.mocked(exists).mockResolvedValue(true);
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().renameConversation(id, 'report');
    const result = await ensureDefaultWorkspace(id);
    expect(result).toBe(`/Users/test/Abu/report-${id.slice(0, 6)}`);
  });

  it('reflects into the global current path only when the conversation is active', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().renameConversation(id, 'active one');
    useChatStore.setState({ activeConversationId: id });
    const result = await ensureDefaultWorkspace(id);
    expect(useWorkspaceStore.getState().currentPath).toBe(result);
  });

  it('returns null when the home directory cannot be resolved', async () => {
    vi.mocked(homeDir).mockRejectedValue(new Error('no home'));
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    const result = await ensureDefaultWorkspace(id);
    expect(result).toBeNull();
  });
});
