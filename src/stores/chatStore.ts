import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { Message, Conversation, AgentStatus, TokenUsage, ConversationStatus, ToolCallForContext, ToolResultContent } from '../types';
import type { ExecutionStepSnapshot } from '../types/execution';
import { useWorkspaceStore } from './workspaceStore';
import { useTaskExecutionStore } from './taskExecutionStore';
import { clearTodos } from '../core/agent/todoManager';
import { clearInputQueue } from '../core/agent/userInputQueue';
import { clearAllSkillHooks } from '../core/tools/builtins';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// Store abort controllers for each conversation
const abortControllers: Map<string, AbortController> = new Map();

// Persistence limits
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;
const KEEP_FIRST_MESSAGES = 5;

/**
 * Strip large base64 image data from resultContent before persisting to localStorage.
 * Screenshots are saved to disk; we replace base64 data with a placeholder to avoid
 * exceeding the ~5MB localStorage quota.
 */
function stripImageDataForPersist(conversations: Record<string, Conversation>): Record<string, Conversation> {
  const result: Record<string, Conversation> = {};
  for (const [id, conv] of Object.entries(conversations)) {
    const messages = conv.messages.map((msg) => {
      const hasToolImages = msg.toolCalls?.some((tc) => tc.resultContent?.some((b) => b.type === 'image'));
      const hasContextImages = msg.toolCallsForContext?.some((tc) => tc.resultContent?.some((b) => b.type === 'image'));
      const hasContentImages = Array.isArray(msg.content) && msg.content.some((b) => b.type === 'image');
      if (!hasToolImages && !hasContentImages && !hasContextImages) return msg;

      const strippedMsg = { ...msg };

      // Strip images from user message content (e.g. pasted screenshots)
      if (hasContentImages && Array.isArray(msg.content)) {
        strippedMsg.content = msg.content.map((block) =>
          block.type === 'image'
            ? { type: 'text' as const, text: '[image]' }
            : block
        );
      }

      // Strip images from tool result content
      if (hasToolImages) {
        strippedMsg.toolCalls = msg.toolCalls!.map((tc) => {
          if (!tc.resultContent?.some((b) => b.type === 'image')) return tc;
          return {
            ...tc,
            resultContent: tc.resultContent!.map((block) =>
              block.type === 'image'
                ? { type: 'text' as const, text: '[screenshot saved to disk]' }
                : block
            ),
          };
        });
      }

      // Strip images from toolCallsForContext too
      if (hasContextImages) {
        strippedMsg.toolCallsForContext = msg.toolCallsForContext!.map((tc) => {
          if (!tc.resultContent?.some((b) => b.type === 'image')) return tc;
          return {
            ...tc,
            resultContent: tc.resultContent!.map((block) =>
              block.type === 'image'
                ? { type: 'text' as const, text: '[screenshot saved to disk]' }
                : block
            ),
          };
        });
      }

      return strippedMsg;
    });
    result[id] = { ...conv, messages };
  }
  return result;
}

interface ChatState {
  conversations: Record<string, Conversation>;
  activeConversationId: string | null;
  agentStatus: AgentStatus;
  currentTool: string | null;
  // Token usage tracking
  currentUsage: TokenUsage | null;
  // Pending input for prefilling the chat input
  pendingInput: string | null;
  // Thinking timer
  thinkingStartTime: number | null;
  // Track multiple concurrent active agents
  activeAgentNames: string[];
}

interface ChatActions {
  createConversation: (workspacePath?: string | null, options?: { scheduledTaskId?: string; triggerId?: string; imChannelId?: string; imPlatform?: string; skipActivate?: boolean }) => string;
  startNewConversation: () => void;
  switchConversation: (id: string) => void;
  setConversationWorkspace: (convId: string, path: string | null) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;

  addMessage: (convId: string, message: Message) => void;
  appendToLastMessage: (convId: string, token: string) => void;
  setLastMessageContent: (convId: string, content: string) => void;
  finishStreaming: (convId: string) => void;
  updateToolCall: (convId: string, messageId: string, toolCallId: string, result: string, resultContent?: ToolResultContent[], isError?: boolean, hideScreenshot?: boolean) => void;

