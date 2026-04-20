import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { Message, Conversation, AgentStatus, TokenUsage, ConversationStatus, ToolCallForContext, ToolResultContent, ToolCall, NoticeCardAction } from '../types';
import type { ExecutionStepSnapshot } from '../types/execution';
import { useWorkspaceStore } from './workspaceStore';
import { useProjectStore } from './projectStore';
import { useTaskExecutionStore } from './taskExecutionStore';
import { clearTodos } from '../core/agent/todoManager';
import { clearInputQueue } from '../core/agent/userInputQueue';
import { clearSkillHooksByConversation } from '../core/tools/builtins';
import { removeAgentsByConversation, setConversationLookup } from '../core/agent/backgroundAgentRegistry';
import { cancelSubagent } from '../core/agent/subagentAbort';
import { setComputerUseActive } from '../core/agent/computerUseStatus';
import type { ConversationMeta } from '../core/session/conversationStorage';
import type { ShareBundle } from '../core/session/shareBundle';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/** Extra safety net for messages coming in via import — ensures no streaming
 * flag survives even if the source bundle was built by a broken exporter. */
function sanitizeImportedMessage(msg: Message): Message {
  return {
    ...msg,
    isStreaming: false,
    toolCalls: msg.toolCalls?.map((tc) => ({ ...tc, isExecuting: false })),
  };
}

/** Build an in-memory Conversation + Meta from a validated ShareBundle.
 * Intentionally drops external references (workspacePath, scheduledTaskId,
 * triggerId, projectId, imChannelId/imPlatform, activeSkills,
 * enabledMCPServers) so the imported copy is self-contained. The recipient
 * can keep chatting on top of it — only the origin is tagged via
 * `importedFrom`, surfaced as a small sidebar badge. The `readOnly` field
 * on Conversation/Meta is kept in the type for a future team-sync use case
 * but deliberately not set here. */
function buildImportedFromShareBundle(bundle: ShareBundle): { conv: Conversation; meta: ConversationMeta } {
  const newId = generateId();
  const importedFrom = {
    schemaVersion: bundle.schema.abuShareVersion,
    importedAt: Date.now(),
  };
  const conv: Conversation = {
    id: newId,
    title: bundle.conversation.title,
    createdAt: bundle.conversation.createdAt,
    updatedAt: bundle.conversation.updatedAt,
    messages: bundle.messages.map(sanitizeImportedMessage),
    status: 'idle',
    importedFrom,
  };
  const meta: ConversationMeta = {
    id: newId,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: conv.messages.length,
    importedFrom,
  };
  return { conv, meta };
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
//
// Buffer is keyed by `${convId}::${msgId}` so that if the user sends a new
// message mid-stream (which becomes the "last" message in the conversation),
// streaming tokens still flow to the correct assistant message instead of
// being appended to the new user bubble.
type BufferKey = string;
const tokenBuffer: Map<BufferKey, string> = new Map();
const FALLBACK_LAST = '__last__';
function bufferKey(convId: string, msgId?: string): BufferKey {
  return `${convId}::${msgId ?? FALLBACK_LAST}`;
}
function parseBufferKey(key: BufferKey): { convId: string; msgId: string } {
  const idx = key.indexOf('::');
  return { convId: key.slice(0, idx), msgId: key.slice(idx + 2) };
}

/** Find target message: by id if provided, else last message. */
function findTargetMessage(messages: Message[] | undefined, msgId: string): Message | undefined {
  if (!messages?.length) return undefined;
  if (msgId !== FALLBACK_LAST) {
    return messages.find((m) => m.id === msgId);
  }
  return messages[messages.length - 1];
}

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
      for (const [key, buffered] of entries) {
        const { convId, msgId } = parseBufferKey(key);
        const target = findTargetMessage(state.conversations[convId]?.messages, msgId);
        if (target && typeof target.content === 'string') {
          target.content += buffered;
        }
      }
    });
  });
}

