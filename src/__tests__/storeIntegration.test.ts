/**
 * Store Integration Tests — cross-store state consistency
 *
 * Validates that chatStore, taskExecutionStore, and related stores
 * maintain consistent state during common workflows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../stores/chatStore';
import { useTaskExecutionStore } from '../stores/taskExecutionStore';

// Mock workspaceStore
vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      setWorkspace: vi.fn(),
      clearWorkspace: vi.fn(),
    }),
    subscribe: vi.fn(),
  },
}));

// Filler timestamp (TESTING.md §3) — not asserted on below.
const FIXED_TIMESTAMP = 1_700_000_000_000;

describe('Store Integration', () => {
  beforeEach(() => {
    useChatStore.setState({
      conversations: {},
      activeConversationId: null,
      currentUsage: null,
      pendingInput: null,
      agentStates: new Map(),
    });
    useTaskExecutionStore.setState({
      executions: {},
    });
  });

  // ── Conversation + Execution lifecycle ──
  describe('conversation + execution lifecycle', () => {
    it('creates execution linked to conversation', () => {
      const convId = useChatStore.getState().createConversation();
      const loopId = 'loop-1';
      const exec = useTaskExecutionStore.getState().createExecution(convId, loopId);

      expect(exec.conversationId).toBe(convId);
      expect(exec.loopId).toBe(loopId);
      expect(exec.status).toBe('running');
    });

    it('adds messages to conversation while execution runs', () => {
      const convId = useChatStore.getState().createConversation();
      const loopId = 'loop-1';
      useTaskExecutionStore.getState().createExecution(convId, loopId);

      // Add user message
      useChatStore.getState().addMessage(convId, {
        id: 'msg-1',
        role: 'user',
        content: 'Hello',
        timestamp: FIXED_TIMESTAMP,
        loopId,
      });

      // Add assistant message
      useChatStore.getState().addMessage(convId, {
        id: 'msg-2',
        role: 'assistant',
        content: 'Hi there!',
        timestamp: FIXED_TIMESTAMP,
        loopId,
      });

      const conv = useChatStore.getState().conversations[convId];
      expect(conv.messages).toHaveLength(2);
      expect(conv.messages[0].role).toBe('user');
      expect(conv.messages[1].role).toBe('assistant');
    });

    it('adds execution steps during tool use', () => {
      const convId = useChatStore.getState().createConversation();
      const loopId = 'loop-1';
      const exec = useTaskExecutionStore.getState().createExecution(convId, loopId);

      // Add a step (simulating tool execution)
      useTaskExecutionStore.getState().addStep(exec.id, {
        id: 'step-1',
        type: 'tool',
        toolName: 'read_file',
        toolInput: { path: '/test.txt' },
        status: 'running',
        startedAt: FIXED_TIMESTAMP,
      });

      const updatedExec = useTaskExecutionStore.getState().executions[exec.id];
      expect(updatedExec.steps).toHaveLength(1);
      expect(updatedExec.steps[0].toolName).toBe('read_file');
    });

    it('completes execution and updates status', () => {
      const convId = useChatStore.getState().createConversation();
      const loopId = 'loop-1';
      const exec = useTaskExecutionStore.getState().createExecution(convId, loopId);

      useTaskExecutionStore.getState().completeExecution(exec.id);

      const updated = useTaskExecutionStore.getState().executions[exec.id];
      expect(updated.status).toBe('completed');
    });

    it('cancels execution cleans up properly', () => {
      const convId = useChatStore.getState().createConversation();
      const loopId = 'loop-1';
      const exec = useTaskExecutionStore.getState().createExecution(convId, loopId);

      useTaskExecutionStore.getState().cancelExecution(exec.id);

      const updated = useTaskExecutionStore.getState().executions[exec.id];
      expect(updated.status).toBe('cancelled');
    });
  });

  // ── Conversation deletion cleans up ──
  describe('conversation deletion', () => {
    it('deleting conversation does not crash with linked executions', () => {
      const convId = useChatStore.getState().createConversation();
      const loopId = 'loop-1';
      useTaskExecutionStore.getState().createExecution(convId, loopId);

      // Delete conversation — execution store should not throw
      useChatStore.getState().deleteConversation(convId);
      expect(useChatStore.getState().conversations[convId]).toBeUndefined();
    });
  });

  // ── Abort controller lifecycle ──
  describe('abort controller', () => {
    it('getAbortController creates controller for conversation', () => {
      const convId = useChatStore.getState().createConversation();
      const controller = useChatStore.getState().getAbortController(convId);
      expect(controller).toBeDefined();
      expect(controller.signal.aborted).toBe(false);
    });

    it('clearAbortController aborts and cleans up', () => {
      const convId = useChatStore.getState().createConversation();
      const controller = useChatStore.getState().getAbortController(convId);
      useChatStore.getState().clearAbortController(convId);
      // Getting a new controller should produce a fresh one
      const newController = useChatStore.getState().getAbortController(convId);
      expect(newController).not.toBe(controller);
      expect(newController.signal.aborted).toBe(false);
    });
  });

  // ── Conversation status transitions ──
  describe('conversation status', () => {
    it('tracks status transitions: idle → running → completed', () => {
      const convId = useChatStore.getState().createConversation();

      useChatStore.getState().setConversationStatus(convId, 'running');
      expect(useChatStore.getState().conversations[convId].status).toBe('running');

      useChatStore.getState().setConversationStatus(convId, 'completed');
      expect(useChatStore.getState().conversations[convId].status).toBe('completed');
    });

    it('tracks error status', () => {
      const convId = useChatStore.getState().createConversation();
      useChatStore.getState().setConversationStatus(convId, 'error');
      expect(useChatStore.getState().conversations[convId].status).toBe('error');
    });
  });

  // ── Multi-conversation isolation ──
  describe('multi-conversation isolation', () => {
    it('messages in one conversation do not affect another', () => {
      const conv1 = useChatStore.getState().createConversation();
      const conv2 = useChatStore.getState().createConversation();

      useChatStore.getState().addMessage(conv1, {
        id: 'msg-1',
        role: 'user',
        content: 'Hello conv1',
        timestamp: FIXED_TIMESTAMP,
      });

      useChatStore.getState().addMessage(conv2, {
        id: 'msg-2',
        role: 'user',
        content: 'Hello conv2',
        timestamp: FIXED_TIMESTAMP,
      });

      expect(useChatStore.getState().conversations[conv1].messages).toHaveLength(1);
      expect(useChatStore.getState().conversations[conv2].messages).toHaveLength(1);
      expect(useChatStore.getState().conversations[conv1].messages[0].content).toBe('Hello conv1');
    });

    it('executions are scoped to their conversation', () => {
      const conv1 = useChatStore.getState().createConversation();
      const conv2 = useChatStore.getState().createConversation();

      const exec1 = useTaskExecutionStore.getState().createExecution(conv1, 'loop-1');
      const exec2 = useTaskExecutionStore.getState().createExecution(conv2, 'loop-2');

      expect(exec1.conversationId).toBe(conv1);
      expect(exec2.conversationId).toBe(conv2);
      expect(exec1.id).not.toBe(exec2.id);
    });
  });

  // ── Agent status transitions ──
  describe('agent status', () => {
    it('tracks agent status per conversation', () => {
      const convId = useChatStore.getState().createConversation();

      expect(useChatStore.getState().agentStates.has(convId)).toBe(false);

      useChatStore.getState().setAgentStatus(convId, 'thinking');
      expect(useChatStore.getState().agentStates.get(convId)?.status).toBe('thinking');

      useChatStore.getState().setAgentStatus(convId, 'tool-calling', 'read_file');
      expect(useChatStore.getState().agentStates.get(convId)).toMatchObject({
        status: 'tool-calling',
        currentTool: 'read_file',
      });

      useChatStore.getState().setAgentStatus(convId, 'idle');
      expect(useChatStore.getState().agentStates.has(convId)).toBe(false);
    });
  });
});