  // New message operations
  editMessage: (convId: string, messageId: string, newContent: string) => void;
  deleteMessage: (convId: string, messageId: string) => void;
  deleteMessagesFrom: (convId: string, messageId: string) => void;
  deleteLoopMessages: (convId: string, loopId: string) => void;
  updateMessageThinking: (convId: string, thinking: string) => void;
  updateMessageThinkingDuration: (convId: string, duration: number) => void;
  updateMessageUsage: (convId: string, usage: TokenUsage) => void;
  appendToolCallContext: (convId: string, loopId: string, context: ToolCallForContext) => void;
  setExecutionStepsSnapshot: (convId: string, loopId: string, steps: ExecutionStepSnapshot[]) => void;

  // Streaming control
  getAbortController: (convId: string) => AbortController;
  cancelStreaming: (convId: string) => void;
  clearAbortController: (convId: string) => void;

  setAgentStatus: (status: AgentStatus, tool?: string, agentName?: string) => void;
  removeActiveAgent: (agentName: string) => void;
  setCurrentUsage: (usage: TokenUsage | null) => void;
  setPendingInput: (text: string | null) => void;
  setConversationStatus: (convId: string, status: ConversationStatus) => void;
  clearCompletedStatus: (convId: string) => void;

  // MCP per-session toggle
  toggleMCPServer: (convId: string, serverName: string) => void;

  // Context compression cache
  setContextCache: (convId: string, cache: import('../types').ContextCache) => void;
  clearContextCache: (convId: string) => void;

  // Export/Import
  exportConversation: (convId: string) => string | null;
  importConversation: (json: string) => string | null;
}

export type ChatStore = ChatState & ChatActions;

