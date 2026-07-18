import { useChatStore, flushTokenBuffer } from '@/stores/chatStore';

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
  /** Mirrors chatStore's `cancelStreaming`. */
  cancelStreaming(convId: string): void;

  // ── Reclaimed named actions (formerly raw setState escapes in agentLoop.ts) ──
  /** Mirrors chatStore's `deactivateConversationSkills`. */
  deactivateSkills(convId: string): void;
  /** Mirrors chatStore's `setMessageStreamingFlag`. */
  setMessageStreamingFlag(convId: string, messageId: string, streaming: boolean): void;
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
    cancelStreaming: (convId) => useChatStore.getState().cancelStreaming(convId),
    deactivateSkills: (convId) => useChatStore.getState().deactivateConversationSkills(convId),
    setMessageStreamingFlag: (convId, messageId, streaming) =>
      useChatStore.getState().setMessageStreamingFlag(convId, messageId, streaming),
  };
}

let current: ChatDelta = createInProcessChatDelta();

/** Module-level accessor for the app-wide default ChatDelta. All core/
 *  callers that don't receive an explicit delta via options should go
 *  through this instead of constructing their own in-process delta, so
 *  there's a single seam to flip when the headless Node runtime starts up
 *  (see `setChatDelta`). */
export function getChatDelta(): ChatDelta {
  return current;
}

/** One-time swap hook for a future out-of-process (IPC/RPC-backed) delta
 *  channel, to be called once at Node runtime startup. Not used anywhere
 *  yet — the in-process default remains active until a real out-of-process
 *  implementation exists. */
export function setChatDelta(delta: ChatDelta): void {
  current = delta;
}
