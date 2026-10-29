// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { exists, readTextFile, stat } from '@tauri-apps/plugin-fs';
import type { BranchIdentity, BranchPrepareRequest } from './conversationBranchProtocol';
import type { ConversationMeta } from './conversationWriter';

let branch: typeof import('./conversationBranch');
let chat: typeof import('@/stores/chatStore').useChatStore;
let settings: typeof import('@/stores/settingsStore').useSettingsStore;
let toasts: typeof import('@/stores/toastStore').useToastStore;
let files: Map<string, string>;
let bridge: ReturnType<typeof vi.fn>;
let beforePrepare: (() => void) | undefined;
let beforeManifest: (() => void) | undefined;
let beforeIndexWrite: (() => void) | undefined;
let failReindex: boolean;
let identities: BranchIdentity[];

const source = { id: 'source', title: 'Source', createdAt: 1, updatedAt: 2, status: 'idle' as const,
  workspacePath: '/workspace-a', messages: [
    { id: 'question', role: 'user' as const, content: 'Question', timestamp: 1, runState: 'completed' as const },
    { id: 'answer', role: 'assistant' as const, content: 'Answer', timestamp: 2, streamEnded: true },
  ] };
function childMeta(id = 'child'): ConversationMeta {
  return { id, title: 'Branch', createdAt: 3, updatedAt: 3, messageCount: 0,
    branchOrigin: { version: 1, sourceConversationId: 'source', sourceMessageId: 'answer', sourceTitle: 'Source', inheritedThroughMessageId: 'child-answer' } };
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
  vi.resetModules();
  files = new Map();
  identities = [];
  beforePrepare = undefined; beforeManifest = undefined; beforeIndexWrite = undefined; failReindex = false;
  vi.mocked(exists).mockImplementation(async filename => {
    if (String(filename).endsWith('outputs/manifest.json')) beforeManifest?.();
    return files.has(String(filename));
  });
  vi.mocked(readTextFile).mockImplementation(async filename => files.get(String(filename)) ?? '');
  vi.mocked(stat).mockResolvedValue({ size: 100 } as Awaited<ReturnType<typeof stat>>);
  vi.mocked(invoke).mockImplementation(async (command, args, options) => {
    const request = args instanceof Uint8Array
      ? { path: decodeURIComponent(options!.headers!.path), content: new TextDecoder().decode(args) }
      : args as { path?: string; content?: string; convId?: string } | undefined;
    if (command === 'atomic_write_text' && request?.path) {
      if (request.path.endsWith('index.json')) beforeIndexWrite?.();
      files.set(request.path, request.content!);
    }
    if (command === 'catalog_reindex_conversation' && failReindex) throw new Error('catalog-write-failed');
    return undefined;
  });
  bridge = vi.fn(async (action: string, request?: BranchPrepareRequest) => {
    if (action === 'lookup') return { state: 'absent' };
    if (action === 'pending') return [];
    if (action === 'cleanup') return [];
    if (action === 'prepare') {
      beforePrepare?.();
      identities.push(request!);
      return { state: 'prepared', token: 'prepared-token' };
    }
    if (action === 'commit' || action === 'publish') return { state: action === 'commit' ? 'committed' : 'published', meta: childMeta(request!.childConversationId) };
    if (action === 'discard') return undefined;
    throw new Error(`Unexpected IPC ${action}`);
  });
  vi.stubGlobal('__ABU_SHELL__', { mainSupervisesSidecar: true, conversationBranch: bridge });
  chat = (await import('@/stores/chatStore')).useChatStore;
  settings = (await import('@/stores/settingsStore')).useSettingsStore;
  toasts = (await import('@/stores/toastStore')).useToastStore;
  chat.setState({ conversations: { source: structuredClone(source) }, conversationIndex: {}, activeConversationId: 'source', loadFailures: {} });
  settings.setState({ viewMode: 'chat' });
  toasts.setState({ toasts: [] });
  branch = await import('./conversationBranch');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('branch creation across the renderer, store and real writer', () => {
  it('shares one pending operation and publishes only after the saved index', async () => {
    const first = branch.createConversationBranch('source', 'answer');
    const second = branch.createConversationBranch('source', 'answer');
    expect(first).toBe(second);
    const id = await first;
    expect(identities).toHaveLength(1);
    expect(chat.getState().conversationIndex[id]).toMatchObject(childMeta(id));
    const saved = JSON.parse(files.get('/Users/testuser/.abu/conversations/index.json')!);
    expect(saved.entries[id]).toMatchObject(childMeta(id));
    expect(branch.isConversationBranchCreating('source', 'answer')).toBe(false);
  });

  it('saves settings changed while reading the manifest before preparing the branch', async () => {
    beforeManifest = () => { chat.getState().setConversationWorkspace('source', '/workspace-b'); };
    beforePrepare = () => {
      const saved = JSON.parse(files.get('/Users/testuser/.abu/conversations/index.json')!);
      expect(saved.entries.source.workspacePath).toBe('/workspace-b');
    };
    await branch.createConversationBranch('source', 'answer');
    expect(chat.getState().conversations.source.workspacePath).toBe('/workspace-b');
  });

  it('rejects settings changed during index persistence before calling prepare', async () => {
    beforeIndexWrite = () => { chat.getState().setConversationWorkspace('source', '/workspace-c'); };
    await expect(branch.createConversationBranch('source', 'answer')).rejects.toThrow('source-changed');
    expect(identities).toHaveLength(0);
  });

  it('discards prepared history when the selected reply changed', async () => {
    beforePrepare = () => { chat.setState({ conversations: { source: { ...source, messages: source.messages.slice(0, 1) } } }); };
    await expect(branch.createConversationBranch('source', 'answer')).rejects.toThrow();
    expect(bridge.mock.calls.some(([action]) => action === 'discard')).toBe(true);
    expect(bridge.mock.calls.some(([action]) => action === 'commit')).toBe(false);
  });

  it('retains recovery identity after catalog failure and retries that same branch', async () => {
    let pending = true;
    bridge.mockImplementation(async (action: string) => {
      if (action === 'cleanup') return [];
      if (action === 'pending') return pending ? ['child'] : [];
      if (action === 'recover') return { state: 'committed', meta: childMeta() };
      if (action === 'publish') { pending = false; return { state: 'published', meta: childMeta() }; }
      throw new Error(`Unexpected IPC ${action}`);
    });
    failReindex = true;
    await branch.recoverConversationBranches();
    expect(chat.getState().conversationIndex.child).toBeUndefined();
    expect(pending).toBe(false);
    failReindex = false;
    toasts.getState().toasts.at(-1)!.actions![0].onClick();
    await vi.waitFor(() => expect(chat.getState().conversationIndex.child).toMatchObject(childMeta()));
    expect(bridge.mock.calls.filter(([action]) => action === 'recover')).toHaveLength(1);
  });

  it('keeps the new page selected when creation completes after navigating away and back', async () => {
    beforePrepare = () => {
      settings.setState({ viewMode: 'settings' });
      settings.setState({ viewMode: 'chat' });
    };
    branch.requestConversationBranch('source', 'answer');
    await vi.waitFor(() => expect(branch.isConversationBranchCreating('source', 'answer')).toBe(false));
    expect(identities).toHaveLength(1);
    expect(chat.getState().activeConversationId).toBe('source');
    expect(Object.keys(chat.getState().conversationIndex)).toHaveLength(1);
  });

  it('reports a pending scan failure and keeps its retry available', async () => {
    bridge.mockImplementation(async (action: string) => {
      if (action === 'cleanup') return [];
      throw new Error('directory-unreadable');
    });
    await branch.recoverConversationBranches();
    expect(toasts.getState().toasts).toHaveLength(1);
    const scans = bridge.mock.calls.filter(([action]) => action === 'pending').length;
    toasts.getState().toasts[0].actions![0].onClick();
    await vi.waitFor(() => expect(bridge.mock.calls.filter(([action]) => action === 'pending').length).toBeGreaterThan(scans));
  });

  it('recovers readable branches when another recovery record is corrupt', async () => {
    bridge.mockImplementation(async (action: string, request?: { childConversationId: string }) => {
      if (action === 'cleanup') return [];
      if (action === 'pending') return ['damaged', 'child'];
      if (action === 'recover' && request!.childConversationId === 'damaged') throw new Error('invalid-recovery');
      if (action === 'recover' || action === 'publish') return { state: action === 'recover' ? 'committed' : 'published', meta: childMeta() };
      throw new Error(`Unexpected IPC ${action}`);
    });
    await branch.recoverConversationBranches();
    expect(chat.getState().conversationIndex.child).toMatchObject(childMeta());
    expect(chat.getState().conversationIndex.damaged).toBeUndefined();
    expect(toasts.getState().toasts).toHaveLength(1);
  });

  it('retries every unpublished result when identical failure notices are combined', async () => {
    const pending = new Set(['child-a', 'child-b']);
    bridge.mockImplementation(async (action: string, request?: { childConversationId: string }) => {
      if (action === 'cleanup') return [];
      if (action === 'pending') return [...pending];
      if (action === 'recover') return { state: 'committed', meta: childMeta(request!.childConversationId) };
      if (action === 'publish') { pending.delete(request!.childConversationId); return { state: 'published', meta: childMeta(request!.childConversationId) }; }
      throw new Error(`Unexpected IPC ${action}`);
    });
    failReindex = true;
    await branch.recoverConversationBranches();
    expect(pending.size).toBe(0);
    expect(toasts.getState().toasts).toHaveLength(1);
    failReindex = false;
    toasts.getState().toasts[0].actions![0].onClick();
    await vi.waitFor(() => expect(Object.keys(chat.getState().conversationIndex).sort()).toEqual(['child-a', 'child-b']));
    expect(bridge.mock.calls.filter(([action]) => action === 'recover')).toHaveLength(2);
  });
});
