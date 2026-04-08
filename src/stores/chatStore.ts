import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { Message, Conversation, AgentStatus, TokenUsage, ConversationStatus, ToolCallForContext, ToolResultContent } from '../types';
import type { ExecutionStepSnapshot } from '../types/execution';
import { useWorkspaceStore } from './workspaceStore';
import { useTaskExecutionStore } from './taskExecutionStore';
import { clearTodos } from '../core/agent/todoManager';
import { clearInputQueue } from '../core/agent/userInputQueue';
import { clearSkillHooksByConversation } from '../core/tools/builtins';
import { removeAgentsByConversation, setConversationLookup } from '../core/agent/backgroundAgentRegistry';
import { cancelSubagent } from '../core/agent/subagentAbort';
import type { ConversationMeta } from '../core/session/conversationStorage';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// Wire up conversation lookup for backgroundAgentRegistry (avoids circular import)
// This runs once when chatStore module is loaded, before any agent completion.
setTimeout(() => {
  setConversationLookup(() => useChatStore.getState().conversations);
}, 0);

/** Default title for new conversations — used for auto-title detection */
export const DEFAULT_CONV_TITLE = '新任务';

// Store abort controllers for each conversation
const abortControllers: Map<string, AbortController> = new Map();

// ── Streaming token buffer (RAF-based debounce) ──
// Tokens accumulate in the buffer and flush once per animation frame,
// reducing React re-renders from 1000+/sec to ~60/sec during streaming.
const tokenBuffer: Map<string, string> = new Map();
let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    if (tokenBuffer.size === 0) return;
    const entries = Array.from(tokenBuffer.entries());
    tokenBuffer.clear();
    // Single Zustand set() call to batch all buffered tokens
    useChatStore.setState((state) => {
      for (const [convId, buffered] of entries) {
        const messages = state.conversations[convId]?.messages;
        if (messages?.length) {
          const lastMsg = messages[messages.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content += buffered;
          }
        }
      }
    });
  });
}

/** Flush any pending buffered tokens immediately (call before finishStreaming) */
export function flushTokenBuffer(convId?: string) {
  if (convId) {
    const buffered = tokenBuffer.get(convId);
    if (buffered) {
      tokenBuffer.delete(convId);
      useChatStore.setState((state) => {
        const messages = state.conversations[convId]?.messages;
        if (messages?.length) {
          const lastMsg = messages[messages.length - 1];
          if (typeof lastMsg.content === 'string') {
            lastMsg.content += buffered;
          }
        }
      });
    }
  } else {
    // Flush all
    const entries = Array.from(tokenBuffer.entries());
    tokenBuffer.clear();
    if (entries.length > 0) {
      useChatStore.setState((state) => {
        for (const [cId, buffered] of entries) {
          const messages = state.conversations[cId]?.messages;
          if (messages?.length) {
            const lastMsg = messages[messages.length - 1];
            if (typeof lastMsg.content === 'string') {
              lastMsg.content += buffered;
            }
          }
        }
      });
    }
  }
}

// Note: Old localStorage persistence limits (MAX_CONVERSATIONS, MAX_MESSAGES_PER_CONVERSATION,
// KEEP_FIRST_MESSAGES, stripImageDataForPersist) removed in v4.
// Messages are now persisted to JSONL files — no localStorage size constraints.

interface ChatState {
  /** Lightweight metadata index — persisted to localStorage + index.json on disk.
   *  This is the source of truth for "what conversations exist". */
  conversationIndex: Record<string, ConversationMeta>;
  /** Active/loaded conversations with full messages — NOT persisted.
   *  Only contains the active conversation + LRU cache of recent ones (~5). */
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
  createConversation: (workspacePath?: string | null, options?: { scheduledTaskId?: string; triggerId?: string; imChannelId?: string; imPlatform?: string; projectId?: string; skipActivate?: boolean }) => string;
  startNewConversation: () => void;
  switchConversation: (id: string) => void;
  setConversationWorkspace: (convId: string, path: string | null) => void;
  setConversationProject: (convId: string, projectId: string | undefined) => void;
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
  setContextWarningLevel: (convId: string, level: 0 | 1 | 2 | 3) => void;

  // Export/Import
  exportConversation: (convId: string) => string | null;
  importConversation: (json: string) => string | null;

  // Persistence — load conversation from disk on demand
  loadConversation: (convId: string) => Promise<void>;
  unloadOldConversations: () => void;
}

export type ChatStore = ChatState & ChatActions;

