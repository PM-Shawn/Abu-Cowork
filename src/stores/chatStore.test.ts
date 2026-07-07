import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { useChatStore, flushTokenBuffer } from './chatStore';
import type { Conversation } from '../types';

// Stable workspace store mock — Task #34 regression tests need to assert
// that clearWorkspace is NOT called on start/switch flows, so the fn
// instances must persist across getState() calls.
const mockSetWorkspace = vi.fn();
const mockClearWorkspace = vi.fn();
vi.mock('./workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      setWorkspace: mockSetWorkspace,
      clearWorkspace: mockClearWorkspace,
    }),
    subscribe: vi.fn(),
  },
}));

// Project store mock — createConversation auto-associates the new conv
// with any project whose workspacePath matches (regression for welcome-
// page "create project → first message lands in 最近 instead of project").
const mockGetProjectByWorkspace = vi.fn<(ws: string) => { id: string; name: string } | undefined>();
vi.mock('./projectStore', () => ({
  useProjectStore: {
    getState: () => ({ getProjectByWorkspace: mockGetProjectByWorkspace }),
  },
}));

describe('chatStore', () => {
  beforeEach(() => {
    mockSetWorkspace.mockClear();
    mockClearWorkspace.mockClear();
    mockGetProjectByWorkspace.mockReset();
    mockGetProjectByWorkspace.mockReturnValue(undefined);
    useChatStore.setState({
      conversations: {},
      // conversationIndex must reset alongside conversations: deleteConversation
      // now uses the index (not the conversations map) to compute the successor
      // active conv after deleting the active one, so leftover index entries
      // from earlier tests would leak across cases.
      conversationIndex: {},
      activeConversationId: null,
      agentStatus: 'idle',
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      thinkingStartTime: null,
    });
  });

  // ── createConversation ──
  describe('createConversation', () => {
    it('creates a conversation and sets it active', () => {
      const id = useChatStore.getState().createConversation();
      const state = useChatStore.getState();
      expect(state.conversations[id]).toBeDefined();
      expect(state.conversations[id].title).toBe('新任务');
      expect(state.activeConversationId).toBe(id);
    });

    it('creates conversation with workspace path', () => {
      const id = useChatStore.getState().createConversation('/Users/test/project');
      expect(useChatStore.getState().conversations[id].workspacePath).toBe('/Users/test/project');
    });

    it('auto-associates projectId when workspace matches a project', () => {
      // Regression: welcome-page flow after "create project → first message"
      // used to land the conversation in 最近 because createConversation was
      // called with only a workspace path. The lookup now runs inside
      // createConversation so every entry point (ChatView, schedule, IM)
      // benefits without plumbing projectId through each caller.
      mockGetProjectByWorkspace.mockReturnValue({ id: 'proj-123', name: 'DA' });
      const id = useChatStore.getState().createConversation('/Users/test/da');
      expect(mockGetProjectByWorkspace).toHaveBeenCalledWith('/Users/test/da');
      expect(useChatStore.getState().conversations[id].projectId).toBe('proj-123');
    });

    it('leaves projectId undefined when no project matches', () => {
      mockGetProjectByWorkspace.mockReturnValue(undefined);
      const id = useChatStore.getState().createConversation('/Users/test/orphan');
      expect(useChatStore.getState().conversations[id].projectId).toBeUndefined();
    });

    it('respects explicit options.projectId over auto-lookup', () => {
      mockGetProjectByWorkspace.mockReturnValue({ id: 'proj-auto', name: 'A' });
      const id = useChatStore.getState().createConversation('/Users/test/x', {
        projectId: 'proj-explicit',
      });
      // Auto-lookup must not run when caller already knows the project.
      // Schedule/trigger/IM invocations pass projectId explicitly and
      // expect their value to win even if the workspace happens to match
      // a different project entry.
      expect(useChatStore.getState().conversations[id].projectId).toBe('proj-explicit');
    });

    it('skips project lookup when workspace is null', () => {
      useChatStore.getState().createConversation(null);
      expect(mockGetProjectByWorkspace).not.toHaveBeenCalled();
    });
  });

  // ── startNewConversation ──
  describe('startNewConversation', () => {
    it('sets activeConversationId to null', () => {
      useChatStore.getState().createConversation();
      useChatStore.getState().startNewConversation();
      expect(useChatStore.getState().activeConversationId).toBeNull();
    });

    it('clears the global workspace (top-level "新建任务" = fresh start)', () => {
      // Mental model: top-level "新建任务" is "step out of current project
      // context". No ambient workspace leak into the new task. If agent
      // needs workspace later it'll call request_workspace (orchestrator
      // workspace-hint + Task #37 hint chain).
      useChatStore.getState().createConversation();
      useChatStore.getState().startNewConversation();
      expect(mockClearWorkspace).toHaveBeenCalled();
    });
  });

  // ── switchConversation ──
  describe('switchConversation', () => {
    it('switches active conversation', async () => {
      const id1 = useChatStore.getState().createConversation();
      useChatStore.getState().createConversation();
      await useChatStore.getState().switchConversation(id1);
      expect(useChatStore.getState().activeConversationId).toBe(id1);
    });

    it('applies target conv workspace when bound', async () => {
      const id = useChatStore.getState().createConversation('/Users/test/bound');
      await useChatStore.getState().switchConversation(id);
      expect(mockSetWorkspace).toHaveBeenCalledWith('/Users/test/bound');
    });

    it('clears workspace when target conv has no binding', async () => {
      // Users expect each conversation to track with its own workspace.
      // Switching to an unbound conv with stale ambient workspace would
      // confuse the user ("why is my project still showing?"). Clearing
      // here makes conv ↔ workspace relationship predictable; the earlier
      // "tool lost workspace mid-session" cascade is defended by the
      // b2b69c6 / ffeb7cb / 4ba56d3 patches downstream.
      const id = useChatStore.getState().createConversation(); // no workspace arg
      await useChatStore.getState().switchConversation(id);
      expect(mockClearWorkspace).toHaveBeenCalled();
    });
  });

  // ── deleteConversation ──
  describe('deleteConversation', () => {
    it('deletes a conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().deleteConversation(id);
      expect(useChatStore.getState().conversations[id]).toBeUndefined();
    });

    it('switches to another conversation when active is deleted', async () => {
      const id1 = useChatStore.getState().createConversation();
      const id2 = useChatStore.getState().createConversation();
      await useChatStore.getState().switchConversation(id2);
      useChatStore.getState().deleteConversation(id2);
      // Should fallback to remaining conversation
      const state = useChatStore.getState();
      expect(state.activeConversationId).toBe(id1);
    });

    /**
     * Direct seed of conversations + conversationIndex with controlled
     * createdAt so neighbour-by-position assertions are deterministic.
     * Mirrors the shape created by createConversation but bypasses Date.now().
     */
    function seedConvs(items: Array<{
      id: string;
      createdAt: number;
      projectId?: string;
      scheduledTaskId?: string;
      triggerId?: string;
    }>) {
      type ConvShape = Record<string, unknown>;
      const conversations: Record<string, ConvShape> = {};
      const conversationIndex: Record<string, ConvShape> = {};
      for (const item of items) {
        const meta: ConvShape = {
          id: item.id,
          title: `Conv ${item.id}`,
          createdAt: item.createdAt,
          updatedAt: item.createdAt,
          messageCount: 0,
          ...(item.projectId ? { projectId: item.projectId } : {}),
          ...(item.scheduledTaskId ? { scheduledTaskId: item.scheduledTaskId } : {}),
          ...(item.triggerId ? { triggerId: item.triggerId } : {}),
        };
        conversations[item.id] = { ...meta, messages: [], status: 'idle' };
        conversationIndex[item.id] = meta;
      }
      // setState typing is intentionally loose for fixture seeding
      useChatStore.setState({
        conversations: conversations as never,
        conversationIndex: conversationIndex as never,
      });
    }

    describe('focus movement after delete (B3)', () => {
      it('moves focus to prev (newer) neighbour when deleting middle conversation', () => {
        // Visual order desc: d (newest), c, b, a (oldest)
        seedConvs([
          { id: 'a', createdAt: 1000 },
          { id: 'b', createdAt: 2000 },
          { id: 'c', createdAt: 3000 },
          { id: 'd', createdAt: 4000 },
        ]);
        useChatStore.setState({ activeConversationId: 'b' });
        useChatStore.getState().deleteConversation('b');
        // Deleting b: prev (above b in UI) = c
        expect(useChatStore.getState().activeConversationId).toBe('c');
      });

      it('falls back to next (older) when deleting the topmost conversation', () => {
        seedConvs([
          { id: 'a', createdAt: 1000 },
          { id: 'b', createdAt: 2000 },
        ]);
        useChatStore.setState({ activeConversationId: 'b' });
        useChatStore.getState().deleteConversation('b');
        // b is newest, no prev → next = a
        expect(useChatStore.getState().activeConversationId).toBe('a');
      });

      it('returns null when deleting the only conversation in scope', () => {
        seedConvs([{ id: 'a', createdAt: 1000 }]);
        useChatStore.setState({ activeConversationId: 'a' });
        useChatStore.getState().deleteConversation('a');
        expect(useChatStore.getState().activeConversationId).toBeNull();
      });

      it('stays within the same project scope', () => {
        // recent r1, r2 + project p1, p2
        seedConvs([
          { id: 'r1', createdAt: 1000 },
          { id: 'r2', createdAt: 4000 }, // newest in recent
          { id: 'p1', createdAt: 2000, projectId: 'proj-1' },
          { id: 'p2', createdAt: 3000, projectId: 'proj-1' }, // newest in project
        ]);
        useChatStore.setState({ activeConversationId: 'p2' });
        useChatStore.getState().deleteConversation('p2');
        // proj-1 sorted: p2, p1. Deleting p2 → no prev, next = p1.
        // Must not jump to r2 even though r2 is newer overall.
        expect(useChatStore.getState().activeConversationId).toBe('p1');
      });

      it('returns null when project has only the deleted conversation', () => {
        seedConvs([
          { id: 'r1', createdAt: 1000 },
          { id: 'p1', createdAt: 2000, projectId: 'proj-1' },
        ]);
        useChatStore.setState({ activeConversationId: 'p1' });
        useChatStore.getState().deleteConversation('p1');
        // proj-1 empty after delete → null, NOT pulled into recent (r1)
        expect(useChatStore.getState().activeConversationId).toBeNull();
      });

      it('does not change active when deleting a non-active conversation', () => {
        seedConvs([
          { id: 'a', createdAt: 1000 },
          { id: 'b', createdAt: 2000 },
        ]);
        useChatStore.setState({ activeConversationId: 'a' });
        useChatStore.getState().deleteConversation('b');
        expect(useChatStore.getState().activeConversationId).toBe('a');
      });

      it('keeps automation conversations isolated from regular pool', () => {
        seedConvs([
          { id: 'r1', createdAt: 1000 },
          { id: 'r2', createdAt: 2000 },
          { id: 's1', createdAt: 3000, scheduledTaskId: 'task-1' },
          { id: 's2', createdAt: 4000, scheduledTaskId: 'task-1' },
        ]);
        useChatStore.setState({ activeConversationId: 's1' });
        useChatStore.getState().deleteConversation('s1');
        // s1 / s2 in same scheduled scope; sorted: s2, s1. Deleting s1: prev = s2.
        // Should not jump to r2.
        expect(useChatStore.getState().activeConversationId).toBe('s2');
      });

      it('clears notice badge for deleted and successor conversations', async () => {
        const { useNoticeBadgeStore } = await import('./noticeBadgeStore');
        seedConvs([
          { id: 'a', createdAt: 1000 },
          { id: 'b', createdAt: 2000 },
        ]);
        // Plant pre-existing badges on both convs
        useNoticeBadgeStore.setState({ counts: { a: 3, b: 1, other: 5 } });
        useChatStore.setState({ activeConversationId: 'b' });
        useChatStore.getState().deleteConversation('b');
        // Wait for the dynamic import().then() badge clears to settle
        await new Promise((r) => setTimeout(r, 0));
        const counts = useNoticeBadgeStore.getState().counts;
        // Deleted conv's badge gone (no orphan entries on a non-existent conv)
        expect(counts.b).toBeUndefined();
        // Successor conv (a) badge cleared — focus moved there, so it's now "viewed"
        expect(counts.a).toBeUndefined();
        // Unrelated conv badge untouched
        expect(counts.other).toBe(5);
      });
    });
  });

  // ── renameConversation ──
  describe('renameConversation', () => {
    it('renames a conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().renameConversation(id, '测试对话');
      expect(useChatStore.getState().conversations[id].title).toBe('测试对话');
    });
  });

  // ── addMessage ──
  describe('addMessage', () => {
    it('adds a message to conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'Hello', timestamp: Date.now(),
      });
      const conv = useChatStore.getState().conversations[id];
      expect(conv.messages).toHaveLength(1);
      expect(conv.messages[0].content).toBe('Hello');
    });

    it('auto-titles from first user message', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: '帮我写一个函数', timestamp: Date.now(),
      });
      const title = useChatStore.getState().conversations[id].title;
      expect(title).toContain('帮我写一个函数');
    });

    it('truncates long auto-titles to 30 chars', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'x'.repeat(50), timestamp: Date.now(),
      });
      const title = useChatStore.getState().conversations[id].title;
      expect(title.length).toBeLessThanOrEqual(34); // 30 + "..."
    });
  });

  // ── appendToLastMessage ──
  describe('appendToLastMessage', () => {
    it('appends token to last message', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'assistant', content: 'Hello', timestamp: Date.now(),
      });
      useChatStore.getState().appendToLastMessage(id, ' World');
      // Tokens are buffered via RAF; flush to apply immediately in test
      flushTokenBuffer(id);
      const msg = useChatStore.getState().conversations[id].messages[0];
      expect(msg.content).toBe('Hello World');
    });

    // Regression: mid-stream user input bug. ChatInput adds a user message to the
    // store while a turn is still streaming → that user msg becomes the new "last
    // message". Without explicit msgId routing, subsequent assistant tokens would
    // get appended into the user bubble.
    it('routes tokens by msgId so a mid-stream user message is not corrupted', () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, {
        id: 'user-1', role: 'user', content: 'first', timestamp: Date.now(),
      });
      store.addMessage(id, {
        id: 'assistant-1', role: 'assistant', content: 'Hello', timestamp: Date.now(), isStreaming: true,
      });
      // User sends another message mid-stream — now last message is user-2.
      store.addMessage(id, {
        id: 'user-2', role: 'user', content: 'second', timestamp: Date.now(),
      });
      // Streaming token should still land on assistant-1, not user-2.
      store.appendToLastMessage(id, ' World', 'assistant-1');
      flushTokenBuffer(id, 'assistant-1');
      const msgs = useChatStore.getState().conversations[id].messages;
      expect(msgs.find((m) => m.id === 'assistant-1')?.content).toBe('Hello World');
      expect(msgs.find((m) => m.id === 'user-2')?.content).toBe('second');
    });

    it('flushTokenBuffer drains the per-msgId buffer not the convId fallback', () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, {
        id: 'assistant-a', role: 'assistant', content: 'A', timestamp: Date.now(), isStreaming: true,
      });
      store.addMessage(id, {
        id: 'user-x', role: 'user', content: 'tail', timestamp: Date.now(),
      });
      store.appendToLastMessage(id, '+1', 'assistant-a');
      store.appendToLastMessage(id, '+2', 'assistant-a');
      flushTokenBuffer(id, 'assistant-a');
      const msgs = useChatStore.getState().conversations[id].messages;
      expect(msgs.find((m) => m.id === 'assistant-a')?.content).toBe('A+1+2');
      expect(msgs.find((m) => m.id === 'user-x')?.content).toBe('tail');
    });
  });

  // ── finishStreaming ──
  describe('finishStreaming', () => {
    it('sets isStreaming to false and resets agent status', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'assistant', content: 'Hi', timestamp: Date.now(), isStreaming: true,
      });
      useChatStore.getState().finishStreaming(id);
      const state = useChatStore.getState();
      expect(state.conversations[id].messages[0].isStreaming).toBe(false);
      expect(state.agentStatus).toBe('idle');
    });

    // Regression: without msgId, finishStreaming flipped isStreaming on whatever
    // happened to be the last message — so a mid-stream user message left the
    // original assistant placeholder stuck in "执行中..." forever.
    it('finishStreaming(msgId) flips the right message even when not last', () => {
      const id = useChatStore.getState().createConversation();
      const store = useChatStore.getState();
      store.addMessage(id, {
        id: 'assistant-1', role: 'assistant', content: 'partial', timestamp: Date.now(), isStreaming: true,
      });
      // Mid-stream user input becomes the new last message.
      store.addMessage(id, {
        id: 'user-2', role: 'user', content: 'follow-up', timestamp: Date.now(),
      });
      store.finishStreaming(id, 'assistant-1');
      const msgs = useChatStore.getState().conversations[id].messages;
      expect(msgs.find((m) => m.id === 'assistant-1')?.isStreaming).toBe(false);
      // user-2 should be untouched (it never had isStreaming, must stay falsy not true)
      expect(msgs.find((m) => m.id === 'user-2')?.isStreaming).toBeFalsy();
    });
  });

  // ── cancelStreaming ──
  describe('cancelStreaming persistence', () => {
    // Simulate just enough fs for conversationStorage.replaceMessageById:
    // the JSONL exists, holds the pre-stop row, and atomic_write_text
    // captures the rewrite. Asserting at the fs layer exercises the real
    // storage module (the store reaches it via a dynamic import that
    // module-level vi.mock cannot intercept).
    let written: string[];

    beforeEach(() => {
      written = [];
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockImplementation(async () =>
        JSON.stringify({ id: 'a1', role: 'assistant', content: '部分输出', timestamp: 1 }) + '\n');
      vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
        const a = args as { path?: string; content?: string } | undefined;
        if (cmd === 'atomic_write_text' && a?.path?.endsWith('messages.jsonl')) {
          written.push(a.content ?? '');
        }
        return undefined;
      });
    });

    afterEach(() => {
      vi.mocked(exists).mockReset();
      vi.mocked(readTextFile).mockReset();
      vi.mocked(invoke).mockReset();
    });

    it('persists the stop-marker mutation to disk so reload matches the live view', async () => {
      // Regression: cancelStreaming appended "*[已停止]*" and cancelled tool
      // calls in memory only — the JSONL row on disk kept the pre-stop
      // snapshot, so the same turn reloaded as a blank/stale bubble.
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '部分输出', timestamp: Date.now(), isStreaming: true,
      });

      useChatStore.getState().cancelStreaming(id);

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toContain('已停止');
      await vi.waitFor(() => {
        expect(written.some((c) => c.includes('已停止'))).toBe(true);
      });
    });

    it('flushes buffered stream tokens before appending the stop marker', async () => {
      // Regression (review): the stop button calls cancelStreaming directly,
      // BEFORE the aborted loop flushes the RAF token buffer — so buffered
      // text landed after the marker in memory and never reached disk.
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '前段', timestamp: Date.now(), isStreaming: true,
      });
      useChatStore.getState().appendToLastMessage(id, '后段', 'a1'); // sits in the RAF buffer

      useChatStore.getState().cancelStreaming(id);

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toBe('前段后段\n\n*[已停止]*');
      await vi.waitFor(() => {
        expect(written.some((c) => c.includes('后段') && c.includes('已停止'))).toBe(true);
      });
    });

    it('does not rewrite the message row when nothing was streaming', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'u1', role: 'user', content: 'hi', timestamp: Date.now(),
      });

      useChatStore.getState().cancelStreaming(id);

      await new Promise((r) => setTimeout(r, 30));
      expect(written.some((c) => c.includes('已停止'))).toBe(false);
    });

    it('skips the marker and writes nothing for an EMPTY streaming placeholder', async () => {
      // Regression: stopping before any output appended "*[已停止]*" to the
      // untouched placeholder — a marker-only bubble the agentLoop abort path
      // then had to hunt down. Empty content = pure isStreaming flip, no write.
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'a1', role: 'assistant', content: '', timestamp: Date.now(), isStreaming: true,
      });

      useChatStore.getState().cancelStreaming(id);

      const live = useChatStore.getState().conversations[id].messages[0];
      expect(live.content).toBe('');
      expect(live.isStreaming).toBe(false);
      await new Promise((r) => setTimeout(r, 30));
      expect(written.some((c) => c.includes('已停止'))).toBe(false);
    });
  });

  // ── editMessage ──
  describe('editMessage', () => {
    it('edits string content', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'old text', timestamp: Date.now(),
      });
      useChatStore.getState().editMessage(id, 'msg1', 'new text');
      expect(useChatStore.getState().conversations[id].messages[0].content).toBe('new text');
    });

    it('preserves non-text blocks in multimodal content', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          { type: 'text', text: 'old text' },
        ],
        timestamp: Date.now(),
      });
      useChatStore.getState().editMessage(id, 'msg1', 'new text');
      const content = useChatStore.getState().conversations[id].messages[0].content;
      expect(Array.isArray(content)).toBe(true);
      if (Array.isArray(content)) {
        expect(content[0].type).toBe('image');
        expect(content[1]).toEqual({ type: 'text', text: 'new text' });
      }
    });
  });

  // ── deleteMessage ──
  describe('deleteMessage', () => {
    it('removes a specific message', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, { id: 'msg1', role: 'user', content: 'a', timestamp: 1 });
      useChatStore.getState().addMessage(id, { id: 'msg2', role: 'assistant', content: 'b', timestamp: 2 });
      useChatStore.getState().deleteMessage(id, 'msg1');
      expect(useChatStore.getState().conversations[id].messages).toHaveLength(1);
      expect(useChatStore.getState().conversations[id].messages[0].id).toBe('msg2');
    });
  });

  // ── deleteMessagesFrom ──
  describe('deleteMessagesFrom', () => {
    it('deletes from a message onwards', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, { id: 'msg1', role: 'user', content: 'a', timestamp: 1 });
      useChatStore.getState().addMessage(id, { id: 'msg2', role: 'assistant', content: 'b', timestamp: 2 });
      useChatStore.getState().addMessage(id, { id: 'msg3', role: 'user', content: 'c', timestamp: 3 });
      useChatStore.getState().deleteMessagesFrom(id, 'msg2');
      expect(useChatStore.getState().conversations[id].messages).toHaveLength(1);
    });
  });

  // ── setAgentStatus ──
  describe('setAgentStatus', () => {
    it('sets thinking status with timestamp', () => {
      useChatStore.getState().setAgentStatus('thinking');
      const state = useChatStore.getState();
      expect(state.agentStatus).toBe('thinking');
      expect(state.thinkingStartTime).not.toBeNull();
    });

    it('clears thinking timestamp on idle', () => {
      useChatStore.getState().setAgentStatus('thinking');
      useChatStore.getState().setAgentStatus('idle');
      expect(useChatStore.getState().thinkingStartTime).toBeNull();
    });

    it('sets tool name', () => {
      useChatStore.getState().setAgentStatus('tool-calling', 'read_file');
      expect(useChatStore.getState().currentTool).toBe('read_file');
    });
  });

  // ── setConversationStatus ──
  describe('setConversationStatus', () => {
    it('sets status to completed with completedAt', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationStatus(id, 'completed');
      const conv = useChatStore.getState().conversations[id];
      expect(conv.status).toBe('completed');
      expect(conv.completedAt).toBeDefined();
    });

    it('clearCompletedStatus resets to idle', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationStatus(id, 'completed');
      useChatStore.getState().clearCompletedStatus(id);
      const conv = useChatStore.getState().conversations[id];
      expect(conv.status).toBe('idle');
      expect(conv.completedAt).toBeUndefined();
    });
  });

  // ── export/import ──
  describe('export/import', () => {
    it('exports conversation as JSON', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'Test', timestamp: Date.now(),
      });
      const json = useChatStore.getState().exportConversation(id);
      expect(json).not.toBeNull();
      const parsed = JSON.parse(json!);
      expect(parsed.messages).toHaveLength(1);
    });

    it('returns null for unknown conversation', () => {
      expect(useChatStore.getState().exportConversation('unknown')).toBeNull();
    });

    it('imports conversation with new ID', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'Imported', timestamp: Date.now(),
      });
      const json = useChatStore.getState().exportConversation(id)!;
      const newId = useChatStore.getState().importConversation(json);
      expect(newId).not.toBeNull();
      expect(newId).not.toBe(id);
      expect(useChatStore.getState().conversations[newId!].messages[0].content).toBe('Imported');
    });

    it('returns null for invalid JSON', () => {
      expect(useChatStore.getState().importConversation('not json')).toBeNull();
    });

    it('round-trips a conversation through exportConversationForShare + importConversation', async () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'Hello alice', timestamp: Date.now(),
      });
      useChatStore.getState().addMessage(id, {
        id: 'msg2', role: 'assistant', content: 'Hi bob!', timestamp: Date.now(),
      });
      const bundle = await useChatStore.getState().exportConversationForShare(id);
      expect(bundle).not.toBeNull();
      expect(bundle!.messages).toHaveLength(2);

      const { serializeShareBundle } = await import('@/core/session/shareBundle');
      const json = serializeShareBundle(bundle!);
      const newId = useChatStore.getState().importConversation(json);
      expect(newId).not.toBeNull();
      expect(newId).not.toBe(id);

      const imported = useChatStore.getState().conversations[newId!];
      expect(imported.importedFrom?.schemaVersion).toBe(1);
      expect(imported.messages).toHaveLength(2);
      expect(imported.messages[0].content).toBe('Hello alice');
      expect(imported.messages[1].content).toBe('Hi bob!');
    });

    it('legacy raw-conversation JSON (undo-delete) is NOT treated as a share bundle', () => {
      // Regression guard: the importConversation dispatcher must route
      // raw conversation JSON to the legacy path (no importedFrom stamp).
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(id, {
        id: 'msg1', role: 'user', content: 'undo me', timestamp: Date.now(),
      });
      const json = useChatStore.getState().exportConversation(id)!;
      const newId = useChatStore.getState().importConversation(json)!;
      const restored = useChatStore.getState().conversations[newId];
      expect(restored.importedFrom).toBeUndefined();
    });

    describe('importConversation · share bundle path', () => {
      // Minimal share bundle fixture that satisfies the v1 schema check.
      // Anything inside bundle.conversation that isn't id/title/createdAt/
      // updatedAt must be ignored — external refs are intentionally not
      // carried by the bundle shape.
      const makeBundle = () => ({
        schema: { abuShareVersion: 1, tier: 'standard', exportedAt: Date.now() },
        conversation: {
          id: 'original-conv-id',
          title: 'Shared from Alice',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_100_000,
        },
        messages: [
          { id: 'msg1', role: 'user', content: 'Hi', timestamp: 1_700_000_000_100 },
          { id: 'msg2', role: 'assistant', content: 'Hello back', timestamp: 1_700_000_000_200 },
        ],
        attachments: {},
        stats: { redactionCount: 0, attachmentCount: 0, embeddedCount: 0, sizeBytes: 0 },
      });

      it('creates a conversation with a fresh ID and the bundle messages', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json);
        expect(newId).not.toBeNull();
        expect(newId).not.toBe('original-conv-id');
        const conv = useChatStore.getState().conversations[newId!];
        expect(conv.messages).toHaveLength(2);
        expect(conv.messages[0].content).toBe('Hi');
      });

      it('stamps importedFrom with the source schema version so the UI can show a badge', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json)!;
        const conv = useChatStore.getState().conversations[newId];
        expect(conv.importedFrom?.schemaVersion).toBe(1);
        expect(conv.importedFrom?.importedAt).toBeGreaterThan(0);
      });

      it('mirrors importedFrom into the index meta so the badge survives restart', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json)!;
        const meta = useChatStore.getState().conversationIndex[newId];
        expect(meta.importedFrom?.schemaVersion).toBe(1);
        expect(meta.importedFrom?.importedAt).toBeGreaterThan(0);
      });

      it('does not set readOnly — imported conversations remain continuable', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json)!;
        const conv = useChatStore.getState().conversations[newId];
        const meta = useChatStore.getState().conversationIndex[newId];
        expect(conv.readOnly).toBeUndefined();
        expect(meta.readOnly).toBeUndefined();
      });

      it('strips external references even if a misbehaving exporter inlines them', () => {
        const bundle = makeBundle() as Record<string, unknown>;
        // Simulate a broken exporter that leaked refs into the bundle root.
        bundle.scheduledTaskId = 'task-999';
        bundle.triggerId = 'trig-999';
        bundle.projectId = 'proj-999';
        bundle.imChannelId = 'chan-999';
        bundle.workspacePath = '/Users/stranger/private';
        bundle.activeSkills = ['leak-skill'];
        bundle.enabledMCPServers = ['leak-mcp'];

        const json = JSON.stringify(bundle);
        const newId = useChatStore.getState().importConversation(json)!;
        const conv = useChatStore.getState().conversations[newId];
        expect(conv.scheduledTaskId).toBeUndefined();
        expect(conv.triggerId).toBeUndefined();
        expect(conv.projectId).toBeUndefined();
        expect(conv.imChannelId).toBeUndefined();
        expect(conv.workspacePath).toBeUndefined();
        expect(conv.activeSkills).toBeUndefined();
        expect(conv.enabledMCPServers).toBeUndefined();
      });

      it('clears the workspace so the read-only dialogue is not bound to one', () => {
        mockClearWorkspace.mockClear();
        const json = JSON.stringify(makeBundle());
        useChatStore.getState().importConversation(json);
        expect(mockClearWorkspace).toHaveBeenCalled();
      });

      it('rejects a bundle without a messages array', () => {
        const bundle = makeBundle() as Record<string, unknown>;
        delete bundle.messages;
        expect(useChatStore.getState().importConversation(JSON.stringify(bundle))).toBeNull();
      });

      // Regression: the user-reported bundle (3 msgs, assistant with empty
      // content + tool_use followed by assistant text) landed in a welcome
      // page because messages somehow didn't reach the in-memory store.
      // This test reproduces that exact shape to pin the data contract down.
      it('imports real-world shape: user + assistant(content="", toolCall) + assistant(text)', () => {
        const bundle = {
          schema: { abuShareVersion: 1, tier: 'standard', exportedAt: Date.now() },
          conversation: {
            id: 'mo5tgdm8mg7l1b',
            title: '看看当前文件夹下有什么',
            createdAt: 1_776_606_190_064,
            updatedAt: 1_776_609_764_691,
          },
          messages: [
            {
              id: 'mo5tgdqxo6ew0f',
              role: 'user',
              content: '看看当前文件夹下有什么',
              timestamp: 1_776_606_190_233,
              loopId: 'mo5tgdmcrrijsc',
              isStreaming: false,
            },
            {
              id: 'mo5tgdrn099n93',
              role: 'assistant',
              content: '',
              timestamp: 1_776_606_190_259,
              isStreaming: false,
              toolCalls: [
                {
                  id: 'toolu_bdrk_014nci2UKBs6zEoXDKP4mvGg',
                  name: 'list_directory',
                  input: { path: '~/Desktop/表格' },
                  isExecuting: false,
                  startTime: 1_776_606_195_248,
                  result: '[FILE] a.xlsx\n[FILE] b.csv',
                },
              ],
              loopId: 'mo5tgdmcrrijsc',
              usage: { inputTokens: 1396, outputTokens: 63 },
              toolCallsForContext: [
                {
                  name: 'list_directory',
                  input: { path: '~/Desktop/表格' },
                  result: '[FILE] a.xlsx\n[FILE] b.csv',
                },
              ],
            },
            {
              id: 'mo5tghnrfxknty',
              role: 'assistant',
              content: '当前「表格」文件夹下有 4 个文件：...',
              timestamp: 1_776_606_195_303,
              isStreaming: false,
              toolCalls: [],
              loopId: 'mo5tgdmcrrijsc',
              usage: { inputTokens: 1539, outputTokens: 195 },
            },
          ],
          attachments: {},
          stats: { redactionCount: 2, attachmentCount: 0, embeddedCount: 0, sizeBytes: 1601 },
        };
        const newId = useChatStore.getState().importConversation(JSON.stringify(bundle));
        expect(newId).not.toBeNull();
        const conv = useChatStore.getState().conversations[newId!];
        expect(conv, 'imported conv should be in the in-memory store').toBeDefined();
        expect(conv.messages).toHaveLength(3);
        expect(conv.messages[0].content).toBe('看看当前文件夹下有什么');
        expect(conv.messages[1].content).toBe('');
        expect(conv.messages[1].toolCalls).toHaveLength(1);
        expect(useChatStore.getState().activeConversationId).toBe(newId);
      });
    });
  });

  // ── setPendingInput ──
  describe('setPendingInput', () => {
    it('sets and clears pending input', () => {
      useChatStore.getState().setPendingInput('test input');
      expect(useChatStore.getState().pendingInput).toBe('test input');
      useChatStore.getState().setPendingInput(null);
      expect(useChatStore.getState().pendingInput).toBeNull();
    });
  });

  // ── updateToolCall · notice_card extraction ──
  // Integration seam: skillManageTool emits notice_card inside its JSON
  // result string; chatStore must lift it onto tc.noticeCard so
  // SkillProposalCard can pick it up. Between these two layers sits a
  // JSON.parse + key lookup that nothing else in the suite covers.
  describe('updateToolCall · notice_card extraction (Task #39 / #41 seam)', () => {
    function seedToolCall() {
      const convId = useChatStore.getState().createConversation();
      useChatStore.getState().addMessage(convId, {
        id: 'msg-1',
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: [
          {
            id: 'tc-1',
            name: 'skill_manage',
            input: {},
            isExecuting: true,
          },
        ],
      });
      return convId;
    }

    function getToolCall(convId: string) {
      return useChatStore.getState().conversations[convId]?.messages[0]?.toolCalls?.[0];
    }

    it('lifts a skill-proposal notice_card from JSON result onto the tool call', () => {
      const convId = seedToolCall();
      const result = JSON.stringify({
        success: true,
        notice_card: {
          type: 'skill-proposal',
          id: 'weekly-digest',
          skillProposal: {
            skillName: 'weekly-digest',
            description: 'x',
            draftPath: '/drafts/weekly-digest/SKILL.md',
            fullContent: '# body',
            workspacePath: '/ws',
          },
        },
      });

      useChatStore.getState().updateToolCall(convId, 'msg-1', 'tc-1', result);

      const tc = getToolCall(convId);
      expect(tc?.noticeCard?.type).toBe('skill-proposal');
      expect(tc?.noticeCard?.id).toBe('weekly-digest');
      expect(tc?.noticeCard?.skillProposal?.skillName).toBe('weekly-digest');
    });

    it('lifts a skill-patched notice_card (Task #41 card type)', () => {
      const convId = seedToolCall();
      const result = JSON.stringify({
        success: true,
        status: 'applied',
        notice_card: {
          type: 'skill-patched',
          id: 'weekly-digest@1700000000000',
          skillPatched: {
            skillName: 'weekly-digest',
            filePath: '/ws/skills/weekly-digest/SKILL.md',
            summary: 'replace step 3 with fuzzy-match',
            workspacePath: '/ws',
          },
        },
      });

      useChatStore.getState().updateToolCall(convId, 'msg-1', 'tc-1', result);

      const tc = getToolCall(convId);
      expect(tc?.noticeCard?.type).toBe('skill-patched');
      expect(tc?.noticeCard?.skillPatched?.summary).toBe('replace step 3 with fuzzy-match');
    });

    it('leaves noticeCard unset when the result has no notice_card field', () => {
      const convId = seedToolCall();
      useChatStore.getState().updateToolCall(
        convId,
        'msg-1',
        'tc-1',
        JSON.stringify({ success: true, message: 'plain result' }),
      );
      expect(getToolCall(convId)?.noticeCard).toBeUndefined();
    });

    it('swallows non-JSON results without crashing (best-effort guarantee)', () => {
      const convId = seedToolCall();
      // Regression: some tools return plain strings (bash stdout etc.).
      // The silent catch in updateToolCall must not throw — the result
      // still needs to land, just without a card.
      expect(() =>
        useChatStore.getState().updateToolCall(convId, 'msg-1', 'tc-1', 'not json at all'),
      ).not.toThrow();
      const tc = getToolCall(convId);
      expect(tc?.result).toBe('not json at all');
      expect(tc?.noticeCard).toBeUndefined();
    });
  });

  describe('context indicator ephemeral state', () => {
    beforeEach(() => {
      const conv: Conversation = {
        id: 'c1',
        title: 't',
        messages: [],
        createdAt: 0,
        updatedAt: 0,
        status: 'idle',
      };
      useChatStore.setState({ conversations: { c1: conv } });
    });

    it('setContextUsage writes and clears usage on the conversation', () => {
      useChatStore.getState().setContextUsage('c1', { percent: 73, tokensUsed: 1400, tokensMax: 2000 });
      expect(useChatStore.getState().conversations.c1.contextUsage).toEqual({ percent: 73, tokensUsed: 1400, tokensMax: 2000 });

      useChatStore.getState().setContextUsage('c1', undefined);
      expect(useChatStore.getState().conversations.c1.contextUsage).toBeUndefined();
    });

    it('setIsCompressing toggles isCompressing on the conversation', () => {
      useChatStore.getState().setIsCompressing('c1', true);
      expect(useChatStore.getState().conversations.c1.isCompressing).toBe(true);

      useChatStore.getState().setIsCompressing('c1', false);
      expect(useChatStore.getState().conversations.c1.isCompressing).toBe(false);
    });

    it('actions are no-ops for unknown conversation id', () => {
      useChatStore.getState().setContextUsage('nope', { percent: 50, tokensUsed: 1, tokensMax: 2 });
      useChatStore.getState().setIsCompressing('nope', true);
      // Should not throw, should not create a new conversation entry
      expect(useChatStore.getState().conversations.nope).toBeUndefined();
    });
  });

  // ── setToolCallUserQuestionAnswers ──
  describe('setToolCallUserQuestionAnswers', () => {
    it('writes tc.userQuestionAnswers and reads it back', () => {
      const convId = useChatStore.getState().createConversation();
      const msgId = 'msg-1';
      const tcId = 'tc-1';

      useChatStore.setState((state) => {
        const conv = state.conversations[convId];
        if (conv) {
          conv.messages.push({
            id: msgId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            toolCalls: [{ id: tcId, name: 'ask_user_question', input: {} }],
          });
        }
      });

      const answers = {
        answers: [{ header: '格式', question: '什么格式？', selected: ['详细'] }],
      };

      useChatStore.getState().setToolCallUserQuestionAnswers(convId, msgId, tcId, answers);

      const tc = useChatStore
        .getState()
        .conversations[convId]?.messages.find((m) => m.id === msgId)
        ?.toolCalls?.find((t) => t.id === tcId);

      expect(tc?.userQuestionAnswers).toEqual(answers);
    });

    it('does not throw when the tool call does not exist', () => {
      const convId = useChatStore.getState().createConversation();
      expect(() => {
        useChatStore.getState().setToolCallUserQuestionAnswers(
          convId, 'nonexistent-msg', 'nonexistent-tc',
          { answers: [{ header: 'x', question: 'q', selected: ['a'] }] },
        );
      }).not.toThrow();
    });
  });

  // ── setConversationPermissionMode ──
  describe('setConversationPermissionMode', () => {
    it('sets permissionMode on a conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationPermissionMode(id, 'autonomous');
      const conv = useChatStore.getState().conversations[id];
      expect(conv?.permissionMode).toBe('autonomous');
    });

    it('clears permissionMode when set to undefined', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationPermissionMode(id, 'smart');
      useChatStore.getState().setConversationPermissionMode(id, undefined);
      const conv = useChatStore.getState().conversations[id];
      expect(conv?.permissionMode).toBeUndefined();
    });

    it('does nothing for non-existent conversation', () => {
      expect(() =>
        useChatStore.getState().setConversationPermissionMode('nonexistent', 'autonomous')
      ).not.toThrow();
    });
  });

  // ── v6→v7 migration compat: compactBoundary marker payload on Message ──
  describe('v6→v7 migration: loadConversation still works for index entries without compactBoundary', () => {
    // The loadConversation function uses a dynamic import of conversationStorage.
    // The global mock for @tauri-apps/plugin-fs has exists() → false, so
    // loadMessages returns [] — which is fine; we only verify the load succeeds.

    it('loadConversation: v6 index entry (no boundary fields) loads successfully', async () => {
      useChatStore.setState({
        conversations: {},
        conversationIndex: {
          'old-conv': {
            id: 'old-conv',
            title: 'Old conversation',
            createdAt: 1000,
            updatedAt: 2000,
            messageCount: 2,
            // No compactBoundary — represents v6 data; backward compatible no-op migration
          },
        },
        activeConversationId: null,
        agentStatus: 'idle',
        currentTool: null,
        currentUsage: null,
        pendingInput: null,
        thinkingStartTime: null,
      });

      await useChatStore.getState().loadConversation('old-conv');

      const conv = useChatStore.getState().conversations['old-conv'];
      expect(conv).toBeDefined();
      expect(conv.title).toBe('Old conversation');
      // compactBoundary is now a Message field, not a Conversation field —
      // the index entry has no such field and the conversation loads cleanly.
    });
  });

});
