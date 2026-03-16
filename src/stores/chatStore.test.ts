import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, flushTokenBuffer } from './chatStore';

// Mock workspaceStore to avoid cross-store side effects
vi.mock('./workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      setWorkspace: vi.fn(),
      clearWorkspace: vi.fn(),
    }),
  },
}));

describe('chatStore', () => {
  beforeEach(() => {
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
      expect(state.conversations[id].title).toBe('新对话');
      expect(state.activeConversationId).toBe(id);
    });

    it('creates conversation with workspace path', () => {
      const id = useChatStore.getState().createConversation('/Users/test/project');
      expect(useChatStore.getState().conversations[id].workspacePath).toBe('/Users/test/project');
    });
  });

  // ── startNewConversation ──
  describe('startNewConversation', () => {
    it('sets activeConversationId to null', () => {
      useChatStore.getState().createConversation();
      useChatStore.getState().startNewConversation();
      expect(useChatStore.getState().activeConversationId).toBeNull();
    });
  });

  // ── switchConversation ──
  describe('switchConversation', () => {
    it('switches active conversation', () => {
      const id1 = useChatStore.getState().createConversation();
      useChatStore.getState().createConversation();
      useChatStore.getState().switchConversation(id1);
      expect(useChatStore.getState().activeConversationId).toBe(id1);
    });
  });

  // ── deleteConversation ──
  describe('deleteConversation', () => {
    it('deletes a conversation', () => {
      const id = useChatStore.getState().createConversation();
      useChatStore.getState().deleteConversation(id);
      expect(useChatStore.getState().conversations[id]).toBeUndefined();
    });

    it('switches to another conversation when active is deleted', () => {
      const id1 = useChatStore.getState().createConversation();
      const id2 = useChatStore.getState().createConversation();
      useChatStore.getState().switchConversation(id2);
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
});