/** Flush any pending buffered tokens immediately (call before finishStreaming) */
export function flushTokenBuffer(convId?: string, msgId?: string) {
  const matchingKeys: BufferKey[] = [];
  for (const key of tokenBuffer.keys()) {
    if (!convId) {
      matchingKeys.push(key);
    } else {
      const parsed = parseBufferKey(key);
      if (parsed.convId !== convId) continue;
      if (msgId && parsed.msgId !== msgId && parsed.msgId !== FALLBACK_LAST) continue;
      matchingKeys.push(key);
    }
  }
  if (matchingKeys.length === 0) return;
  const entries = matchingKeys.map((k) => [k, tokenBuffer.get(k)!] as const);
  for (const k of matchingKeys) tokenBuffer.delete(k);
  useChatStore.setState((state) => {
    for (const [key, buffered] of entries) {
      const { convId: cId, msgId: mId } = parseBufferKey(key);
      const target = findTargetMessage(state.conversations[cId]?.messages, mId);
      if (target && typeof target.content === 'string') {
        target.content += buffered;
      }
    }
  });
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
  /** Bumped whenever a conversation's outputs manifest materially changes
   *  from outside the snapshot hot path — currently: after
   *  installSharedAttachments writes newly imported files. FileAttachment
   *  watches this so it re-resolves once the async import finishes, rather
   *  than getting stuck showing "missing" because it read the manifest
   *  before the install side-effects landed. Ephemeral, not persisted. */
  outputsRev: Record<string, number>;
}

interface ChatActions {
  createConversation: (workspacePath?: string | null, options?: { scheduledTaskId?: string; triggerId?: string; imChannelId?: string; imPlatform?: string; projectId?: string; skipActivate?: boolean }) => string;
  startNewConversation: () => void;
  switchConversation: (id: string) => Promise<void>;
  setConversationWorkspace: (convId: string, path: string | null) => void;
  setConversationProject: (convId: string, projectId: string | undefined) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;

  addMessage: (convId: string, message: Message) => void;
  /** Append a streaming token. If `msgId` is provided, append to that specific message;
   *  otherwise fall back to the last message in the conversation. Pass `msgId` whenever
   *  the agent loop is streaming so mid-stream user messages don't get corrupted. */
  appendToLastMessage: (convId: string, token: string, msgId?: string) => void;
  setLastMessageContent: (convId: string, content: string, msgId?: string) => void;
  finishStreaming: (convId: string, msgId?: string) => void;
  updateToolCall: (convId: string, messageId: string, toolCallId: string, result: string, resultContent?: ToolResultContent[], isError?: boolean, hideScreenshot?: boolean) => void;
  /**
   * Persist the user's click on an interactive notice card attached to a
   * tool call (see `ToolCall.noticeCardAction`). Called from the card
   * React component when [采纳] / [拒绝] / [这类别] is clicked. Writes
   * through to disk via replaceMessageById so reload keeps the state.
   */
  setToolCallNoticeCardAction: (convId: string, messageId: string, toolCallId: string, action: NoticeCardAction) => void;
  /**
   * Stash a post-loop proposal signal on the conversation so the next
   * turn's orchestrator can surface a one-shot <consider_sinking> nudge.
   * Ephemeral — not persisted. See `proposalSignal.ts`.
   */
  setPendingProposalSignal: (convId: string, signal: import('../core/agent/proposalSignal').ProposalSignal | undefined) => void;

  // New message operations
  editMessage: (convId: string, messageId: string, newContent: string) => void;
  deleteMessage: (convId: string, messageId: string) => void;
  deleteMessagesFrom: (convId: string, messageId: string) => void;
  deleteLoopMessages: (convId: string, loopId: string) => void;
  updateMessageThinking: (convId: string, thinking: string, msgId?: string) => void;
  updateMessageThinkingDuration: (convId: string, duration: number, msgId?: string) => void;
  updateMessageUsage: (convId: string, usage: TokenUsage, msgId?: string) => void;
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
  /**
   * Build a redacted, portable share bundle for the given conversation.
   * Returns null if the conversation does not exist. Caller is responsible
   * for awaiting `loadConversation(convId)` when the conversation may not be
   * in the in-memory cache — this action does the load itself.
   */
  exportConversationForShare: (
    convId: string,
    opts?: { tier?: import('../core/session/shareBundle').ShareTier },
  ) => Promise<import('../core/session/shareBundle').ShareBundle | null>;

  // Persistence — load conversation from disk on demand
  loadConversation: (convId: string) => Promise<void>;
  unloadOldConversations: () => void;
}

export type ChatStore = ChatState & ChatActions;

// Monotonic counter to discard stale switchConversation results on rapid clicks
let switchSeq = 0;

