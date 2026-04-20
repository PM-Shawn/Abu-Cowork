import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, flushTokenBuffer } from './chatStore';

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

      it('creates a read-only conversation with a fresh ID', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json);
        expect(newId).not.toBeNull();
        expect(newId).not.toBe('original-conv-id');
        const conv = useChatStore.getState().conversations[newId!];
        expect(conv.readOnly).toBe(true);
        expect(conv.messages).toHaveLength(2);
        expect(conv.messages[0].content).toBe('Hi');
      });

      it('stamps importedFrom with the source schema version', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json)!;
        const conv = useChatStore.getState().conversations[newId];
        expect(conv.importedFrom?.schemaVersion).toBe(1);
        expect(conv.importedFrom?.importedAt).toBeGreaterThan(0);
      });

      it('mirrors readOnly + importedFrom into the index meta so they survive restart', () => {
        const json = JSON.stringify(makeBundle());
        const newId = useChatStore.getState().importConversation(json)!;
        const meta = useChatStore.getState().conversationIndex[newId];
        expect(meta.readOnly).toBe(true);
        expect(meta.importedFrom?.schemaVersion).toBe(1);
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
});
