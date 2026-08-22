import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { current } from 'immer';
import type { Message, Conversation, AgentStatus, RetryInfo, TokenUsage, ConversationStatus, ToolCallForContext, ToolResultContent, ToolCall, NoticeCardAction, SandboxRecoveryAction, ToolExecutionMetadata, UserQuestionResult } from '../types';
import type { ExecutionStepSnapshot, PlannedStep } from '../types/execution';
import { useWorkspaceStore } from './workspaceStore';
import { useProjectStore } from './projectStore';
import { useTaskExecutionStore } from './taskExecutionStore';
import { clearInputQueue } from '../core/agent/userInputQueue';
import { clearSkillHooksByConversation } from '../core/tools/builtins';
import { clearPlanMode } from '../core/agent/planMode';
import { setComputerUseActive } from '../core/agent/computerUseStatus';
import { isConversationRunningInSidecar } from '../core/agent/sidecarRunPredicate';
import type { ConversationMeta } from '../core/session/conversationStorage';
import type { ShareBundle } from '../core/session/shareBundle';
import type { PermissionMode } from '../core/permissions/permissionMode';
import type { ChatReference } from '@/types/chatReference';
import { getI18n } from '../i18n';
import { TOOL_NAMES } from '../core/tools/toolNames';
import { resetSessionPromotions } from '../core/tools/toolSearch';
import {
  clearConversationComposerDraft,
  getComposerDraftScopeForEnterpriseMode,
} from './composerDraftStore';
import { useEnterpriseStore } from './enterpriseStore';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

const ACTIVE_RUN_STATES = new Set<Message['runState']>(['pending', 'accepted', 'running', 'recovering']);
const TERMINAL_RUN_STATES = new Set<Message['runState']>([
  'completed',
  'failed',
  'connection-failed',
  'interrupted',
]);

function recoverInterruptedUserRun(msg: Message): Message {
  if (msg.role !== 'user' || !ACTIVE_RUN_STATES.has(msg.runState)) return msg;
  return {
    ...msg,
    runState: 'failed',
    runError: getI18n().chat.runRecoveredAfterRestart,
  };
}

/** Extra safety net for messages coming in via import — ensures no streaming
 * flag survives even if the source bundle was built by a broken exporter. */
export function sanitizeImportedMessage(msg: Message): Message {
  return recoverInterruptedUserRun({
    ...msg,
    isStreaming: false,
    toolCalls: msg.toolCalls?.map((tc) => {
      const {
        sandboxRecovery: _sandboxRecovery,
        sandboxRecoveryAction: _sandboxRecoveryAction,
        ...safeToolCall
      } = tc;
      return { ...safeToolCall, isExecuting: false };
    }),
  });
}

/** Strip ghost assistant messages and clear stale isStreaming flags after loading from disk.
 * Ghost messages are empty assistant placeholders written before content arrived
 * (crash / network failure before streaming started). They must not reach the LLM. */
