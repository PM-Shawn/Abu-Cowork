import { useChatStore, flushTokenBuffer } from '@/stores/chatStore';
import type {
  Message,
  ToolCall,
  ToolResultContent,
  TokenUsage,
  ToolCallForContext,
  ConversationStatus,
  AgentStatus,
  RetryInfo,
  ContextCache,
  Conversation,
  ToolExecutionMetadata,
} from '@/types';
import type { ExecutionStepSnapshot, PlannedStep } from '@/types/execution';
import type { ProposalSignal } from '../proposalSignal';
import { createPortSlot } from './portSlot';

/**
 * Port abstracting agentLoop's WRITES to chatStore's streaming family, plus
 * the two named actions reclaimed from raw `useChatStore.setState` escape
 * hatches (see chatStore.ts's `deactivateConversationSkills` /
 * `setMessageStreamingFlag`).
 *
 * This is the write-side counterpart to `SettingsReader` (see
 * `settingsReader.ts`) — same shape philosophy (minimal, no caching, each
 * call independently forwards to the live store at call time), but for
 * *mutations* instead of a single read snapshot. The streaming family below
 * is deliberately named after the eventual out-of-process contract
 * (`appendText`/`appendThinking`/`flushTokens`/...) rather than mirroring
 * chatStore's action names 1:1 — this is the hot path a future headless
 * Node runtime would ship as batched frames over IPC/RPC back to the UI
 * process, so the port's vocabulary is its own, not chatStore's.
 *
 * IMPORTANT: token batching (the RAF-scheduled buffer in chatStore.ts) stays
 * exactly where it is. This port does not re-implement or move that
 * mechanism — `flushTokens` just forwards to the existing exported
 * `flushTokenBuffer()` function. Frame-based batching for a real
 * out-of-process channel is a separate, later concern (see
 * CHAT-PROBE-REPORT.md §7 for the extrapolation).
 *
 * ── Discrete family (below) ──────────────────────────────────────────────
 * Unlike the streaming family, these are low-frequency, one-shot writes (one
 * call per tool result / status change / turn boundary, not per-token). The
 * CHAT-PROBE-REPORT.md §3 lesson was that renaming the streaming family cost
 * real per-call-site translation effort during conversion; for this batch of
 * infrequent, one-off calls that translation cost isn't worth paying, so
 * these methods deliberately MIRROR their chatStore action names 1:1 instead
 * of inventing new vocabulary. This is a judgment call, not an oversight: if
 * a future out-of-process contract needs these to mean something different
 * cross-process (e.g. batching several into one frame), rename then — don't
 * pre-rename speculatively now.
 */
export interface ChatDelta {
  // ── Streaming family (hot path — the future cross-process batching seam) ──
  /** Mirrors chatStore's `appendToLastMessage`. */
  appendText(convId: string, token: string, msgId?: string): void;
  /** Mirrors chatStore's `setLastMessageContent`. */
  setLastMessageContent(convId: string, content: string, msgId?: string): void;
  /** Mirrors chatStore's `updateMessageThinking`. */
  appendThinking(convId: string, thinking: string, msgId?: string): void;
  /** Mirrors chatStore's `updateMessageThinkingDuration`. */
  setThinkingDuration(convId: string, duration: number, msgId?: string): void;
  /** Mirrors the module-level `flushTokenBuffer()` export (not a store action). */
  flushTokens(convId?: string, msgId?: string): void;
  /** Mirrors chatStore's `finishStreaming`. */
  finishStreaming(convId: string, msgId?: string): void;
  /**
   * Mirrors chatStore's `cancelStreaming`. `opts.fromSidecarFrame` is set
   * ONLY by frameApplier.ts's special-cased dispatch of the sidecar's own
   * authoritative "stopped" decoration frame (P1-3c-1) — see chatStore.ts's
   * `cancelStreaming` doc and
   * docs/2026-07-21-phase1-p3c-conversation-authority-design.md §3.
   */
  cancelStreaming(convId: string, opts?: { fromSidecarFrame?: boolean }): void;