export const useChatStore = create<ChatStore>()(
  persist(
    immer((set, get) => ({
      conversationIndex: {} as Record<string, ConversationMeta>,
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
        const meta: ConversationMeta = {
          id,
          title: DEFAULT_CONV_TITLE,
          createdAt: now,
          updatedAt: now,
          messageCount: 0,
          workspacePath: workspacePath ?? null,
          ...(options?.scheduledTaskId ? { scheduledTaskId: options.scheduledTaskId } : {}),
          ...(options?.triggerId ? { triggerId: options.triggerId } : {}),
          ...(options?.imChannelId ? { imChannelId: options.imChannelId, imPlatform: options.imPlatform } : {}),
          ...(options?.projectId ? { projectId: options.projectId } : {}),
        };
        set((state) => {
          state.conversations[id] = {
            ...meta,
            messages: [],
            status: 'idle',
          };
          state.conversationIndex[id] = meta;
          if (!options?.skipActivate) {
            state.activeConversationId = id;
          }
        });
        // Sync index to disk (fire-and-forget)
        import('../core/session/conversationStorage').then(({ updateIndexEntry }) => {
          updateIndexEntry(meta).catch(() => {});
        });
        // Sync global workspace to match the new conversation
        if (workspacePath && !options?.skipActivate) {
          useWorkspaceStore.getState().setWorkspace(workspacePath);
        }
        return id;
      },

      startNewConversation: () => {
        // Index the conversation we're leaving (fire-and-forget, no LLM call)
        const prevId = get().activeConversationId;
        const prevConv = prevId ? get().conversations[prevId] : null;
        if (prevConv && prevConv.messages.length >= 2) {
          import('../core/memory/conversationIndexer').then(({ indexConversation }) => {
            indexConversation(prevConv).catch(() => {});
          });
        }

        set((state) => {
          state.activeConversationId = null;
        });
        // Clear global workspace so welcome page starts clean
        useWorkspaceStore.getState().clearWorkspace();
      },

      switchConversation: (id) => {
        // Index the conversation we're leaving (fire-and-forget, no LLM call)
        const prevId = get().activeConversationId;
        const prevConv = prevId ? get().conversations[prevId] : null;
        if (prevConv && prevConv.messages.length >= 2 && prevId !== id) {
          import('../core/memory/conversationIndexer').then(({ indexConversation }) => {
            indexConversation(prevConv).catch(() => {});
          });
        }

        set((state) => {
          state.activeConversationId = id;
        });

        // Load from disk if not in memory, then sync workspace
        const conv = get().conversations[id];
        const meta = get().conversationIndex[id];
        if (!conv && meta) {
          // Set workspace from index immediately (avoid delay)
          const ws = useWorkspaceStore.getState();
          if (meta.workspacePath) ws.setWorkspace(meta.workspacePath);
          else ws.clearWorkspace();
          // Async load messages — guard against race if user switches again before load completes
          get().loadConversation(id).then(() => {
            // Only sync workspace if this conversation is still active
            if (get().activeConversationId !== id) return;
            const loaded = get().conversations[id];
            if (loaded?.workspacePath) {
              ws.setWorkspace(loaded.workspacePath);
            }
          });
        } else {
          // Already in memory — sync workspace immediately
          const ws = useWorkspaceStore.getState();
          if (conv?.workspacePath) {
            ws.setWorkspace(conv.workspacePath);
          } else {
            ws.clearWorkspace();
          }
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

      setConversationProject: (convId, projectId) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.projectId = projectId;
          }
          if (state.conversationIndex[convId]) {
            state.conversationIndex[convId].projectId = projectId;
          }
        });
        // Persist to disk index
        import('../core/session/conversationStorage').then(({ updateIndexEntry }) => {
          const meta = get().conversationIndex[convId];
          if (meta) updateIndexEntry(meta).catch(() => {});
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
        clearSkillHooksByConversation(id);
        useTaskExecutionStore.getState().clearConversation(id);
        // Cancel and remove all background agents for this conversation
        const runningSubagentIds = removeAgentsByConversation(id);
        for (const subId of runningSubagentIds) {
          cancelSubagent(subId);
        }
        // Clean up disk files (JSONL messages, tool results, outputs)
        import('../core/session/conversationStorage').then(({ deleteConversationFiles, removeIndexEntry }) => {
          deleteConversationFiles(id).catch(() => {});
          removeIndexEntry(id).catch(() => {});
        }).catch(() => {});
        // Legacy cleanup: session memory files (tool results offloaded to disk)
        import('../core/session/sessionMemory').then(({ cleanupConversationResults }) => {
          cleanupConversationResults(id).catch(() => {});
        }).catch(() => {});
        // Output snapshots: clears in-memory manifest cache + defensive disk rm
        // (deleteConversationFiles already rm -rf's the conv dir, this is mostly for cache)
        import('../core/session/outputSnapshots').then(({ cleanupConversationOutputs }) => {
          cleanupConversationOutputs(id).catch(() => {});
        }).catch(() => {});
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
          delete state.conversationIndex[id];
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
          if (state.conversationIndex[id]) {
            state.conversationIndex[id].title = title;
          }
        });
        // Persist to disk index
        import('../core/session/conversationStorage').then(({ updateIndexEntry }) => {
          const meta = get().conversationIndex[id];
          if (meta) updateIndexEntry(meta).catch(() => {});
        });
      },

      addMessage: (convId, message) => {
        let newTitle: string | undefined;
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.messages.push(message);
            conv.updatedAt = Date.now();
            // Auto-title from first user message
            if (conv.title === DEFAULT_CONV_TITLE && message.role === 'user') {
              let content = typeof message.content === 'string'
                ? message.content
                : message.content.find(c => c.type === 'text')?.text || '';
              // Strip [Attachment: `path`] patterns from title
              content = content.replace(/\[Attachment:\s*`[^`]*`\]\s*/g, '').trim();
              if (content) {
                newTitle = content.slice(0, 30) + (content.length > 30 ? '...' : '');
                conv.title = newTitle;
              }
            }
            // Sync index metadata
            if (state.conversationIndex[convId]) {
              state.conversationIndex[convId].messageCount = conv.messages.length;
              state.conversationIndex[convId].updatedAt = conv.updatedAt;
              if (newTitle) state.conversationIndex[convId].title = newTitle;
            }
          }
        });
        // Async write to disk (non-blocking)
        import('../core/session/conversationStorage').then(({ appendMessage: diskAppend, updateIndexEntry }) => {
          diskAppend(convId, message).catch(() => {});
          // Persist auto-generated title to disk index
          if (newTitle) {
            const meta = get().conversationIndex[convId];
            if (meta) updateIndexEntry(meta).catch(() => {});
          }
        });
        // Snapshot any user-uploaded files (currently only images with filePath).
        // Fire-and-forget — must never block the UI flow.
        // ★ Architecture contract: when adding new content types with stripForDisk
        //   behavior (e.g. DocumentContent + filePath), add the corresponding
        //   snapshotUserUpload call here. ★
        if (message.role === 'user' && Array.isArray(message.content)) {
          const imageBlocks = message.content.filter(
            (c): c is Extract<typeof c, { type: 'image' }> =>
              c.type === 'image' && !!(c as { filePath?: string }).filePath,
          );
          if (imageBlocks.length > 0) {
            import('../core/session/outputSnapshots').then(({ snapshotUserUpload }) => {
              for (const block of imageBlocks) {
                if (block.filePath) {
                  snapshotUserUpload(convId, block.filePath, message.id, 'image').catch(() => {});
                }
              }
            }).catch(() => {});
          }
        }
      },

      appendToLastMessage: (convId, token) => {
        // Buffer tokens and flush once per animation frame for smooth rendering
        const existing = tokenBuffer.get(convId) ?? '';
        tokenBuffer.set(convId, existing + token);
        scheduleFlush();
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
        // Flush any buffered tokens before marking streaming complete
        flushTokenBuffer(convId);
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            messages[messages.length - 1].isStreaming = false;
          }
          state.agentStatus = 'idle';
          state.currentTool = null;
        });
        // Persist the final completed message to disk.
        // The initial placeholder (content: '') was already written by addMessage,
        // but tokens accumulated in-memory only. updateLastMessage overwrites the
        // last JSONL line so reloads see the full response.
        const finalMsg = get().conversations[convId]?.messages.slice(-1)[0];
        if (finalMsg) {
          import('../core/session/conversationStorage').then(({ updateLastMessage }) => {
            updateLastMessage(convId, finalMsg).catch(() => {});
          });
        }
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
      setContextWarningLevel: (convId: string, level: 0 | 1 | 2 | 3) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) conv.contextWarningLevel = level;
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

          const meta: ConversationMeta = {
            id: newId,
            title: imported.title,
            createdAt: imported.createdAt,
            updatedAt: imported.updatedAt,
            messageCount: imported.messages.length,
            workspacePath: imported.workspacePath,
            imChannelId: imported.imChannelId,
            imPlatform: imported.imPlatform,
            scheduledTaskId: imported.scheduledTaskId,
            triggerId: imported.triggerId,
            projectId: imported.projectId,
          };

          set((state) => {
            state.conversations[newId] = imported;
            state.conversationIndex[newId] = meta;
            state.activeConversationId = newId;
          });
          // Write messages to disk + update index
          import('../core/session/conversationStorage').then(async ({ migrateConversation }) => {
            await migrateConversation(imported);
          }).catch(() => {});
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

      // ── Persistence: load conversation from disk on demand ──

      loadConversation: async (convId: string) => {
        // Already loaded
        if (get().conversations[convId]) return;
        // Not in index
        if (!get().conversationIndex[convId]) return;

        try {
          const { loadMessages } = await import('../core/session/conversationStorage');
          const messages = await loadMessages(convId);
          const meta = get().conversationIndex[convId];
          if (!meta) return;

          set((state) => {
            state.conversations[convId] = {
              id: meta.id,
              title: meta.title,
              createdAt: meta.createdAt,
              updatedAt: meta.updatedAt,
              messages,
              status: 'idle',
              workspacePath: meta.workspacePath,
              imChannelId: meta.imChannelId,
              imPlatform: meta.imPlatform,
              scheduledTaskId: meta.scheduledTaskId,
              triggerId: meta.triggerId,
              projectId: meta.projectId,
            };
          });
        } catch {
          // Load failed — conversation will appear empty
        }

        // Unload old conversations to limit memory usage
        get().unloadOldConversations();
      },

      unloadOldConversations: () => {
        const MAX_LOADED = 5;
        const { conversations, activeConversationId } = get();
        const ids = Object.keys(conversations);
        if (ids.length <= MAX_LOADED) return;

        // Sort by updatedAt, keep newest + active
        const sorted = ids
          .filter((id) => id !== activeConversationId)
          .sort((a, b) =>
            (conversations[b]?.updatedAt ?? 0) - (conversations[a]?.updatedAt ?? 0)
          );

        // Keep (MAX_LOADED - 1) non-active + 1 active
        const toUnload = sorted.slice(MAX_LOADED - 1);
        if (toUnload.length === 0) return;

        set((state) => {
          for (const id of toUnload) {
            // Don't unload conversations with running status
            if (state.conversations[id]?.status === 'running') continue;
            delete state.conversations[id];
          }
        });
      },
    })),
    {
      name: 'abu-chat',
      version: 4,
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        // v1 → v2: added executionSteps on Message (optional field, no-op migration)
        if (version < 2) { /* no transform needed */ }
        // v2 → v3: added projectId on Conversation (optional field, no-op migration)
        if (version < 3) { /* no transform needed */ }
        // v3 → v4: migrate conversations from localStorage to file system
        if (version < 4) {
          // Mark for async migration in onRehydrateStorage
          state._v3Conversations = state.conversations;
          // Build conversationIndex from old conversations
          const oldConvs = state.conversations as Record<string, Conversation> | undefined;
          if (oldConvs) {
            const index: Record<string, ConversationMeta> = {};
            for (const conv of Object.values(oldConvs)) {
              index[conv.id] = {
                id: conv.id,
                title: conv.title,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                messageCount: conv.messages.length,
                workspacePath: conv.workspacePath,
                imChannelId: conv.imChannelId,
                imPlatform: conv.imPlatform,
                scheduledTaskId: conv.scheduledTaskId,
                triggerId: conv.triggerId,
                projectId: conv.projectId,
              };
            }
            state.conversationIndex = index;
          }
          // Clear conversations from persisted state — they'll be on disk
          state.conversations = {};
        }
        return state;
      },
      partialize: (state) => ({
        // Only persist lightweight index to localStorage (~100KB max)
        conversationIndex: state.conversationIndex,
        // conversations NOT persisted — loaded from JSONL on demand
        // activeConversationId NOT persisted — app always starts on welcome screen
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;

        // v3 → v4 async migration: write old conversations to JSONL files
        const stateAny = state as unknown as Record<string, unknown>;
        const v3Convs = stateAny._v3Conversations as Record<string, Conversation> | undefined;
        if (v3Convs) {
          delete stateAny._v3Conversations;
          // Fire-and-forget migration — if it fails, we still have the index
          import('../core/session/conversationStorage').then(async ({ migrateConversation }) => {
            for (const conv of Object.values(v3Convs)) {
              try {
                await migrateConversation(conv);
              } catch {
                // Individual conversation migration failure is non-critical
              }
            }
          }).catch(() => {});
        }

        // Sync conversationIndex from disk (file system is authoritative after migration)
        import('../core/session/conversationStorage').then(async ({ loadIndex }) => {
          const diskIndex = await loadIndex();
          const diskEntries = diskIndex.entries;
          // Merge: disk is authoritative, but keep localStorage entries that aren't on disk yet
          const merged = { ...state.conversationIndex, ...diskEntries };
          useChatStore.setState({ conversationIndex: merged });
        }).catch(() => {});

        // Reset running conversations to idle (no longer have messages in memory)
        // Messages will be loaded on demand when user switches to them
        state.conversations = {};
        state.activeConversationId = null;
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