export function sanitizeLoadedMessages(messages: Message[]): Message[] {
  return messages
    .map((msg) => {
      const toolCalls = msg.toolCalls?.map((tc) => {
        const safeToRetryRecovery =
          tc.sandboxRecoveryAction === 'pending'
          || tc.sandboxRecoveryAction === 'enqueued';
        return {
          ...tc,
          isExecuting: false,
          sandboxRecoveryAction: tc.sandboxRecoveryAction === 'started'
            ? 'needs-review' as const
            : safeToRetryRecovery
            ? 'failed' as const
            : tc.sandboxRecoveryAction,
        };
      });
      return recoverInterruptedUserRun({
        ...msg,
        isStreaming: false,
        toolCalls,
      });
    })
    .filter(msg => {
      if (msg.role !== 'assistant') return true;
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter(c => c.type === 'text').map(c => (c as { type: 'text'; text: string }).text).join('');
      return text.trim().length > 0
        || (msg.toolCalls?.length ?? 0) > 0
        || (msg.toolCallsForContext?.length ?? 0) > 0
        || !!msg.thinking;
    });
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


/** Default title for new conversations — resolved from i18n at creation time. */
export function getDefaultConvTitle(): string {
  return getI18n().chatDefaults.newConversationTitle;
}

/**
 * Pick the next active conversation when the currently-active one is being
 * deleted. Mirrors the visual order the sidebar renders (`createdAt` desc),
 * scoped to the same "section" the deleted conversation belonged to (project
 * vs recent vs scheduled vs trigger), so focus moves to a neighbor the user
 * would expect — not a random conversation from a different section.
 *
 * Selection rule:
 *   1. Same scope = same projectId / scheduledTaskId / triggerId tuple.
 *   2. Sort by createdAt desc (matches Sidebar.tsx).
 *   3. Prefer the entry directly *above* the deleted one (newer, "上一个").
 *   4. Fall back to the entry directly *below* (older, "下一个").
 *   5. If nothing else is in scope, return null.
 *
 * Visible to tests via the export — keep the signature stable.
 */
export function findNextActiveConversation(
  index: Record<string, ConversationMeta>,
  deletedId: string,
): string | null {
  const deleted = index[deletedId];
  if (!deleted) return null;

  const sorted = Object.values(index)
    .filter((c) =>
      c.scheduledTaskId === deleted.scheduledTaskId
      && c.triggerId === deleted.triggerId
      && c.projectId === deleted.projectId,
    )
    .sort((a, b) => b.createdAt - a.createdAt);

  const pos = sorted.findIndex((c) => c.id === deletedId);
  if (pos === -1) return null;

  // Prev (above in UI = newer) preferred
  if (pos > 0) return sorted[pos - 1].id;
  // Otherwise next (below = older)
  if (pos + 1 < sorted.length) return sorted[pos + 1].id;
  return null;
}

// Store abort controllers for each conversation
const abortControllers: Map<string, AbortController> = new Map();

// Persistence started by store actions intentionally stays off the render
// path, but sidecar runs need a durability barrier before their RPC resolves:
// otherwise the UI can show a completed assistant turn while its fire-and-
// forget JSONL append/replace is still in flight. Keep the promises grouped
// by conversation so the dispatch bridge can await only the run it owns.
interface ConversationPersistenceState {
  tail: Promise<void>;
  firstError?: unknown;
}

const pendingConversationPersistence = new Map<string, ConversationPersistenceState>();

function trackConversationPersistence(
  convId: string,
  operation: () => Promise<unknown>,
): void {
  const state = pendingConversationPersistence.get(convId) ?? {
    tail: Promise.resolve(),
  };
  const tracked = state.tail
    // A failed write must not permanently poison the serial queue: later
    // mutations still get a chance to repair disk state. The first error is
    // retained separately and surfaced by the durability barrier below.
    .catch(() => undefined)
    .then(operation)
    .then(() => undefined)
    .catch((error: unknown) => {
      state.firstError ??= error;
      throw error;
    });
  state.tail = tracked;
  pendingConversationPersistence.set(convId, state);
  // Attach a rejection handler immediately so fire-and-forget store actions
  // never produce an unhandled rejection. The error remains in `state` until
  // an explicit barrier consumes it.
  void tracked.catch(() => undefined).finally(() => {
    if (pendingConversationPersistence.get(convId) === state
      && state.tail === tracked
      && state.firstError === undefined) {
      pendingConversationPersistence.delete(convId);
    }
  });
}

/**
 * Wait until every message/index persistence operation already started for
 * this conversation has settled. The loop handles operations added while it
 * is awaiting an earlier snapshot, so an append that schedules its index
 * update cannot escape the barrier.
 */
export async function waitForConversationPersistence(convId: string): Promise<void> {
  while (true) {
    const state = pendingConversationPersistence.get(convId);
    if (!state) return;
    const pending = state.tail;
    try {
      await pending;
    } catch {
      // `firstError` below is the authoritative failure. Keep looping if a
      // newer queued mutation appeared while this snapshot was in flight.
    }
    if (pendingConversationPersistence.get(convId) !== state || state.tail !== pending) continue;
    pendingConversationPersistence.delete(convId);
    if (state.firstError !== undefined) throw state.firstError;
    return;
  }
}

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
// Thinking buffer — same RAF cadence as tokenBuffer, but REPLACE semantics
// instead of concatenation: every `updateMessageThinking` call already
// carries the FULL accumulated thinking text for the block (agentLoop keeps
// its own `collectedThinking` accumulator and passes that whole string on
// every call — true for both the Claude adapter, which emits one `thinking`
// event per block, and the OpenAI-compatible adapter's DeepSeek-R1-style
// per-SSE-chunk `reasoning_content` path). So batching only needs to keep
// the latest value per key, not append fragments.
const thinkingBuffer: Map<BufferKey, string> = new Map();
const FALLBACK_LAST = '__last__';
function bufferKey(convId: string, msgId?: string): BufferKey {
  return `${convId}::${msgId ?? FALLBACK_LAST}`;
}
function parseBufferKey(key: BufferKey): { convId: string; msgId: string } {
  const idx = key.indexOf('::');
  return { convId: key.slice(0, idx), msgId: key.slice(idx + 2) };
}

/** Collect the buffer keys matching an optional (convId, msgId) filter —
 *  shared selection logic between `flushTokenBuffer`'s two buffers. No
 *  filter (convId omitted) matches everything, mirroring the pre-existing
 *  tokenBuffer behavior. */
function matchingBufferKeys(buf: Map<BufferKey, string>, convId?: string, msgId?: string): BufferKey[] {
  const keys: BufferKey[] = [];
  for (const key of buf.keys()) {
    if (!convId) {
      keys.push(key);
      continue;
    }
    const parsed = parseBufferKey(key);
    if (parsed.convId !== convId) continue;
    if (msgId && parsed.msgId !== msgId && parsed.msgId !== FALLBACK_LAST) continue;
    keys.push(key);
  }
  return keys;
}

/** Find target message: by id if provided, else last message. */
function findTargetMessage(messages: Message[] | undefined, msgId: string): Message | undefined {
  if (!messages?.length) return undefined;
  if (msgId !== FALLBACK_LAST) {
    return messages.find((m) => m.id === msgId);
  }
  return messages[messages.length - 1];
}

/**
 * Best-effort catalog count adjustment for the one case `deleteMessagesFrom`
 * cannot durably reconcile: a truncate whose `from` id never reached disk
 * (see `appendTruncateEvent`'s skip guard) writes no ledger event at all, so
 * there is nothing for `catalogReindexConversation` to re-derive from. This
 * is a DISPLAY-LEVEL / session-level count nudge, not a claim that the JSONL
 * file itself shrank by `removedCount`. A wrong/stale bump here is harmless
 * and self-heals: `catalog_reconcile` re-derives the true count from JSONL on
 * next startup (same accepted-drift posture as the P0 write-through comment
 * elsewhere in this file). Do NOT "fix" this into an exact JSONL-truth
 * accounting — that's an intentional trade-off, not an oversight. (Plan
 * stage 3 retired the other two former callers, `deleteMessage` and
 * `deleteLoopMessages` — every durable truncate now goes through the exact
 * reindex path instead of this nudge.)
 *
 * Returns a promise (its only caller now runs inside `trackConversationPersistence`'s
 * tracked operation and awaits it) so `waitForConversationPersistence` actually
 * waits for this fallback bump instead of racing ahead of it.
 */
async function bumpCatalogAfterDelete(convId: string, removedCount: number): Promise<void> {
  if (removedCount <= 0) return;
  const { catalogBumpCount } = await import('../core/session/conversationStorage');
  await catalogBumpCount(convId, -removedCount, Date.now(), null).catch(() => {});
}

let flushScheduled = false;

function scheduleFlush() {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    if (tokenBuffer.size === 0 && thinkingBuffer.size === 0) return;
    const tokenEntries = Array.from(tokenBuffer.entries());
    tokenBuffer.clear();
    const thinkingEntries = Array.from(thinkingBuffer.entries());
    thinkingBuffer.clear();
    // Single Zustand set() call to batch all buffered tokens + thinking text
    useChatStore.setState((state) => {
      for (const [key, buffered] of tokenEntries) {
        const { convId, msgId } = parseBufferKey(key);
        const target = findTargetMessage(state.conversations[convId]?.messages, msgId);
        if (target && typeof target.content === 'string') {
          target.content += buffered;
        }
      }
      for (const [key, thinking] of thinkingEntries) {
        const { convId, msgId } = parseBufferKey(key);
        const target = findTargetMessage(state.conversations[convId]?.messages, msgId);
        if (target) target.thinking = thinking;
      }
    });
  });
}

/** Flush any pending buffered tokens AND buffered thinking text immediately
 *  (call before finishStreaming / retry / abort / tool-call batching).
 *  Deliberately covers both buffers in one call — they share the same RAF
 *  cadence and every call site that needs "land buffered stream state now"
 *  needs both, so a single flush covers both without new call sites. */