  // ── Reclaimed named actions (formerly raw setState escapes) ──
  /** Mirrors chatStore's `deactivateConversationSkills`. */
  deactivateSkills(convId: string): void;
  /** Mirrors chatStore's `setMessageStreamingFlag`. */
  setMessageStreamingFlag(convId: string, messageId: string, streaming: boolean): void;
  /** Mirrors chatStore's `setMessageToolCalls`. */
  setMessageToolCalls(convId: string, messageId: string, toolCalls: ToolCall[]): void;

  // ── Discrete family (one-shot writes — turn/message/status boundaries) ──
  /** Mirrors chatStore's `addMessage`. */
  addMessage(convId: string, message: Message): void;
  /** Mirrors chatStore's `deleteMessage`. */
  deleteMessage(convId: string, messageId: string, opts?: { skipCatalogBump?: boolean; persist?: boolean }): void;
  /** Mirrors chatStore's `updateToolCall`. */
  updateToolCall(
    convId: string,
    messageId: string,
    toolCallId: string,
    result: string,
    resultContent?: ToolResultContent[],
    isError?: boolean,
    hideScreenshot?: boolean,
    metadata?: ToolExecutionMetadata,
  ): void;
  /** Mirrors chatStore's `appendToolCallContext`. */
  appendToolCallContext(convId: string, loopId: string, context: ToolCallForContext): void;
  /** Mirrors chatStore's `updateMessageUsage`. */
  updateMessageUsage(convId: string, usage: TokenUsage, msgId?: string): void;
  /** Mirrors chatStore's `setExecutionStepsSnapshot`. */
  setExecutionStepsSnapshot(convId: string, loopId: string, steps: ExecutionStepSnapshot[]): void;
  /** Mirrors chatStore's `setPlannedStepsSnapshot`. */
  setPlannedStepsSnapshot(convId: string, loopId: string, steps: PlannedStep[]): void;
  /** Mirrors chatStore's `setConversationStatus`. */
  setConversationStatus(convId: string, status: ConversationStatus): void;
  /** Mirrors chatStore's `setAgentStatus`. */
  setAgentStatus(status: AgentStatus, tool?: string, agentName?: string): void;
  /** Mirrors chatStore's `setCurrentUsage`. */
  setCurrentUsage(usage: TokenUsage | null): void;
  /** Mirrors chatStore's `setRetryInfo`. */
  setRetryInfo(info: RetryInfo | null): void;
  /** Mirrors chatStore's `setContextUsage`. */
  setContextUsage(convId: string, usage: NonNullable<Conversation['contextUsage']> | undefined): void;
  /** Mirrors chatStore's `setContextCache`. */
  setContextCache(convId: string, cache: ContextCache): void;
  /** Mirrors chatStore's `clearContextCache`. */
  clearContextCache(convId: string): void;
  /** Mirrors chatStore's `setIsCompressing`. */
  setIsCompressing(convId: string, value: boolean): void;
  /** Mirrors chatStore's `setConversationModel`. */
  setConversationModel(convId: string, model: { providerId: string; modelId: string } | undefined): void;
  /** Mirrors chatStore's `setPendingProposalSignal`. */
  setPendingProposalSignal(convId: string, signal: ProposalSignal | undefined): void;
  /** Mirrors chatStore's `removeActiveAgent`. */
  removeActiveAgent(agentName: string): void;
}

/** Default in-process implementation over the Zustand store. This is the
 *  seam a future out-of-process agent runtime (headless Node sidecar) would
 *  replace with an IPC/RPC-backed implementation that ships these as batched
 *  delta frames instead of synchronous store mutations.
 *
 *  Every method fetches `useChatStore.getState()` at CALL time, not at
 *  construction time — mirrors the settingsReader probe's lesson (§2e /
 *  the settings-sweep §2d): a cached/memoized store reference would go
 *  stale across renders/turns and silently reintroduce staleness bugs that
 *  the existing test suite (which mutates the store between setup and
 *  assertion) would otherwise catch. */