export const useChatStore = create<ChatStore>()(
  persist(
    immer((set, get) => ({
      conversations: {},
      activeConversationId: null,
      agentStatus: 'idle' as AgentStatus,
      currentTool: null,
      currentUsage: null,
      pendingInput: null,
      thinkingStartTime: null,
      activeAgentNames: [],

      createConversation: (workspacePath, options) => {
        const id = generateId();
        const now = Date.now();
        set((state) => {
          state.conversations[id] = {
            id,
            title: '新对话',
            messages: [],
            createdAt: now,
            updatedAt: now,
            status: 'idle',
            workspacePath: workspacePath ?? null,
            ...(options?.scheduledTaskId ? { scheduledTaskId: options.scheduledTaskId } : {}),
            ...(options?.triggerId ? { triggerId: options.triggerId } : {}),
            ...(options?.imChannelId ? { imChannelId: options.imChannelId, imPlatform: options.imPlatform } : {}),
          };
          if (!options?.skipActivate) {
            state.activeConversationId = id;
          }
        });
        // Sync global workspace to match the new conversation
        if (workspacePath && !options?.skipActivate) {
          useWorkspaceStore.getState().setWorkspace(workspacePath);
        }
        return id;
      },

      startNewConversation: () => {
        set((state) => {
          state.activeConversationId = null;
        });
        // Clear global workspace so welcome page starts clean
        useWorkspaceStore.getState().clearWorkspace();
      },

      switchConversation: (id) => {
        const conv = get().conversations[id];
        set((state) => {
          state.activeConversationId = id;
        });
        // Sync global workspace to match the target conversation
        const ws = useWorkspaceStore.getState();
        if (conv?.workspacePath) {
          ws.setWorkspace(conv.workspacePath);
        } else {
          ws.clearWorkspace();
        }
      },

      setConversationWorkspace: (convId, path) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.workspacePath = path;
          }
        });
      },

      deleteConversation: (id) => {
        // Cancel any ongoing streaming for this conversation
        const controller = abortControllers.get(id);
        if (controller) {
          controller.abort();
          abortControllers.delete(id);
        }
        // Clean up per-conversation state in external modules
        clearTodos(id);
        clearInputQueue(id);
        clearAllSkillHooks();
        useTaskExecutionStore.getState().clearConversation(id);
        // Clean up IM session pointing to this conversation (lazy import to avoid circular deps)
        import('./imChannelStore').then(({ useIMChannelStore }) => {
          const imStore = useIMChannelStore.getState();
          for (const [key, session] of Object.entries(imStore.sessions)) {
            if (session.conversationId === id) {
              imStore.removeSession(key);
            }
          }
        }).catch(() => {});
        const wasActive = get().activeConversationId === id;
        set((state) => {
          delete state.conversations[id];
          if (state.activeConversationId === id) {
            // Only pick non-automated conversations as the next active one
            const ids = Object.keys(state.conversations)
              .filter((cid) => !state.conversations[cid]?.scheduledTaskId && !state.conversations[cid]?.triggerId);
            state.activeConversationId = ids.length > 0 ? ids[ids.length - 1] : null;
          }
        });
        // Sync workspace to the newly active conversation
        if (wasActive) {
          const { activeConversationId, conversations } = get();
          const ws = useWorkspaceStore.getState();
          const nextConv = activeConversationId ? conversations[activeConversationId] : null;
          if (nextConv?.workspacePath) {
            ws.setWorkspace(nextConv.workspacePath);
          } else {
            ws.clearWorkspace();
          }
        }
      },

      renameConversation: (id, title) => {
        set((state) => {
          if (state.conversations[id]) {
            state.conversations[id].title = title;
          }
        });
      },

      addMessage: (convId, message) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.messages.push(message);
            conv.updatedAt = Date.now();
            // Auto-title from first user message
            if (conv.title === '新对话' && message.role === 'user') {
              let content = typeof message.content === 'string'
                ? message.content
                : message.content.find(c => c.type === 'text')?.text || '';
              // Strip [Attachment: `path`] patterns from title
              content = content.replace(/\[Attachment:\s*`[^`]*`\]\s*/g, '').trim();
              if (content) {
                conv.title = content.slice(0, 30) + (content.length > 30 ? '...' : '');
              }
            }
          }
        });
      },

      appendToLastMessage: (convId, token) => {
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            const lastMsg = messages[messages.length - 1];
            if (typeof lastMsg.content === 'string') {
              lastMsg.content += token;
            }
          }
        });
      },

      setLastMessageContent: (convId, content) => {
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            const lastMsg = messages[messages.length - 1];
            lastMsg.content = content;
          }
        });
      },

      finishStreaming: (convId) => {
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            messages[messages.length - 1].isStreaming = false;
          }
          state.agentStatus = 'idle';
          state.currentTool = null;
        });
      },

      updateToolCall: (convId, messageId, toolCallId, result, resultContent, isError, hideScreenshot) => {
        set((state) => {
          const msg = state.conversations[convId]?.messages.find((m) => m.id === messageId);
          if (msg?.toolCalls) {
            const tc = msg.toolCalls.find((t) => t.id === toolCallId);
            if (tc) {
              tc.result = result;
              if (resultContent) tc.resultContent = resultContent;
              if (isError) tc.isError = true;
              if (hideScreenshot != null) tc.hideScreenshot = hideScreenshot;
              tc.isExecuting = false;
            }
          }
        });
      },

      // New message operations
      editMessage: (convId, messageId, newContent) => {
        set((state) => {
          const msg = state.conversations[convId]?.messages.find((m) => m.id === messageId);
          if (msg) {
            // Preserve non-text blocks (images, documents) when content is multimodal
            if (Array.isArray(msg.content)) {
              const nonTextBlocks = msg.content.filter((c) => c.type !== 'text');
              if (nonTextBlocks.length > 0) {
                msg.content = [...nonTextBlocks, { type: 'text' as const, text: newContent }];
              } else {
                msg.content = newContent;
              }
            } else {
              msg.content = newContent;
            }
            state.conversations[convId].updatedAt = Date.now();
            state.conversations[convId].contextCache = undefined;  // Invalidate compression cache
          }
        });
      },

      deleteMessage: (convId, messageId) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.messages = conv.messages.filter((m) => m.id !== messageId);
            conv.updatedAt = Date.now();
            conv.contextCache = undefined;  // Invalidate compression cache
          }
        });
      },

      deleteMessagesFrom: (convId, messageId) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            const idx = conv.messages.findIndex((m) => m.id === messageId);
            if (idx !== -1) {
              conv.messages = conv.messages.slice(0, idx);
              conv.updatedAt = Date.now();
              conv.contextCache = undefined;  // Invalidate compression cache
            }
          }
        });
      },

      deleteLoopMessages: (convId, loopId) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.messages = conv.messages.filter((m) => m.loopId !== loopId);
            conv.updatedAt = Date.now();
            conv.contextCache = undefined;  // Invalidate compression cache
          }
        });
      },

      updateMessageThinking: (convId, thinking) => {
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            messages[messages.length - 1].thinking = thinking;
          }
        });
      },

      updateMessageThinkingDuration: (convId, duration) => {
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            messages[messages.length - 1].thinkingDuration = duration;
          }
        });
      },

      updateMessageUsage: (convId, usage) => {
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            messages[messages.length - 1].usage = {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            };
          }
        });
      },

      appendToolCallContext: (convId, loopId, context) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (!conv) return;
          // Find the last assistant message with this loopId (scan backward, no copy)
          for (let i = conv.messages.length - 1; i >= 0; i--) {
            const m = conv.messages[i];
            if (m.role === 'assistant' && m.loopId === loopId) {
              if (!m.toolCallsForContext) {
                m.toolCallsForContext = [];
              }
              m.toolCallsForContext.push(context);
              break;
            }
          }
        });
      },

      setExecutionStepsSnapshot: (convId, loopId, steps) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (!conv) return;
          // Find the last assistant message with this loopId (scan backward, no copy)
          for (let i = conv.messages.length - 1; i >= 0; i--) {
            const m = conv.messages[i];
            if (m.role === 'assistant' && m.loopId === loopId) {
              m.executionSteps = steps;
              break;
            }
          }
        });
      },

      // Streaming control
      getAbortController: (convId) => {
        let controller = abortControllers.get(convId);
        if (!controller) {
          controller = new AbortController();
          abortControllers.set(convId, controller);
        }
        return controller;
      },

      cancelStreaming: (convId) => {
        const controller = abortControllers.get(convId);
        if (controller) {
          controller.abort();
          abortControllers.delete(convId);
        }
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.isStreaming) {
              lastMsg.isStreaming = false;
              // Append cancellation notice
              if (typeof lastMsg.content === 'string') {
                lastMsg.content += '\n\n*[已停止]*';
              }
            }
            // Mark any executing tool calls as cancelled
            if (lastMsg.toolCalls) {
              lastMsg.toolCalls.forEach((tc) => {
                if (tc.isExecuting) {
                  tc.isExecuting = false;
                  tc.result = '[已取消]';
                }
              });
            }
          }
          state.agentStatus = 'idle';
          state.currentTool = null;
        });
      },

      clearAbortController: (convId) => {
        abortControllers.delete(convId);
      },

      setAgentStatus: (status, tool, agentName) => {
        set((state) => {
          state.agentStatus = status;
          state.currentTool = tool ?? null;
          // Track concurrent active agents
          if (agentName && status === 'tool-calling') {
            if (!state.activeAgentNames.includes(agentName)) {
              state.activeAgentNames.push(agentName);
            }
          }
          // Track thinking start time
          if (status === 'thinking') {
            state.thinkingStartTime = Date.now();
          } else if (status === 'idle') {
            state.thinkingStartTime = null;
            state.activeAgentNames = [];
          }
        });
      },

      removeActiveAgent: (agentName) => {
        set((state) => {
          state.activeAgentNames = state.activeAgentNames.filter(n => n !== agentName);
        });
      },

      setCurrentUsage: (usage) => {
        set((state) => {
          state.currentUsage = usage;
        });
      },

      setPendingInput: (text) => {
        set((state) => {
          state.pendingInput = text;
        });
      },

      setConversationStatus: (convId, status) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.status = status;
            if (status === 'completed') {
              conv.completedAt = Date.now();
            } else {
              conv.completedAt = undefined;
            }
          }
        });
      },

      clearCompletedStatus: (convId) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv && (conv.status === 'completed' || conv.status === 'error')) {
            conv.status = 'idle';
            conv.completedAt = undefined;
          }
        });
      },

      // Toggle MCP server for per-session filter
      toggleMCPServer: (convId, serverName) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (!conv) return;
          const current = conv.enabledMCPServers;
          if (!current) {
            // First toggle: disable this server (start from "all enabled")
            conv.enabledMCPServers = [serverName];
          } else if (current.includes(serverName)) {
            conv.enabledMCPServers = current.filter((n) => n !== serverName);
            if (conv.enabledMCPServers.length === 0) {
              // Empty array = reset to "all enabled"
              conv.enabledMCPServers = undefined;
            }
          } else {
            conv.enabledMCPServers = [...current, serverName];
          }
        });
      },

      // Context compression cache
      setContextCache: (convId, cache) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) conv.contextCache = cache;
        });
      },
      clearContextCache: (convId) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) conv.contextCache = undefined;
        });
      },

      // Export conversation as JSON string
      exportConversation: (convId: string): string | null => {
        const conversations = get().conversations;
        const conv = conversations[convId];
        if (!conv) return null;
        return JSON.stringify(conv, null, 2);
      },

      // Import conversation from JSON string, returns new conversation ID
      importConversation: (json: string) => {
        try {
          const conv = JSON.parse(json) as Conversation;
          if (!conv.id || !conv.messages) return null;

          // Generate new ID to avoid conflicts
          const newId = generateId();
          const imported: Conversation = {
            ...conv,
            id: newId,
            status: 'idle',
            completedAt: undefined,
          };

          // Clean up streaming states
          for (const msg of imported.messages) {
            msg.isStreaming = false;
            if (msg.toolCalls) {
              for (const tc of msg.toolCalls) {
                tc.isExecuting = false;
              }
            }
          }

          set((state) => {
            state.conversations[newId] = imported;
            state.activeConversationId = newId;
          });
          // Sync workspace to imported conversation
          const ws = useWorkspaceStore.getState();
          if (imported.workspacePath) {
            ws.setWorkspace(imported.workspacePath);
          } else {
            ws.clearWorkspace();
          }

          return newId;
        } catch {
          return null;
        }
      },
    })),
    {
      name: 'abu-chat',
      version: 2,
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        // v1 → v2: added executionSteps on Message (optional field, no-op migration)
        if (version < 2) { /* no transform needed */ }
        return state;
      },
      partialize: (state) => ({
        // Strip large base64 image data from resultContent before persisting to localStorage.
        // Images are saved to disk separately; keeping them in localStorage would exceed quota.
        conversations: stripImageDataForPersist(state.conversations),
        // activeConversationId not persisted — app always starts on welcome screen
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;

        // Reset running states and ephemeral fields
        for (const conv of Object.values(state.conversations)) {
          if (conv.status === 'running') {
            conv.status = 'idle';
          }
          conv.completedAt = undefined;
          conv.contextCache = undefined;  // Ephemeral — never restore from disk

          // Clean up streaming flags
          for (const msg of conv.messages) {
            msg.isStreaming = false;
            if (msg.toolCalls) {
              for (const tc of msg.toolCalls) {
                tc.isExecuting = false;
              }
            }
          }

          // Trim messages per conversation
          if (conv.messages.length > MAX_MESSAGES_PER_CONVERSATION) {
            const first = conv.messages.slice(0, KEEP_FIRST_MESSAGES);
            const last = conv.messages.slice(-(MAX_MESSAGES_PER_CONVERSATION - KEEP_FIRST_MESSAGES));
            conv.messages = [...first, ...last];
          }
        }

        // Limit total conversations (keep newest by updatedAt)
        const convEntries = Object.entries(state.conversations);
        if (convEntries.length > MAX_CONVERSATIONS) {
          convEntries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
          const toRemove = convEntries.slice(MAX_CONVERSATIONS);
          for (const [id] of toRemove) {
            delete state.conversations[id];
          }
          // Fix activeConversationId if deleted (pick last = most recent, consistent with deleteConversation)
          if (state.activeConversationId && !state.conversations[state.activeConversationId]) {
            const ids = Object.keys(state.conversations)
              .filter((cid) => !state.conversations[cid]?.scheduledTaskId && !state.conversations[cid]?.triggerId);
            state.activeConversationId = ids.length > 0 ? ids[ids.length - 1] : null;
          }
        }
      },
    }
  )
);

// Helper: get active conversation
export function useActiveConversation() {
  return useChatStore((s) => {
    const id = s.activeConversationId;
    return id ? s.conversations[id] ?? null : null;
  });
}
