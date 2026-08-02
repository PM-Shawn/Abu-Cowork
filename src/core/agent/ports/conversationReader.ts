import { useChatStore } from '@/stores/chatStore';
import type { Conversation } from '@/types';
import type { ConversationMeta } from '../../session/conversationStorage';
import { createPortSlot } from './portSlot';

/**
 * Port abstracting agentLoop's (and toolExecutor's) READS of chatStore's
 * conversation data: the full per-conversation record, the lighter index/
 * catalog metadata, and the one global (non-per-conversation) scalar these
 * callers consult mid-loop.
 *
 * This is the read-side counterpart to `ChatDelta` (see `chatDelta.ts`) for
 * conversation data, following the same call-time-not-cached discipline as
 * `SettingsReader` (see `settingsReader.ts`): every method re-fetches
 * `useChatStore.getState()` at call time, never memoized, so callers that
 * read the same conversation twice across a mutation boundary observe the
 * post-mutation value — this is deliberate, not an oversight (see the
 * "串号" / cross-conversation-bleed discipline documented in
 * `settingsReader.ts` and agentLoop.ts's `settings` vs `freshSettings`
 * comment; each read call site here must stay an independent call, never
 * cached or merged with another read).
 *
 * Conversation/index records are plain data (no bound actions attached, per
 * `Conversation`/`ConversationMeta`'s shape) — unlike `SettingsReader`'s
 * `getSnapshot()`, this port does NOT need to strip function-valued
 * properties before returning. The `Readonly<...>` wrapper is a compile-time
 * signal only (callers must not mutate the live store's record through
 * this port), not a runtime deep-freeze.
 *
 * ── Why this port's *future* shape differs from `SettingsReader`'s ──
 * `SettingsReader` models a "shell-authoritative, push-mirrored" world: in
 * the future headless Node runtime, settings live in the Tauri/Electron
 * shell process and get pushed down to the Node sidecar as mirrored
 * snapshots — so a future out-of-process `SettingsReader` implementation
 * would be a genuine IPC/RPC round-trip (or a locally-cached mirror kept
 * fresh by push events from the shell).
 *
 * `ConversationReader` is different by design (see the runtime-extraction
 * architecture line, §1.2 Node-authoritative direction): conversation data
 * is planned to live authoritatively in the Node sidecar itself (same
 * process as the agent loop, so it can also back cloud/headless task
 * execution on the same code path) — the *shell* (Tauri UI) becomes the
 * mirror, not the other way around. Under that design, a future
 * out-of-process `ConversationReader` implementation is NOT an IPC round
 * trip from Node back up to a shell-held source of truth — it is simply
 * "read the Node-side authoritative copy locally" (e.g. a local store/DB
 * read within the same Node process), with the *shell*-facing sync being a
 * separate one-way push (Node → shell) that lives elsewhere, not behind
 * this port. Do not assume this port will grow network/IPC latency the way
 * an eventual out-of-process `SettingsReader` might — that's the opposite
 * authority direction. This distinction is the reason `ConversationReader`
 * exists as its own port instead of being folded into `SettingsReader`'s
 * pattern wholesale.
 */
export interface ConversationReader {
  /** Mirrors chatStore's `conversations[convId]` — the full live
   *  conversation record (messages, activeSkills, workspacePath, model,
   *  etc.). Callers destructure whatever field(s) they need ad hoc; this
   *  port deliberately does not offer narrower per-field accessors (see
   *  B1-REPORT.md §4 — narrowing would just relocate existing call-site
   *  destructuring without simplifying it). */
  getConversation(convId: string): Readonly<Conversation> | undefined;
  /** Mirrors chatStore's `conversationIndex[convId]` — lighter catalog
   *  metadata (title, workspacePath, model, etc.), used e.g. for
   *  notification text where the full conversation record isn't needed. */
  getIndexEntry(convId: string): Readonly<ConversationMeta> | undefined;
  /** Mirrors chatStore's `thinkingStartTime` — a global scalar (not keyed
   *  by conversation), unlike the other two accessors. */
  getThinkingStartTime(): number | null;
}

/** Default in-process implementation over the Zustand store's synchronous
 *  getState(). This is the seam a future out-of-process agent runtime
 *  (headless Node sidecar) would replace — see this file's top-level JSDoc
 *  for why that future implementation is a local Node-authoritative read,
 *  not an IPC round-trip, unlike `SettingsReader`'s eventual out-of-process
 *  form. */
export function createInProcessConversationReader(): ConversationReader {
  return {
    getConversation: (convId) => useChatStore.getState().conversations[convId],
    getIndexEntry: (convId) => useChatStore.getState().conversationIndex[convId],
    getThinkingStartTime: () => useChatStore.getState().thinkingStartTime,
  };
}

/** Module-level slot for the app-wide default ConversationReader — see
 *  `portSlot.ts` for the shared get/set/swap-hook contract every port in
 *  this directory follows. All core/ callers that don't receive an
 *  explicit reader via options should go through `getConversationReader()`
 *  instead of constructing their own in-process reader, so there's a
 *  single seam to flip when the headless Node runtime starts up (see
 *  `setConversationReader` — a future out-of-process, Node-authoritative
 *  implementation, per this file's top-level JSDoc). */
const slot = createPortSlot<ConversationReader>(createInProcessConversationReader);

export function getConversationReader(): ConversationReader {
  return slot.get();
}

export function setConversationReader(reader: ConversationReader): void {
  slot.set(reader);
}