export const useChatStore = create<ChatStore>()(
  persist(
    immer((set, get) => ({
      conversationIndex: {} as Record<string, ConversationMeta>,
      conversations: {},
      activeConversationId: null,
      agentStatus: 'idle' as AgentStatus,
      currentTool: null,
      currentUsage: null,
      outputsRev: {} as Record<string, number>,
      pendingInput: null,
      thinkingStartTime: null,
      activeAgentNames: [],

      createConversation: (workspacePath, options) => {
        const id = generateId();
        const now = Date.now();
        // Auto-associate with a project when workspace matches. Covers the
        // welcome-page "create project → type first message" flow where the
        // caller never has a projectId to pass. Explicit options.projectId
        // still wins (schedule / trigger / IM can override).
        let resolvedProjectId = options?.projectId;
        if (!resolvedProjectId && workspacePath) {
          const project = useProjectStore.getState().getProjectByWorkspace(workspacePath);
          if (project) resolvedProjectId = project.id;
        }
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
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
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
        set((state) => {
          state.activeConversationId = null;
        });
        // Top-level "新建任务" is semantically "step out of the current
        // project context" — clear the global workspace so the welcome
        // page starts fresh, no ambient project leak. If the user's new
        // task needs a workspace, agent will call request_workspace (see
        // orchestrator workspace-hint + skill_manage error hint).
        useWorkspaceStore.getState().clearWorkspace();
      },

      switchConversation: async (id) => {
        const seq = ++switchSeq;

        // Load from disk first if not in memory — ensures data is ready
        // before activeConversationId changes, so React renders only once
        // (no flash of welcome page during LRU cache miss)
        if (!get().conversations[id] && get().conversationIndex[id]) {
          await get().loadConversation(id);
        }

        // Discard if user already clicked another conversation while loading
        if (seq !== switchSeq) return;

        set((state) => {
          state.activeConversationId = id;
        });

        // Unload old conversations AFTER activeConversationId is set,
        // so the target conversation is protected from eviction
        get().unloadOldConversations();

        // Sync workspace to the target conversation. If the target has no
        // binding, clear so UI doesn't show a stale workspace from the
        // previous conv — users expect conversation and workspace to
        // track together. Downstream "tool lost workspace mid-session"
        // bugs from the earlier cascade (4ba56d3 / b2b69c6 / ffeb7cb)
        // are handled by those existing defensive patches + request_
        // workspace agent fallback (Task #37), not by this switch path.
        const ws = useWorkspaceStore.getState();
        const conv = get().conversations[id];
        if (conv?.workspacePath) {
          ws.setWorkspace(conv.workspacePath);
        } else {
          const meta = get().conversationIndex[id];
          if (meta?.workspacePath) ws.setWorkspace(meta.workspacePath);
          else ws.clearWorkspace();
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
          // Always persist updated index (messageCount, updatedAt, and title if changed)
          const meta = get().conversationIndex[convId];
          if (meta) updateIndexEntry(meta).catch(() => {});
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

      appendToLastMessage: (convId, token, msgId) => {
        // Buffer tokens and flush once per animation frame for smooth rendering
        const key = bufferKey(convId, msgId);
        const existing = tokenBuffer.get(key) ?? '';
        tokenBuffer.set(key, existing + token);
        scheduleFlush();
      },

      setLastMessageContent: (convId, content, msgId) => {
        set((state) => {
          const target = findTargetMessage(
            state.conversations[convId]?.messages,
            msgId ?? FALLBACK_LAST,
          );
          if (target) target.content = content;
        });
      },

      finishStreaming: (convId, msgId) => {
        // Flush any buffered tokens before marking streaming complete
        flushTokenBuffer(convId, msgId);
        set((state) => {
          const target = findTargetMessage(
            state.conversations[convId]?.messages,
            msgId ?? FALLBACK_LAST,
          );
          if (target) target.isStreaming = false;
          state.agentStatus = 'idle';
          state.currentTool = null;
        });
        // Persist the final completed message to disk.
        // When msgId is provided, we must replace by id (not "last line") because the
        // user may have sent another message mid-stream — the assistant message we are
        // finishing is no longer the last JSONL line.
        const messages = get().conversations[convId]?.messages;
        const finalMsg = msgId
          ? messages?.find((m) => m.id === msgId)
          : messages?.slice(-1)[0];
        if (finalMsg) {
          if (msgId) {
            import('../core/session/conversationStorage').then(({ replaceMessageById }) => {
              replaceMessageById(convId, finalMsg).catch(() => {});
            });
          } else {
            import('../core/session/conversationStorage').then(({ updateLastMessage }) => {
              updateLastMessage(convId, finalMsg).catch(() => {});
            });
          }
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

              // Lift notice_card out of the tool's JSON result into a
              // first-class field on the tool call so the chat renderer
              // can pick it up without re-parsing on every frame. Best-
              // effort — a malformed result just leaves noticeCard unset.
              try {
                const parsed = JSON.parse(result) as { notice_card?: ToolCall['noticeCard'] };
                if (parsed?.notice_card) {
                  tc.noticeCard = parsed.notice_card;
                }
              } catch {
                /* non-JSON result — skip card extraction */
              }
            }
          }
        });
        // Persist the updated tool result immediately. Without this, tool results
        // only hit disk when finishStreaming / turn-boundary replaceMessageById fires —
        // so a crash/force-quit mid-stream (or a late-arriving result after the
        // enclosing message was already snapshotted) loses toolCalls on reload.
        const updatedMsg = get().conversations[convId]?.messages.find((m) => m.id === messageId);
        if (updatedMsg) {
          import('../core/session/conversationStorage').then(({ replaceMessageById }) => {
            replaceMessageById(convId, updatedMsg).catch(() => {});
          });
        }
      },

      setPendingProposalSignal: (convId, signal) => {
        // By design: NOT PERSISTED.
        //
        // The signal lives only on the in-memory Conversation object
        // (conversations are backed by JSONL on disk, but that file
        // persists messages only — conv-level fields stay ephemeral).
        //
        // We *want* this to be ephemeral. Reasons (see proposalSignal.ts
        // module docstring):
        //   1. Avoid stale signals firing days later after the user
        //      already moved on ("why is Abu suddenly asking about a
        //      task I did last Tuesday?").
        //   2. Avoid signals computed under one proactivity preset
        //      firing under a different preset (user dialed from
        //      butler to shy, signal from butler-era would surprise).
        //   3. Keeps the mental model simple — signal is a nudge for
        //      the *next turn in the current session*, nothing more.
        //
        // Losing the signal on app restart is fine: the next
        // sink-worthy loop will compute a fresh one. The only impact
        // is that the specific loop that fired signal pre-restart
        // doesn't get a follow-up nudge — and that's a feature, see (1).
        //
        // If you think this needs to persist, re-read proposalSignal.ts
        // first and convince yourself (1)-(3) don't apply.
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) conv.pendingProposalSignal = signal;
        });
      },

      setToolCallNoticeCardAction: (convId, messageId, toolCallId, action) => {
        set((state) => {
          const msg = state.conversations[convId]?.messages.find((m) => m.id === messageId);
          const tc: ToolCall | undefined = msg?.toolCalls?.find((t) => t.id === toolCallId);
          if (tc) {
            tc.noticeCardAction = action;
          }
        });
        // Persist so the settled state survives reload. Mirrors the pattern
        // used by updateToolCall above.
        const updatedMsg = get().conversations[convId]?.messages.find((m) => m.id === messageId);
        if (updatedMsg) {
          import('../core/session/conversationStorage').then(({ replaceMessageById }) => {
            replaceMessageById(convId, updatedMsg).catch(() => {});
          });
        }
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

      updateMessageThinking: (convId, thinking, msgId) => {
        set((state) => {
          const target = findTargetMessage(
            state.conversations[convId]?.messages,
            msgId ?? FALLBACK_LAST,
          );
          if (target) target.thinking = thinking;
        });
      },

      updateMessageThinkingDuration: (convId, duration, msgId) => {
        set((state) => {
          const target = findTargetMessage(
            state.conversations[convId]?.messages,
            msgId ?? FALLBACK_LAST,
          );
          if (target) target.thinkingDuration = duration;
        });
      },

      updateMessageUsage: (convId, usage, msgId) => {
        set((state) => {
          const target = findTargetMessage(
            state.conversations[convId]?.messages,
            msgId ?? FALLBACK_LAST,
          );
          if (target) {
            target.usage = {
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
        // Clean up Computer Use overlay and status on abort (synchronous imports for reliability)
        setComputerUseActive(false);
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('hide_screen_border').catch(() => {});
          invoke('window_show').catch(() => {});
        }).catch(() => {});

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
            // If cancel happened mid-thinking, finalize thinkingDuration so the
            // synthesized thinking step flips from 'running' → 'completed' and the
            // UI stops rendering the spinner + streaming cursor inside the bubble.
            // thinkingDuration is the canonical "thinking done" signal in both
            // MessageGroup's synth path and workflowExtractor's legacy path.
            if (lastMsg.thinking && lastMsg.thinkingDuration === undefined) {
              const start = state.thinkingStartTime;
              lastMsg.thinkingDuration = start
                ? Math.max(1, Math.round((Date.now() - start) / 1000))
                : 1;
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
          state.thinkingStartTime = null;
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

      // Import conversation from JSON string, returns new conversation ID.
      //
      // Accepts two payload shapes, auto-dispatched by inspecting the parsed
      // structure:
      //   1. Share bundle (`schema.abuShareVersion === 1`) — built by
      //      `exportConversationForShare`. Produces a read-only conversation
      //      with external references stripped and an `importedFrom` stamp.
      //   2. Raw conversation JSON (legacy, used by the undo-delete flow via
      //      `exportConversation`). Retained verbatim so undo keeps working.
      importConversation: (json: string) => {
        try {
          const parsed = JSON.parse(json) as unknown;

          // ── Share bundle path ───────────────────────────────────────────
          if (
            parsed &&
            typeof parsed === 'object' &&
            (parsed as { schema?: { abuShareVersion?: unknown } }).schema?.abuShareVersion === 1
          ) {
            const bundle = parsed as ShareBundle;
            if (!Array.isArray(bundle.messages) || !bundle.conversation) return null;
            const { conv, meta } = buildImportedFromShareBundle(bundle);

            set((state) => {
              state.conversations[conv.id] = conv;
              state.conversationIndex[conv.id] = meta;
              state.activeConversationId = conv.id;
            });
            // Persist messages to JSONL + install bundled attachments. Both
            // happen async; attach a rev bump at the end so FileAttachment
            // components re-resolve once the outputs manifest materially
            // changes (otherwise they'd stay stuck on the empty snapshot
            // they read in the same tick as `set` landed).
            const attachmentsToInstall = bundle.attachments && Object.keys(bundle.attachments).length > 0
              ? bundle.attachments
              : null;
            (async () => {
              try {
                const { migrateConversation } = await import('../core/session/conversationStorage');
                await migrateConversation(conv);
              } catch { /* non-fatal */ }
              if (attachmentsToInstall) {
                try {
                  const { installSharedAttachments } = await import('../core/session/outputSnapshots');
                  await installSharedAttachments(conv.id, attachmentsToInstall);
                } catch { /* non-fatal */ }
                set((state) => {
                  state.outputsRev[conv.id] = (state.outputsRev[conv.id] ?? 0) + 1;
                });
              }
            })();
            // Imported share bundles are not bound to any workspace.
            useWorkspaceStore.getState().clearWorkspace();
            return conv.id;
          }

          // ── Legacy raw conversation path (undo-delete) ──────────────────
          const conv = parsed as Conversation;
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
            readOnly: imported.readOnly,
            importedFrom: imported.importedFrom,
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

      // Build a redacted share bundle. Does not write to disk — the caller
      // (preview dialog) is responsible for persisting the JSON after the
      // user confirms.
      exportConversationForShare: async (convId, opts = {}) => {
        await get().loadConversation(convId);
        const conv = get().conversations[convId];
        if (!conv) return null;
        const { buildShareBundle } = await import('../core/session/shareBundle');
        return buildShareBundle(conv, { tier: opts.tier ?? 'standard' });
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
              readOnly: meta.readOnly,
              importedFrom: meta.importedFrom,
            };
          });
        } catch {
          // Load failed — create an empty conversation so the chat view still
          // renders (instead of falling through to the welcome page)
          const meta = get().conversationIndex[convId];
          if (meta) {
            set((state) => {
              state.conversations[convId] = {
                id: meta.id,
                title: meta.title,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt,
                messages: [],
                status: 'idle',
                workspacePath: meta.workspacePath,
                imChannelId: meta.imChannelId,
                imPlatform: meta.imPlatform,
                scheduledTaskId: meta.scheduledTaskId,
                triggerId: meta.triggerId,
                projectId: meta.projectId,
                readOnly: meta.readOnly,
                importedFrom: meta.importedFrom,
              };
            });
          }
        }

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
      version: 5,
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        // v1 → v2: added executionSteps on Message (optional field, no-op migration)
        if (version < 2) { /* no transform needed */ }
        // v2 → v3: added projectId on Conversation (optional field, no-op migration)
        if (version < 3) { /* no transform needed */ }
        // v4 → v5: added readOnly + importedFrom on ConversationMeta (optional fields, no-op migration)
        if (version < 5) { /* no transform needed */ }
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
          // Disk is authoritative. Only keep localStorage entries that were created
          // very recently (within 60s) — these survive the brief window between
          // conversation creation and the first disk index flush.
          // Older localStorage-only entries are ghost leftovers from failed v3→v4
          // migration and must be dropped (their JSONL files never existed).
          const cutoff = Date.now() - 60_000;
          const localOnly: Record<string, ConversationMeta> = {};
          for (const [id, meta] of Object.entries(state.conversationIndex)) {
            if (!diskEntries[id] && meta.createdAt > cutoff) {
              localOnly[id] = meta;
            }
          }
          const merged = { ...localOnly, ...diskEntries };
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