export function createInProcessChatDelta(): ChatDelta {
  return {
    appendText: (convId, token, msgId) =>
      useChatStore.getState().appendToLastMessage(convId, token, msgId),
    setLastMessageContent: (convId, content, msgId) =>
      useChatStore.getState().setLastMessageContent(convId, content, msgId),
    appendThinking: (convId, thinking, msgId) =>
      useChatStore.getState().updateMessageThinking(convId, thinking, msgId),
    setThinkingDuration: (convId, duration, msgId) =>
      useChatStore.getState().updateMessageThinkingDuration(convId, duration, msgId),
    flushTokens: (convId, msgId) => flushTokenBuffer(convId, msgId),
    finishStreaming: (convId, msgId) => useChatStore.getState().finishStreaming(convId, msgId),
    cancelStreaming: (convId, opts) => useChatStore.getState().cancelStreaming(convId, opts),
    deactivateSkills: (convId) => useChatStore.getState().deactivateConversationSkills(convId),
    setMessageStreamingFlag: (convId, messageId, streaming) =>
      useChatStore.getState().setMessageStreamingFlag(convId, messageId, streaming),
    setMessageToolCalls: (convId, messageId, toolCalls) =>
      useChatStore.getState().setMessageToolCalls(convId, messageId, toolCalls),

    addMessage: (convId, message) => useChatStore.getState().addMessage(convId, message),
    deleteMessage: (convId, messageId, opts) =>
      useChatStore.getState().deleteMessage(convId, messageId, opts),
    updateToolCall: (convId, messageId, toolCallId, result, resultContent, isError, hideScreenshot, metadata) =>
      useChatStore.getState().updateToolCall(
        convId,
        messageId,
        toolCallId,
        result,
        resultContent,
        isError,
        hideScreenshot,
        metadata,
      ),
    appendToolCallContext: (convId, loopId, context) =>
      useChatStore.getState().appendToolCallContext(convId, loopId, context),
    updateMessageUsage: (convId, usage, msgId) =>
      useChatStore.getState().updateMessageUsage(convId, usage, msgId),
    setExecutionStepsSnapshot: (convId, loopId, steps) =>
      useChatStore.getState().setExecutionStepsSnapshot(convId, loopId, steps),
    setPlannedStepsSnapshot: (convId, loopId, steps) =>
      useChatStore.getState().setPlannedStepsSnapshot(convId, loopId, steps),
    setConversationStatus: (convId, status) => useChatStore.getState().setConversationStatus(convId, status),
    setAgentStatus: (status, tool, agentName) => useChatStore.getState().setAgentStatus(status, tool, agentName),
    setCurrentUsage: (usage) => useChatStore.getState().setCurrentUsage(usage),
    setRetryInfo: (info) => useChatStore.getState().setRetryInfo(info),
    setContextUsage: (convId, usage) => useChatStore.getState().setContextUsage(convId, usage),
    setContextCache: (convId, cache) => useChatStore.getState().setContextCache(convId, cache),
    clearContextCache: (convId) => useChatStore.getState().clearContextCache(convId),
    setIsCompressing: (convId, value) => useChatStore.getState().setIsCompressing(convId, value),
    setConversationModel: (convId, model) => useChatStore.getState().setConversationModel(convId, model),
    setPendingProposalSignal: (convId, signal) =>
      useChatStore.getState().setPendingProposalSignal(convId, signal),
    removeActiveAgent: (agentName) => useChatStore.getState().removeActiveAgent(agentName),
  };
}

/** Module-level slot for the app-wide default ChatDelta — see `portSlot.ts`
 *  for the shared get/set/swap-hook contract every port in this directory
 *  follows. All core/ callers that don't receive an explicit delta via
 *  options should go through `getChatDelta()` instead of constructing
 *  their own in-process delta, so there's a single seam to flip when the
 *  headless Node runtime starts up (see `setChatDelta`). */
const slot = createPortSlot<ChatDelta>(createInProcessChatDelta);

export function getChatDelta(): ChatDelta {
  return slot.get();
}

export function setChatDelta(delta: ChatDelta): void {
  slot.set(delta);
}
