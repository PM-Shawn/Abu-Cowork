import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homeDir } from '@tauri-apps/api/path';
import {
  sanitizeWorkspaceName,
  timestampWorkspaceName,
  computeDefaultWorkspaceName,
  prepareSuggestedWorkspace,
  bindWorkspaceFromWrite,
} from './defaultWorkspace';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { getI18n } from '@/i18n';

/** Force a scheduled/trigger flag onto an existing conversation record. */
function markHeadless(id: string, flag: 'scheduledTaskId' | 'triggerId') {
  useChatStore.setState((state) => ({
    conversations: {
      ...state.conversations,
      [id]: { ...state.conversations[id], [flag]: 'x' },
    },
  }));
}

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
    const generic = getI18n().chatDefaults.newConversationTitle;
    expect(computeDefaultWorkspaceName(generic, date)).toBe(timestampWorkspaceName(date));
  });
  it('falls back to a timestamp for empty title', () => {
    expect(computeDefaultWorkspaceName(undefined, date)).toBe('2026-07-05-090307');
  });
});

describe('prepareSuggestedWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homeDir).mockResolvedValue('/Users/test');
    useChatStore.setState({ conversations: {}, activeConversationId: null });
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
  });

  it('returns the existing workspace when one is bound', async () => {
    const id = useChatStore.getState().createConversation('/existing/ws', { skipActivate: true });
    expect(await prepareSuggestedWorkspace(id)).toBe('/existing/ws');
  });

  it('suggests ~/Abu/<name>/ WITHOUT binding it to the conversation', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.getState().renameConversation(id, 'my report');
    const suggested = await prepareSuggestedWorkspace(id);
    expect(suggested).toBe('/Users/test/Abu/my report');
    // Crucially NOT bound — a chat-only conversation must not show a workspace.
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBeFalsy();
    expect(useWorkspaceStore.getState().currentPath).toBeNull();
  });

  it('returns null when the home directory cannot be resolved', async () => {
    vi.mocked(homeDir).mockRejectedValue(new Error('no home'));
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    expect(await prepareSuggestedWorkspace(id)).toBeNull();
  });

  it('does NOT persist an always-grant for the merely-suggested path (no ghost grants)', async () => {
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {} });
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    await prepareSuggestedWorkspace(id);
    // Suggestion only authorizes in-memory (pathSafety); persisting an 'always'
    // grant per turn would accumulate ghost ~/Abu/<timestamp> entries.
    expect(Object.keys(usePermissionStore.getState().persistedGrants)).toHaveLength(0);
  });
});

describe('bindWorkspaceFromWrite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homeDir).mockResolvedValue('/Users/test');
    useChatStore.setState({ conversations: {}, activeConversationId: null });
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
  });

  it('binds ~/Abu/<top-folder>/ when the first write lands under ~/Abu/', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.setState({ activeConversationId: id });
    await bindWorkspaceFromWrite(id, '/Users/test/Abu/折线图/index.html');
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBe('/Users/test/Abu/折线图');
    expect(useWorkspaceStore.getState().currentPath).toBe('/Users/test/Abu/折线图');
  });

  it('does not touch the global path when the conversation is not active', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    await bindWorkspaceFromWrite(id, '/Users/test/Abu/proj/a.txt');
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBe('/Users/test/Abu/proj');
    expect(useWorkspaceStore.getState().currentPath).toBeNull();
  });

  it('is a no-op for writes outside ~/Abu/', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    await bindWorkspaceFromWrite(id, '/Users/test/Desktop/chart.html');
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBeFalsy();
  });

  it('is a no-op when the conversation already has a workspace', async () => {
    const id = useChatStore.getState().createConversation('/existing/ws', { skipActivate: true });
    await bindWorkspaceFromWrite(id, '/Users/test/Abu/other/x.txt');
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBe('/existing/ws');
  });

  it('binds ~/Abu itself when the write lands directly under ~/Abu (a file, not a folder)', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.setState({ activeConversationId: id });
    // Weaker model ignores the subfolder hint and writes ~/Abu/report.html.
    await bindWorkspaceFromWrite(id, '/Users/test/Abu/report.html');
    // Must bind the ~/Abu directory, NEVER the file (readDir on a file fails).
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBe('/Users/test/Abu');
  });

  it('is a no-op for headless scheduled runs (must not auto-create/bind ~/Abu)', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    markHeadless(id, 'scheduledTaskId');
    await bindWorkspaceFromWrite(id, '/Users/test/Abu/proj/a.txt');
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBeFalsy();
  });

  it('is a no-op for headless trigger runs', async () => {
    const id = useChatStore.getState().createConversation(null, { skipActivate: true });
    markHeadless(id, 'triggerId');
    await bindWorkspaceFromWrite(id, '/Users/test/Abu/proj/a.txt');
    expect(useChatStore.getState().conversations[id]?.workspacePath).toBeFalsy();
  });
});