export function flushTokenBuffer(convId?: string, msgId?: string) {
  const matchingTokenKeys = matchingBufferKeys(tokenBuffer, convId, msgId);
  const matchingThinkingKeys = matchingBufferKeys(thinkingBuffer, convId, msgId);
  if (matchingTokenKeys.length === 0 && matchingThinkingKeys.length === 0) return;
  const tokenEntries = matchingTokenKeys.map((k) => [k, tokenBuffer.get(k)!] as const);
  for (const k of matchingTokenKeys) tokenBuffer.delete(k);
  const thinkingEntries = matchingThinkingKeys.map((k) => [k, thinkingBuffer.get(k)!] as const);
  for (const k of matchingThinkingKeys) thinkingBuffer.delete(k);
  useChatStore.setState((state) => {
    for (const [key, buffered] of tokenEntries) {
      const { convId: cId, msgId: mId } = parseBufferKey(key);
      const target = findTargetMessage(state.conversations[cId]?.messages, mId);
      if (target && typeof target.content === 'string') {
        target.content += buffered;
      }
    }
    for (const [key, thinking] of thinkingEntries) {
      const { convId: cId, msgId: mId } = parseBufferKey(key);
      const target = findTargetMessage(state.conversations[cId]?.messages, mId);
      if (target) target.thinking = thinking;
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
  /** Live retry state (null when not retrying) — drives the "正在重试" strip. */
  retryInfo: RetryInfo | null;
  // Token usage tracking
  currentUsage: TokenUsage | null;
  // Pending input for prefilling the chat input (REPLACES the current draft)
  pendingInput: string | null;
  // Pending input to APPEND to the current draft (does not clobber an
  // in-progress composer draft). Ephemeral one-shot buffer drained by
  // ChatInput. Used only by the inline-widget `window.sendPrompt` bridge —
  // kept separate from pendingInput so other callers keep replace-semantics.
  pendingInputAppend: string | null;
  // Pending agent name — set when starting a chat from an agent surface (toolbox
  // detail panel, agent selector, etc.) so the welcome screen can render an
  // agent-themed intro. Cleared on next startNewConversation or when a real
  // message is added. Ephemeral, not persisted. Stores the agent's registry
  // key (i.e. the same name used for @mention).
  pendingAgentName: string | null;
  // Pending search jump: set when a full-text search hit is picked. ChatView
  // scrolls to and briefly highlights the first message in `convId` whose text
  // contains `query`. Ephemeral one-shot, consumed by ChatView then cleared.
  // NOT persisted.
  pendingSearchJump: { convId: string; query: string } | null;
  // Pending references injected from a doc preview selection toolbar. Ephemeral
  // one-shot buffer (mirrors pendingInput): ChatInput drains it into local
  // state then clears. NOT persisted.
  pendingReferences: ChatReference[];
  // Pending file paths injected from the workspace file tree's "Add to chat"
  // context menu item. Ephemeral one-shot buffer (mirrors pendingReferences):
  // ChatInput drains it into its local files/images attachment state via
  // processFilePaths, then clears. NOT persisted.
  pendingAttachmentPaths: string[];
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
  /** Permission mode selected on the welcome screen before any conversation exists.
   *  Consumed by createConversation() and applied as the new conversation's initial
   *  permissionMode. Does NOT modify the global settingsStore default. Ephemeral. */
  pendingPermissionMode: PermissionMode | undefined;
}

interface ChatActions {
  createConversation: (workspacePath?: string | null, options?: { scheduledTaskId?: string; triggerId?: string; imChannelId?: string; imPlatform?: string; projectId?: string; skipActivate?: boolean }) => string;
  startNewConversation: () => void;
  switchConversation: (id: string) => Promise<void>;
  setConversationWorkspace: (convId: string, path: string | null) => void;
  setConversationProject: (convId: string, projectId: string | undefined) => void;
  setConversationModel: (convId: string, model: { providerId: string; modelId: string } | undefined) => void;
  setConversationPermissionMode: (convId: string, mode: PermissionMode | undefined) => void;
  setPendingPermissionMode: (mode: PermissionMode | undefined) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;

  addMessage: (convId: string, message: Message) => void;
  /** Append a streaming token. If `msgId` is provided, append to that specific message;
   *  otherwise fall back to the last message in the conversation. Pass `msgId` whenever
   *  the agent loop is streaming so mid-stream user messages don't get corrupted. */
  appendToLastMessage: (convId: string, token: string, msgId?: string) => void;
  setLastMessageContent: (convId: string, content: string, msgId?: string) => void;
  finishStreaming: (convId: string, msgId?: string) => void;
  updateToolCall: (convId: string, messageId: string, toolCallId: string, result: string, resultContent?: ToolResultContent[], isError?: boolean, hideScreenshot?: boolean, metadata?: ToolExecutionMetadata) => void;
  /**
   * Persist the user's click on an interactive notice card attached to a
   * tool call (see `ToolCall.noticeCardAction`). Called from the card
   * React component when [采纳] / [拒绝] / [这类别] is clicked. Writes
   * through to disk via replaceMessageById so reload keeps the state.
   */
  setToolCallNoticeCardAction: (convId: string, messageId: string, toolCallId: string, action: NoticeCardAction) => void;
  setToolCallSandboxRecoveryAction: (convId: string, messageId: string, toolCallId: string, action: SandboxRecoveryAction) => Promise<void>;
  setToolCallUserQuestionAnswers: (convId: string, messageId: string, toolCallId: string, answers: UserQuestionResult) => void;
  /**
   * Stash a post-loop proposal signal on the conversation so the next
   * turn's orchestrator can surface a one-shot <consider_sinking> nudge.
   * Ephemeral — not persisted. See `proposalSignal.ts`.
   */
  setPendingProposalSignal: (convId: string, signal: import('../core/agent/proposalSignal').ProposalSignal | undefined) => void;

  // New message operations
  editMessage: (convId: string, messageId: string, newContent: string) => void;
  updateUserMessageRun: (
    convId: string,
    messageId: string,
    patch: {
      state: NonNullable<Message['runState']>;
      error?: string;
      content?: Message['content'];
      skill?: Message['skill'];
      delegateAgent?: Message['delegateAgent'];
    },
  ) => void;
  /**
   * The sole delete/truncate primitive (plan stage 3 — `deleteMessage` and
   * `deleteLoopMessages` are retired). Cuts `messageId` and everything after
   * it from the in-memory slice, then durably persists the cut via
   * `appendTruncateEvent` — see the implementation for the exact wiring and
   * the in-memory-only fallback.
   */
  deleteMessagesFrom: (convId: string, messageId: string) => void;
  updateMessageThinking: (convId: string, thinking: string, msgId?: string) => void;
  updateMessageThinkingDuration: (convId: string, duration: number, msgId?: string) => void;
  updateMessageUsage: (convId: string, usage: TokenUsage, msgId?: string) => void;
  /**
   * Force a specific message's `isStreaming` flag directly (looked up by exact
   * `messageId`, no FALLBACK_LAST fanout like `finishStreaming`/`appendToLastMessage`).
   * Extracted from an agentLoop.ts `useChatStore.setState` escape hatch (the
   * "user enqueued more input while the turn ended without tool calls" rescue
   * path) — kept as a narrow, purpose-specific action rather than generalizing
   * `finishStreaming` because callers here intentionally do NOT want the
   * disk-persistence / agentStatus/retryInfo side effects `finishStreaming` has.
   */
  setMessageStreamingFlag: (convId: string, messageId: string, streaming: boolean) => void;
  /**
   * Atomically attach the finalized tool calls to an assistant message and
   * mark it done streaming, in one mutation. Extracted from a toolExecutor.ts
   * raw `useChatStore.setState` escape hatch (exact `messageId` lookup, no
   * FALLBACK_LAST fanout — same shape as `setMessageStreamingFlag`). The two
   * fields are set together because they represent a single transition (the
   * assistant's streamed response has finished and its tool calls are now
   * known) — splitting them into two calls would let a re-render observe an
   * inconsistent in-between state.
   */
  setMessageToolCalls: (convId: string, messageId: string, toolCalls: ToolCall[]) => void;
  appendToolCallContext: (convId: string, loopId: string, context: ToolCallForContext) => void;
  setExecutionStepsSnapshot: (convId: string, loopId: string, steps: ExecutionStepSnapshot[]) => void;
  setPlannedStepsSnapshot: (convId: string, loopId: string, steps: PlannedStep[]) => void;

  // Streaming control
  getAbortController: (convId: string) => AbortController;
  /** True when a live agent loop holds a controller for this conversation. */
  hasAbortController: (convId: string) => boolean;
  /**
   * `opts.fromSidecarFrame` is set ONLY by frameApplier.ts's special-cased
   * dispatch of the sidecar's own authoritative "stopped" decoration frame
   * (P1-3c-1) — never by a direct caller (Stop button et al). See this
   * action's own doc for the full branching rationale.
   */
  cancelStreaming: (convId: string, opts?: { fromSidecarFrame?: boolean }) => void;
  /**
   * Drop the conversation's registered controller. Pass `owned` to make the
   * clear ownership-checked: a run tearing down asynchronously must not
   * delete a controller that a NEWER run has since registered for the same
   * conversation, which would leave that run's Stop button inert.
   */
  clearAbortController: (convId: string, owned?: AbortController) => void;
  /**
   * Clear a conversation's single-turn-lifecycle skill activation state
   * (`activeSkills`/`activeSkillArgs`). Extracted from an agentLoop.ts
   * `useChatStore.setState` escape hatch inside `deactivateAllSkills()` — the
   * caller still owns the "only mutate if something is active" guard and the
   * `clearAllSkillHooks()` side effect; this action is only the store mutation.
   */
  deactivateConversationSkills: (convId: string) => void;

  setAgentStatus: (status: AgentStatus, tool?: string, agentName?: string) => void;
  setRetryInfo: (info: RetryInfo | null) => void;
  removeActiveAgent: (agentName: string) => void;
  setCurrentUsage: (usage: TokenUsage | null) => void;
  setPendingInput: (text: string | null) => void;
  setPendingSearchJump: (v: { convId: string; query: string } | null) => void;
  appendPendingInput: (text: string | null) => void;
  addPendingReference: (ref: ChatReference) => void;
  clearPendingReferences: () => void;
  addPendingAttachment: (path: string) => void;
  clearPendingAttachments: () => void;
  setPendingAgent: (agentName: string | null) => void;
  setConversationStatus: (convId: string, status: ConversationStatus) => void;
  clearCompletedStatus: (convId: string) => void;

  // MCP per-session toggle
  toggleMCPServer: (convId: string, serverName: string) => void;
  /** Update loaded per-session MCP filters after a custom server rename. */
  renameMCPServerReferences: (oldName: string, newName: string) => void;

  // Context compression cache
  setContextCache: (convId: string, cache: import('../types').ContextCache) => void;
  clearContextCache: (convId: string) => void;
  setContextUsage: (convId: string, usage: NonNullable<Conversation['contextUsage']> | undefined) => void;
  setIsCompressing: (convId: string, value: boolean) => void;

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
    opts?: {
      tier?: import('../core/session/shareBundle').ShareTier;
      signal?: AbortSignal;
      onProgress?: (done: number, total: number) => void;
    },
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
      retryInfo: null,
      currentUsage: null,
      outputsRev: {} as Record<string, number>,
      pendingInput: null,
      pendingInputAppend: null,
      pendingAgentName: null,
      pendingSearchJump: null,
      pendingReferences: [],
      pendingAttachmentPaths: [],
      pendingPermissionMode: undefined,
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
          title: getDefaultConvTitle(),
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
          const initialPermissionMode = state.pendingPermissionMode;
          state.conversations[id] = {
            ...meta,
            messages: [],
            status: 'idle',
            ...(initialPermissionMode ? { permissionMode: initialPermissionMode } : {}),
          };
          state.conversationIndex[id] = meta;
          if (!options?.skipActivate) {
            state.activeConversationId = id;
          }
          state.pendingPermissionMode = undefined;
        });
        // Sync index to disk (fire-and-forget). Also write-through the SQLite
        // catalog (message-storage P0) — best-effort, reconcile is the net.
        import('../core/session/conversationStorage').then(({ updateIndexEntry, catalogUpsertConversation }) => {
          updateIndexEntry(meta).catch(() => {});
          catalogUpsertConversation(meta).catch(() => {});
        });
        // Sync global workspace to match the new conversation.
        // Clear when no workspace so UI doesn't show a stale path from a previous conversation.
        if (!options?.skipActivate) {
          if (workspacePath) {
            useWorkspaceStore.getState().setWorkspace(workspacePath);
          } else {
            useWorkspaceStore.getState().clearWorkspace();
          }
        }
        return id;
      },

      startNewConversation: () => {
        set((state) => {
          state.activeConversationId = null;
          state.pendingAgentName = null;
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
          if (state.conversationIndex[convId]) {
            state.conversationIndex[convId].workspacePath = path;
          }
        });
        // Persist to disk index — mirrors setConversationProject
        import('../core/session/conversationStorage').then(({ updateIndexEntry }) => {
          const meta = get().conversationIndex[convId];
          if (meta) updateIndexEntry(meta).catch(() => {});
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

      // Pin a model to a conversation (undefined = clear → inherit global).
      // Mirrors setConversationProject: updates both the loaded conversation and
      // the index entry, then persists to disk. agentLoop reads conv.model first
      // and pins on first run; the ModelSelector writes it on explicit pick.
      setConversationModel: (convId, model) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.model = model;
          }
          if (state.conversationIndex[convId]) {
            state.conversationIndex[convId].model = model;
          }
        });
        // Persist to disk index
        import('../core/session/conversationStorage').then(({ updateIndexEntry }) => {
          const meta = get().conversationIndex[convId];
          if (meta) updateIndexEntry(meta).catch(() => {});
        });
      },

      setConversationPermissionMode: (convId, mode) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.permissionMode = mode;
          }
        });
      },

      setPendingPermissionMode: (mode) => {
        set((state) => {
          state.pendingPermissionMode = mode;
        });
      },

      deleteConversation: (id) => {
        // P1-3c-2 (design doc §3 change 3 / P1-3C-SCOUT-REPORT.md §5
        // "secondary finding"): this abort MUST run before the `conversations`/
        // `conversationIndex` deletion below — verified still true, not just
        // assumed. `controller` here is the SAME AbortController instance
        // `agentLoopRunner.ts`'s `runAgentLoopDispatched` registers into via
        // `getAbortRegistry().getAbortController(conversationId)` (both read
        // through this module's `abortControllers` Map), so `.abort()` fires
        // that file's `onShellAbort` listener → the acknowledged
        // `agent.abort { runId }` request, the exact same signal the Stop
        // button (`cancelStreaming`) sends. This synchronous store action
        // cannot await that ACK, so the sidecar can still be mid-flight on a
        // `tool.invoke` when the record is erased. `handleMainLoopToolInvoke`
        // (agentLoopRunner.ts) closes that
        // residual window by refusing to execute a tool once the conversation
        // record here is gone, so the ordering below (abort, THEN erase) is
        // sufficient — no need to await the sidecar ACK here (would require making
        // this action async, breaking its synchronous call contract).
        //
        // Cancel any ongoing streaming for this conversation
        const controller = abortControllers.get(id);
        if (controller) {
          controller.abort();
          abortControllers.delete(id);
        }
        // Clean up per-conversation state in external modules
        clearInputQueue(id);
        clearSkillHooksByConversation(id);
        resetSessionPromotions(id);
        useTaskExecutionStore.getState().clearConversation(id);
        clearConversationComposerDraft(
          id,
          getComposerDraftScopeForEnterpriseMode(useEnterpriseStore.getState().mode),
        );
        // Clean up disk files (JSONL messages, tool results, outputs)
        import('../core/session/conversationStorage').then(({ deleteConversationFiles, removeIndexEntry, catalogMarkMissing }) => {
          deleteConversationFiles(id).catch(() => {});
          removeIndexEntry(id).catch(() => {});
          // Write-through the SQLite catalog: soft-delete the row (message-
          // storage P0). Best-effort; reconcile also marks it missing once the
          // JSONL is gone.
          catalogMarkMissing(id).catch(() => {});
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
        // Drain pending ask_user_question for this conversation on delete.
        import('../core/agent/permissionBridge').then(({ drainUserQuestionsForConversation }) => {
          drainUserQuestionsForConversation(id);
        }).catch(() => {});
        // Clear plan mode state to prevent the module-level Map from leaking
        // an entry for a conversation that no longer exists.
        clearPlanMode(id);
        const wasActive = get().activeConversationId === id;
        // Compute the successor BEFORE the deletion mutates state, so the
        // helper can see the deleted entry's scope (projectId / scheduledTaskId
        // / triggerId) and pick a neighbor from the same section. Computing
        // post-delete would lose that scope info.
        const nextActiveId = wasActive
          ? findNextActiveConversation(get().conversationIndex, id)
          : null;
        set((state) => {
          delete state.conversations[id];
          delete state.conversationIndex[id];
          if (state.activeConversationId === id) {
            state.activeConversationId = nextActiveId;
          }
        });
        // Clear any notice badge attached to the deleted conversation —
        // the conv no longer exists, leaving the count would just leak
        // (compounded by clearAll being keyed on conv id).
        import('./noticeBadgeStore').then(({ useNoticeBadgeStore }) => {
          useNoticeBadgeStore.getState().clear(id);
        }).catch(() => {});
        // The successor active conv: lazy-load model means messages may not
        // be in `conversations` yet, leaving ChatView stuck on the skeleton
        // until the user clicks the conv manually. Mirror what
        // switchConversation does on click: load + clear that conv's badge
        // (otherwise a stale notification badge would carry into the new
        // active view).
        if (nextActiveId) {
          if (!get().conversations[nextActiveId]) {
            get().loadConversation(nextActiveId).catch((err) => {
              console.warn('[chatStore] failed to load successor after delete:', err);
            });
          }
          import('./noticeBadgeStore').then(({ useNoticeBadgeStore }) => {
            useNoticeBadgeStore.getState().clear(nextActiveId);
          }).catch(() => {});
        }
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
        import('../core/session/conversationStorage').then(({ updateIndexEntry, catalogReindexConversation }) => {
          const meta = get().conversationIndex[id];
          // Live-freshness write-through (message-storage hybrid P2): re-index
          // this conversation's FTS title immediately so the new title is
          // searchable without waiting for the next startup reconcile.
          // Fire-and-forget — catalogReindexConversation already swallows its
          // own errors.
          //
          // Chained AFTER updateIndexEntry resolves (fix #4): updateIndexEntry
          // itself awaits loadIndex() before mutating indexCache, so firing
          // catalogReindexConversation concurrently could let its own
          // flushIndex() serialize indexCache to disk before updateIndexEntry
          // has written the new title into it — the Rust-side reindex would
          // then read the STALE on-disk title. Sequencing guarantees the new
          // title is in indexCache before catalogReindexConversation's
          // flushIndex runs.
          if (meta) {
            updateIndexEntry(meta)
              .then(() => catalogReindexConversation(id))
              .catch(() => {});
          } else {
            catalogReindexConversation(id).catch(() => {});
          }
        });
      },

      addMessage: (convId, message) => {
        let newTitle: string | undefined;
        set((state) => {
          // Clear expert intro banner once the conversation has any real
          // content — welcome screen is gone, banner has nothing to render on.
          if (state.pendingAgentName) state.pendingAgentName = null;
          const conv = state.conversations[convId];
          if (conv) {
            conv.messages.push(message);
            conv.updatedAt = Date.now();
            // Auto-title from first user message
            if (conv.title === getDefaultConvTitle() && message.role === 'user') {
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
            // Sync index metadata. messageCount is RE-DERIVED from
            // conv.messages.length, not incremented (message-storage P0,
            // code-review fix #1): in P0 there is no partial load, so
            // conv.messages is always the full history. Re-derivation is
            // both correct AND self-healing across deletes/edits/retries —
            // deleteMessagesFrom mutates conv.messages but never adjusts
            // conversationIndex.messageCount itself, so an increment-only
            // counter drifts upward forever while re-derivation always
            // reflects reality.
            if (state.conversationIndex[convId]) {
              state.conversationIndex[convId].messageCount = conv.messages.length;
              state.conversationIndex[convId].updatedAt = conv.updatedAt;
              if (newTitle) state.conversationIndex[convId].title = newTitle;
            }
          }
        });
        // Async write to disk (non-blocking for rendering, tracked so a
        // sidecar run can establish a durability barrier before it settles).
        trackConversationPersistence(
          convId,
          () => import('../core/session/conversationStorage').then(async ({
            appendMessage: diskAppend,
            updateIndexEntry,
          }) => {
            await diskAppend(convId, message);
            // Always persist updated index (messageCount, updatedAt, and title if changed)
            const meta = get().conversationIndex[convId];
            if (meta) await updateIndexEntry(meta);
          }),
        );
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
          state.retryInfo = null;
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
            trackConversationPersistence(
              convId,
              () => import('../core/session/conversationStorage').then(({ replaceMessageById }) =>
                replaceMessageById(convId, finalMsg)
              ),
            );
          } else {
            trackConversationPersistence(
              convId,
              () => import('../core/session/conversationStorage').then(({ updateLastMessage }) =>
                updateLastMessage(convId, finalMsg)
              ),
            );
          }
        }
      },

      updateToolCall: (convId, messageId, toolCallId, result, resultContent, isError, hideScreenshot, metadata) => {
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

              if (
                tc.name === TOOL_NAMES.RUN_COMMAND
                && metadata?.sandboxRecovery
              ) {
                tc.sandboxRecovery = metadata.sandboxRecovery;
                tc.isError = true;
              }
            }
          }
        });
        // Persist the updated tool result immediately. Without this, tool results
        // only hit disk when finishStreaming / turn-boundary replaceMessageById fires —
        // so a crash/force-quit mid-stream (or a late-arriving result after the
        // enclosing message was already snapshotted) loses toolCalls on reload.
        //
        // This goes to the stream snapshot rather than the ledger: it fires once
        // per tool result, and each write carries the whole message including
        // every earlier result, so appending here would cost O(N²) bytes within
        // a single tool-heavy turn. The turn-boundary checkpoint in agentLoop is
        // what commits the batch to the ledger.
        const updatedMsg = get().conversations[convId]?.messages.find((m) => m.id === messageId);
        if (updatedMsg) {
          import('../core/session/conversationStorage').then(({ snapshotMessageRevision }) => {
            snapshotMessageRevision(convId, updatedMsg).catch(() => {});
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

      setToolCallSandboxRecoveryAction: async (convId, messageId, toolCallId, action) => {
        const currentMsg = get().conversations[convId]?.messages.find((m) => m.id === messageId);
        const currentToolCall = currentMsg?.toolCalls?.find((t) => t.id === toolCallId);
        if (!currentMsg || !currentToolCall?.sandboxRecovery) {
          throw new Error(`Sandbox recovery tool call "${toolCallId}" no longer exists`);
        }
        const persistedMsg: Message = {
          ...currentMsg,
          toolCalls: currentMsg.toolCalls?.map((toolCall) =>
            toolCall.id === toolCallId
              ? { ...toolCall, sandboxRecoveryAction: action }
              : toolCall
          ),
        };
        const { replaceMessageByIdStrict } = await import('../core/session/conversationStorage');
        await replaceMessageByIdStrict(convId, persistedMsg);

        let updated = false;
        set((state) => {
          const msg = state.conversations[convId]?.messages.find((m) => m.id === messageId);
          const tc: ToolCall | undefined = msg?.toolCalls?.find((t) => t.id === toolCallId);
          if (tc?.sandboxRecovery) {
            tc.sandboxRecoveryAction = action;
            updated = true;
          }
        });
        if (!updated) {
          throw new Error(`Sandbox recovery tool call "${toolCallId}" no longer exists`);
        }
      },

      setToolCallUserQuestionAnswers: (convId, messageId, toolCallId, answers) => {
        set((state) => {
          const msg = state.conversations[convId]?.messages.find((m) => m.id === messageId);
          const tc: ToolCall | undefined = msg?.toolCalls?.find((t) => t.id === toolCallId);
          if (tc) {
            tc.userQuestionAnswers = answers;
          }
        });
        const updatedMsg = get().conversations[convId]?.messages.find((m) => m.id === messageId);
        if (updatedMsg) {
          import('../core/session/conversationStorage').then(({ replaceMessageById }) => {
            replaceMessageById(convId, updatedMsg).catch(() => {});
          });
        }
      },

      // New message operations
      updateUserMessageRun: (convId, messageId, patch) => {
        let updatedMessage: Message | undefined;
        set((state) => {
          const conv = state.conversations[convId];
          const message = conv?.messages.find((candidate) => candidate.id === messageId);
          if (!conv || !message || message.role !== 'user') return;

          message.runState = patch.state;
          if (TERMINAL_RUN_STATES.has(patch.state)) {
            message.runEndedAt ??= Date.now();
          } else {
            delete message.runEndedAt;
          }
          if (patch.error) message.runError = patch.error;
          else delete message.runError;
          if ('content' in patch && patch.content !== undefined) message.content = patch.content;
          if ('skill' in patch) message.skill = patch.skill;
          if ('delegateAgent' in patch) message.delegateAgent = patch.delegateAgent;
          conv.updatedAt = Date.now();
          conv.contextCache = undefined;
          // `current`, not a spread: `message` is an immer draft, and a shallow
          // copy keeps nested values (a multimodal `content` ARRAY) as draft
          // proxies that are revoked the moment this producer returns. The
          // tracked persistence below then serializes a revoked proxy —
          // "Cannot perform 'IsArray' on a proxy that has been revoked" — so
          // every runState revision for an image-carrying row failed to
          // persist and the ledger showed the run stuck at `pending`.
          updatedMessage = current(message);
        });

        if (!updatedMessage) return;
        const messageToPersist = updatedMessage;
        trackConversationPersistence(
          convId,
          () => import('../core/session/conversationStorage').then(({ replaceMessageByIdStrict }) =>
            replaceMessageByIdStrict(convId, messageToPersist),
          ),
        );
      },

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

      deleteMessagesFrom: (convId, messageId) => {
        let removedIds: string[] = [];
        let survivingTailId: string | undefined;
        let metaToPersist: ConversationMeta | undefined;
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            const idx = conv.messages.findIndex((m) => m.id === messageId);
            if (idx !== -1) {
              removedIds = conv.messages.slice(idx).map((m) => m.id);
              // The id of the last message SURVIVING the cut — omitted (left
              // undefined) when truncating from the conversation's first
              // message (plan §3.2's `pid` definition).
              survivingTailId = idx > 0 ? conv.messages[idx - 1].id : undefined;
              conv.messages = conv.messages.slice(0, idx);
              conv.updatedAt = Date.now();
              conv.contextCache = undefined;  // Invalidate compression cache
              const meta = state.conversationIndex[convId];
              if (meta) {
                meta.messageCount = conv.messages.length;
                meta.updatedAt = conv.updatedAt;
                // `current`, not a spread: same revoked-draft hazard as
                // updateUserMessageRun above — `meta.model` is a nested object,
                // so a shallow copy of the draft hands the async persistence a
                // child proxy that is revoked when this producer returns.
                metaToPersist = current(meta);
              }
            }
          }
        });
        if (removedIds.length === 0) return;
        const finalMeta = metaToPersist;
        const pid = survivingTailId;
        const removedCount = removedIds.length;
        // Durable persistence (plan stage 3): appendTruncateEvent decides
        // whether there is anything on disk to cut. When it durably writes
        // the event, catalogReindexConversation derives an EXACT count from
        // the folded ledger — no approximate bump needed. When it reports
        // nothing durable (a pure in-memory ghost never appended to disk),
        // there is no ledger event and thus nothing for a reindex to
        // reconcile, so fall back to the same approximate display-level nudge
        // the retired deleteMessage's skipCatalogBump path used to apply.
        trackConversationPersistence(
          convId,
          () => import('../core/session/conversationStorage').then(async ({
            appendTruncateEvent,
            updateIndexEntry,
            catalogReindexConversation,
          }) => {
            const wrote = await appendTruncateEvent(convId, messageId, { pid, removedIds });
            if (wrote) {
              if (finalMeta) await updateIndexEntry(finalMeta);
              await catalogReindexConversation(convId);
            } else {
              await bumpCatalogAfterDelete(convId, removedCount);
            }
          }),
        );
      },

      updateMessageThinking: (convId, thinking, msgId) => {
        // Buffer and flush once per animation frame, mirroring
        // appendToLastMessage's tokenBuffer — the OpenAI-compatible adapter's
        // reasoning models (DeepSeek-R1 style) emit one `thinking` event per
        // SSE chunk, which without batching means one React re-render per
        // chunk. REPLACE (not append) semantics: `thinking` here is already
        // the full accumulated text for this call (see thinkingBuffer's
        // doc comment above), so the buffer just remembers the latest value.
        const key = bufferKey(convId, msgId);
        thinkingBuffer.set(key, thinking);
        scheduleFlush();
      },

      updateMessageThinkingDuration: (convId, duration, msgId) => {
        // Flush first: thinkingDuration marks the thinking step "done" in the
        // UI, so any still-buffered thinking text must land before the
        // duration freezes — otherwise the step reads as complete while its
        // final text tail hasn't rendered yet. flushTokenBuffer covers the
        // thinking buffer as well as the token buffer (see its doc comment).
        flushTokenBuffer(convId, msgId);
        set((state) => {
          const target = findTargetMessage(
            state.conversations[convId]?.messages,
            msgId ?? FALLBACK_LAST,
          );
          if (target) target.thinkingDuration = duration;
        });
      },

      setMessageStreamingFlag: (convId, messageId, streaming) => {
        set((state) => {
          const msg = state.conversations[convId]?.messages.find((m) => m.id === messageId);
          if (msg) msg.isStreaming = streaming;
        });
      },

      setMessageToolCalls: (convId, messageId, toolCalls) => {
        set((state) => {
          const msg = state.conversations[convId]?.messages.find((m) => m.id === messageId);
          if (msg) {
            msg.toolCalls = toolCalls;
            msg.isStreaming = false;
          }
        });
        // Persist the *intent* immediately, for the same reason updateToolCall
        // persists the result: this call clears isStreaming, which switches off
        // the streaming snapshot loop, so without an explicit write the pending
        // tool calls would not reach disk until the batch finishes. A crash
        // between here and that point would replay as "the model never called
        // anything" even though a side effect (rm, write_file, an API call) had
        // already run — the recovery path could not tell "not started" from
        // "started, unrecorded", and a retry would execute it twice.
        //
        // Same routing as updateToolCall: this is mid-turn state, so it belongs
        // in the stream snapshot (durable, folded in on load) rather than as a
        // permanent ledger line that the batch checkpoint would supersede
        // seconds later anyway.
        const updatedMsg = get().conversations[convId]?.messages.find((m) => m.id === messageId);
        if (updatedMsg) {
          import('../core/session/conversationStorage').then(({ snapshotMessageRevision }) => {
            snapshotMessageRevision(convId, updatedMsg).catch(() => {});
          });
        }
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
        let targetMsgId: string | undefined;
        set((state) => {
          const conv = state.conversations[convId];
          if (!conv) return;
          // Find the last assistant message with this loopId (scan backward, no copy)
          for (let i = conv.messages.length - 1; i >= 0; i--) {
            const m = conv.messages[i];
            if (m.role === 'assistant' && m.loopId === loopId) {
              m.executionSteps = steps;
              targetMsgId = m.id;
              break;
            }
          }
        });
        // Persist to disk so execution steps survive conversation reload.
        // finishStreaming writes the message before the snapshot exists, so we
        // must explicitly re-persist here — same pattern as updateToolCall.
        if (targetMsgId) {
          const msg = get().conversations[convId]?.messages.find((m) => m.id === targetMsgId);
          if (msg) {
            import('../core/session/conversationStorage').then(({ replaceMessageById }) => {
              replaceMessageById(convId, msg).catch(() => {});
            }).catch(() => {});
          }
        }
      },

      setPlannedStepsSnapshot: (convId, loopId, steps) => {
        let targetMsgId: string | undefined;
        set((state) => {
          const conv = state.conversations[convId];
          if (!conv) return;
          for (let i = conv.messages.length - 1; i >= 0; i--) {
            const m = conv.messages[i];
            if (m.role === 'assistant' && m.loopId === loopId) {
              m.plannedSteps = steps;
              targetMsgId = m.id;
              break;
            }
          }
        });
        if (targetMsgId) {
          const msg = get().conversations[convId]?.messages.find((m) => m.id === targetMsgId);
          if (msg) {
            import('../core/session/conversationStorage').then(({ replaceMessageById }) => {
              replaceMessageById(convId, msg).catch(() => {});
            }).catch(() => {});
          }
        }
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

      hasAbortController: (convId) => abortControllers.has(convId),

      cancelStreaming: (convId, opts) => {
        // P1-3c-1 (design doc §3, "conversation-authority"): while a
        // sidecar-hosted run owns this conversation, it remains authoritative
        // for in-flight frames. A direct Stop therefore cannot decorate
        // immediately: `agentLoopRunner` first obtains an ordered abort ACK
        // (the sidecar flushes its frame coalescer before replying), closes
        // the late-frame gate, then calls this action again with
        // `opts.fromSidecarFrame: true`. The sidecar's normal abort catch may
        // also emit the same frame; the full path below is idempotent, so both
        // the healthy and 5s force-finalize paths converge safely.
        //
        // `opts.fromSidecarFrame` always takes the full path below
        // unconditionally — that call IS the authoritative decoration, not a
        // second guess of it, so no registry re-check is needed (and would
        // be wrong: by the time the frame applies, the RunSession this
        // predicate reads is typically STILL registered — unregistration
        // only happens after the `agent.run` RPC resolves, which is later).
        //
        // A direct call (Stop button or any other in-process caller;
        // `opts` undefined) checks `isConversationRunningInSidecar` — if a
        // sidecar run is live, it must NOT also mutate/persist here (that
        // would race the sidecar's own trailing frames); it only signals
        // abort, retains ownership, clears its UI-only overlay, and returns.
        if (!opts?.fromSidecarFrame && isConversationRunningInSidecar(convId)) {
          const controller = abortControllers.get(convId);
          if (controller) {
            controller.abort();
          }
          // Keep the controller registered until the sidecar ACK (or the
          // shell's force-finalize watchdog) reaches the full path below.
          // Deleting it here used to abandon run ownership while the
          // `agent.run` RPC could remain pending forever, leaving the UI on
          // "thinking" with no controller/session able to finish cleanup.
          // Pass convId — see computerUseStatus.ts's ownership guard doc: a
          // stale deactivate must never clobber a DIFFERENT conversation's
          // now-active CU session.
          setComputerUseActive(false, convId);
          import('@tauri-apps/api/core').then(({ invoke }) => {
            invoke('hide_screen_border').catch(() => {});
            invoke('window_show').catch(() => {});
          }).catch(() => {});
          return;
        }

        // Land any RAF-buffered stream tokens first, so the stop marker below
        // is appended AFTER the streamed text (and both get persisted). The
        // stop button reaches here before the aborted loop's own flush runs.
        flushTokenBuffer(convId);

        const controller = abortControllers.get(convId);
        if (controller) {
          controller.abort();
          abortControllers.delete(convId);
        }
        // Clean up Computer Use overlay and status on abort (synchronous
        // imports for reliability). Pass convId — see computerUseStatus.ts's
        // ownership guard doc.
        setComputerUseActive(false, convId);
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke('hide_screen_border').catch(() => {});
          invoke('window_show').catch(() => {});
        }).catch(() => {});

        let cancelledMsgId: string | null = null;
        set((state) => {
          const messages = state.conversations[convId]?.messages;
          if (messages?.length) {
            const lastMsg = messages[messages.length - 1];
            // Persist only when the stop actually mutated the message (marker
            // appended / thinkingDuration finalized / tool calls cancelled).
            // A pure isStreaming flip on an empty placeholder must NOT write:
            // the agentLoop abort path deletes that ghost afterwards, and
            // persisting a marker-only row would resurrect it on reload.
            let mutated = false;
            if (lastMsg.isStreaming) {
              lastMsg.isStreaming = false;
              const hasVisibleActivity =
                (typeof lastMsg.content === 'string'
                  ? lastMsg.content.trim().length > 0
                  : lastMsg.content.some((part) => part.type === 'text' && part.text.trim().length > 0))
                || !!lastMsg.thinking?.trim()
                || !!lastMsg.toolCalls?.length
                || !!lastMsg.toolCallsForContext?.length;
              // Persist a compatibility stop terminal on assistant activity.
              // The canonical run terminal now lives on the user message's
              // `runState`; this field keeps older transcripts and tool-only
              // turns readable without injecting presentation text into content.
              if (hasVisibleActivity && lastMsg.stopReason !== 'user') {
                lastMsg.stopReason = 'user';
                mutated = true;
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
              mutated = true;
            }
            // Mark any executing tool calls as cancelled
            if (lastMsg.toolCalls) {
              lastMsg.toolCalls.forEach((tc) => {
                if (tc.isExecuting) {
                  tc.isExecuting = false;
                  tc.result = getI18n().task.cancelled;
                  mutated = true;
                }
              });
            }
            if (mutated) cancelledMsgId = lastMsg.id;
          }
          state.agentStatus = 'idle';
          state.currentTool = null;
          state.retryInfo = null;
          state.thinkingStartTime = null;
        });

        // Persist the stop mutation (terminal + cancelled tool calls) — without
        // this the live view shows "已停止" while reload shows the pre-stop
        // JSONL snapshot (often a blank bubble).
        //
        // MUST go through trackConversationPersistence, not a bare
        // fire-and-forget: the assistant placeholder's own append (addMessage's
        // diskAppend) rides that per-conversation serial queue, and under load
        // it can still be in flight when Stop lands. An untracked
        // replaceMessageById then overtakes the append, finds no row on disk,
        // and hits the upsert guard's silent no-op (`id-not-found`) — the
        // placeholder lands moments later as a permanent content:"" ghost and
        // the visible partial reply is durably lost. frameApplier.ts defends
        // its session replacements against exactly this with
        // waitForConversationPersistence; chaining onto the tracked queue
        // gives this path the same ordering AND makes the write visible to
        // finalizeAbortedRun's durability barrier.
        if (cancelledMsgId) {
          const finalMsg = useChatStore.getState().conversations[convId]
            ?.messages.find((m) => m.id === cancelledMsgId);
          if (finalMsg) {
            trackConversationPersistence(
              convId,
              () => import('../core/session/conversationStorage').then(({ replaceMessageById }) =>
                replaceMessageById(convId, finalMsg)
              ),
            );
          }
        }
      },

      clearAbortController: (convId, owned) => {
        if (owned && abortControllers.get(convId) !== owned) return;
        abortControllers.delete(convId);
      },

      deactivateConversationSkills: (convId) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            conv.activeSkills = [];
            conv.activeSkillArgs = {};
          }
        });
      },

      setRetryInfo: (info) => {
        set((state) => {
          state.retryInfo = info;
        });
      },

      setAgentStatus: (status, tool, agentName) => {
        set((state) => {
          state.agentStatus = status;
          state.currentTool = tool ?? null;
          // A resumed stream (any non-retry status) means a prior retry
          // succeeded — clear the retry strip so it doesn't linger.
          if (status !== 'rate-limited') {
            state.retryInfo = null;
          }
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

      setPendingSearchJump: (v) => {
        set((state) => {
          state.pendingSearchJump = v;
        });
      },

      appendPendingInput: (text) => {
        set((state) => {
          state.pendingInputAppend = text;
        });
      },

      addPendingReference: (ref) => {
        set((state) => {
          state.pendingReferences.push(ref);
        });
      },

      clearPendingReferences: () => {
        set((state) => {
          state.pendingReferences = [];
        });
      },

      addPendingAttachment: (path) => {
        set((state) => {
          // Dedup: "Add to chat" on the same file twice (before the drain runs)
          // must not buffer it twice — images carry no path once decoded, so the
          // ChatInput drain can't dedup them downstream.
          if (!state.pendingAttachmentPaths.includes(path)) {
            state.pendingAttachmentPaths.push(path);
          }
        });
      },

      clearPendingAttachments: () => {
        set((state) => {
          state.pendingAttachmentPaths = [];
        });
      },

      setPendingAgent: (agentName) => {
        set((state) => {
          state.pendingAgentName = agentName;
        });
      },

      setConversationStatus: (convId, status) => {
        let shouldReindex = false;
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) {
            const prevStatus = conv.status;
            // Fix #2: 'error' is also a terminal state — the user message +
            // partial assistant reply are already appended to messages.jsonl
            // by the time a turn ends in error, but without this the
            // conversation was never indexed until the next restart.
            const isTerminal = status === 'completed' || status === 'error';
            // Fix #5: only fire when the conversation actually exists AND is
            // transitioning INTO a terminal state — not on a redundant
            // re-set of a status it's already in (e.g. a duplicate
            // 'completed' call), and never for a convId absent from state.
            shouldReindex = isTerminal && prevStatus !== status;
            conv.status = status;
            if (status === 'completed') {
              conv.completedAt = Date.now();
            } else {
              conv.completedAt = undefined;
            }
          }
        });
        // Live-freshness write-through (message-storage hybrid P2): turn-end
        // is the moment a conversation's messages are settled for this round,
        // so re-index its catalog row + FTS body now instead of waiting for
        // the next startup reconcile. Fire-and-forget, matches the existing
        // dynamic-import + .catch(()=>{}) pattern used elsewhere in this
        // store — never await inside the reducer.
        if (shouldReindex) {
          import('../core/session/conversationStorage').then(({ catalogReindexConversation }) => {
            catalogReindexConversation(convId).catch(() => {});
          });
        }
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

      renameMCPServerReferences: (oldName, newName) => {
        if (!oldName || !newName || oldName === newName) return;
        set((state) => {
          for (const conv of Object.values(state.conversations)) {
            if (!conv.enabledMCPServers?.includes(oldName)) continue;
            conv.enabledMCPServers = Array.from(new Set(
              conv.enabledMCPServers.map((name) => name === oldName ? newName : name),
            ));
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
      setContextUsage: (convId, usage) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) conv.contextUsage = usage;
        });
      },
      setIsCompressing: (convId, value) => {
        set((state) => {
          const conv = state.conversations[convId];
          if (conv) conv.isCompressing = value;
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
            messages: conv.messages.map(sanitizeImportedMessage),
          };

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
        return buildShareBundle(conv, {
          tier: opts.tier ?? 'standard',
          signal: opts.signal,
          onProgress: opts.onProgress,
        });
      },

      // ── Persistence: load conversation from disk on demand ──

      loadConversation: async (convId: string) => {
        // Already loaded
        if (get().conversations[convId]) return;
        // Not in index
        if (!get().conversationIndex[convId]) return;

        try {
          const { loadMessages, replaceMessageById } = await import('../core/session/conversationStorage');
          const loadedMessages = await loadMessages(convId);
          const messages = sanitizeLoadedMessages(loadedMessages);
          const meta = get().conversationIndex[convId];
          if (!meta) return;

          const recoveredMessages = messages.filter((message, index) => (
            message.role === 'user'
            && message.runState === 'failed'
            && ACTIVE_RUN_STATES.has(loadedMessages[index]?.runState)
          ));
          set((state) => {
            state.conversations[convId] = {
              id: meta.id,
              title: meta.title,
              createdAt: meta.createdAt,
              updatedAt: meta.updatedAt,
              messages,
              status: 'idle',
              workspacePath: meta.workspacePath,
              model: meta.model,
              imChannelId: meta.imChannelId,
              imPlatform: meta.imPlatform,
              scheduledTaskId: meta.scheduledTaskId,
              triggerId: meta.triggerId,
              projectId: meta.projectId,
              readOnly: meta.readOnly,
              importedFrom: meta.importedFrom,
            };
          });

          // Recovery persistence is best-effort. The sanitized in-memory
          // conversation must remain available even if a disk replacement
          // fails (for example, a transient permission or I/O error). A
          // failed repair must never fall through to the outer load catch
          // and replace a successfully-read conversation with an empty one.
          await Promise.allSettled(
            recoveredMessages.map((message) => replaceMessageById(convId, message)),
          );
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
                model: meta.model,
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
      version: 7,
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        // v1 → v2: added executionSteps on Message (optional field, no-op migration)
        if (version < 2) { /* no transform needed */ }
        // v2 → v3: added projectId on Conversation (optional field, no-op migration)
        if (version < 3) { /* no transform needed */ }
        // v4 → v5: added readOnly + importedFrom on ConversationMeta (optional fields, no-op migration)
        if (version < 5) { /* no transform needed */ }
        // v5 → v6: added per-conversation `model` on ConversationMeta (optional field;
        // undefined = inherit global activeModel, pinned on first run, no-op migration)
        if (version < 6) { /* no transform needed */ }
        // v6 → v7: added compact-boundary markers (long-conversation Part A).
        // Markers are plain append-only Messages with an optional `compactBoundary`
        // payload — persisted state (conversationIndex) is unchanged, so this is a
        // no-op bump that just guards against older builds mis-reading the schema.
        if (version < 7) { /* no transform needed */ }
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
