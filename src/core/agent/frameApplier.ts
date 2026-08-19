/**
 * Shell-side port-frame applier — P1-3b-2's counterpart to
 * `sidecar/src/portFrameSenders.ts` (item 2) and `sidecar/src/
 * portFrameCoalescer.ts` (item 1). Dispatches a batch of frames received
 * over the `agent.delta` reverse notification (design doc §4 protocol
 * table) onto the REAL in-process ports, in arrival order.
 *
 * DORMANT this batch: nothing calls `applyDeltaFrames` yet (3b-3's
 * `agentLoopRunner.ts` `agent.delta` handler is the first caller) — this
 * file is pure dispatch machinery, independently unit-testable against the
 * real in-process ports (same style as the existing port test suites).
 *
 * Deliberately duplicates the 3-field `PortFrame` shape from
 * `sidecar/src/portFrameCoalescer.ts` rather than importing it — `src/`
 * must never import from `sidecar/` (the dependency direction is the
 * reverse: the sidecar bundle imports/shims real `src/` modules, see
 * `scripts/build-sidecar.mjs`). The shape is a 3-field wire contract, not
 * shared runtime logic, so duplication here is the cheap, correct choice
 * (same precedent as `SerializableToolDefinition` being independently
 * declared on both sides of the P1-3a reverse channel).
 */
import { getChatDelta } from './ports/chatDelta';
import { getExecutionPort, applyExecutionWithId } from './ports/executionPort';
import { applyScratchpadEntryWithId } from './ports/scratchpadPort';
import { createLogger } from '../logging/logger';
import { waitForConversationPersistence } from '../../stores/chatStore';

const logger = createLogger('frameApplier');

export interface PortFrame {
  p: 'chat' | 'exec' | 'scratchpad' | 'session';
  m: string;
  a: unknown[];
}

// ── Method allowlists ───────────────────────────────────────────────────
//
// Explicit string lists derived from each port's interface (chatDelta.ts /
// executionPort.ts / scratchpadPort.ts) — a malformed or hostile frame
// cannot call an arbitrary store method through this dispatcher, only the
// methods actually named here. `createExecution` (exec) and `addEntry`
// (scratchpad) are handled by dedicated id-preserving branches (see below),
// NOT by generic reflection into the port object — they are still listed in
// their allowlist Set so the "unknown method" check below treats them as
// known, but the generic dispatch switch never reflects into
// `getExecutionPort()['createExecution']` / `getScratchpadPort()['addEntry']`
// directly (those would mint a NEW id, breaking the sidecar mirror's id
// contract — see executionPort.ts's/scratchpadPort.ts's `applyXWithId` doc
// comments).

/** All 28 ChatDelta methods (chatDelta.ts) — every one is fire-and-forget/void, so generic reflection dispatch is safe for all of them. */
const CHAT_METHODS = new Set<string>([
  'appendText',
  'setLastMessageContent',
  'appendThinking',
  'setThinkingDuration',
  'flushTokens',
  'finishStreaming',
  'cancelStreaming',
  'deactivateSkills',
  'setMessageStreamingFlag',
  'setMessageToolCalls',
  'addMessage',
  'deleteMessagesFrom',
  'updateToolCall',
  'appendToolCallContext',
  'updateMessageUsage',
  'setExecutionStepsSnapshot',
  'setPlannedStepsSnapshot',
  'setConversationStatus',
  'setAgentStatus',
  'setCurrentUsage',
  'setRetryInfo',
  'setContextUsage',
  'setContextCache',
  'clearContextCache',
  'setIsCompressing',
  'setConversationModel',
  'setPendingProposalSignal',
  'removeActiveAgent',
]);

/** All write methods of ExecutionPort (executionPort.ts) — the 2 read methods (getExecutionByLoopId/getExecutionByConversationId) are deliberately excluded: reads never travel as frames (see this file's module doc and the design doc's "read methods CANNOT be frames" instruction). */
const EXEC_METHODS = new Set<string>([
  'createExecution', // id-preserving special case — see dispatch switch below
  'cancelExecution',
  'evictExecution',
  'completeExecution',
  'errorExecution',
  'addStep',
  'setStepResult',
  'setStepError',
  'addChildStep',
  'updateChildStep',
  'addDetailBlock',
  'appendThinking',
  'setThinkingDuration',
  'setUsage',
]);

/** ScratchpadPort's one write method — id-preserving special case, see dispatch switch below. */
const SCRATCHPAD_METHODS = new Set<string>(['addEntry']);

/** conversationStorage — the sidecar loop's two write forwarders: `replaceMessageById` (ledger checkpoint) and `snapshotMessageRevision` (the 5 s crash-protection flush's stream-snapshot write, ledger plan §3.6). Both travel as ordered frames rather than RPC because the checkpoint writers drop the snapshot entry for a checkpointed id (`dropStreamSnapshotEntry`) — applying a snapshot out of order with its superseding checkpoint would resurrect the stale revision on the next load. */
const SESSION_METHODS = new Set<string>(['replaceMessageById', 'snapshotMessageRevision']);

// ── Dispatch ─────────────────────────────────────────────────────────────

async function applyChatFrame(m: string, a: unknown[]): Promise<void> {
  if (!CHAT_METHODS.has(m)) {
    logger.warn('frameApplier: unknown chat method, skipping', { m });
    return;
  }
  const delta = getChatDelta() as unknown as Record<string, (...args: unknown[]) => void>;
  if (m === 'cancelStreaming') {
    // P1-3c-1 special case (same discipline as createExecution/addEntry
    // above — a known method, but NOT generic reflection): this frame is
    // the sidecar's own authoritative "stopped" decoration (agentLoop.ts's
    // abort catch → chatDelta.cancelStreaming), always applied in full.
    // `fromSidecarFrame: true` bypasses chatStore.cancelStreaming's own
    // "is a sidecar run still active" gate — this call IS that decoration,
    // not a second guess of it (by the time this frame applies, the
    // RunSession the gate reads is typically STILL registered, since
    // unregistration only happens after the `agent.run` RPC resolves,
    // later than this frame's delivery — see chatStore.ts's `cancelStreaming`
    // doc and docs/2026-07-21-phase1-p3c-conversation-authority-design.md §3).
    const [convId] = a as [string];
    delta.cancelStreaming(convId, { fromSidecarFrame: true });
    return;
  }
  delta[m](...a);
}

async function applyExecFrame(m: string, a: unknown[]): Promise<void> {
  if (!EXEC_METHODS.has(m)) {
    logger.warn('frameApplier: unknown exec method, skipping', { m });
    return;
  }
  if (m === 'createExecution') {
    // Id-preserving special case: the sidecar's local execution mirror
    // derives id === loopId by convention (see taskExecutionStore.ts's
    // createExecutionWithId doc comment) — no extra id arg is threaded
    // over the wire, it's rederived here the same way.
    const [conversationId, loopId] = a as [string, string];
    applyExecutionWithId(conversationId, loopId, loopId);
    return;
  }
  const port = getExecutionPort() as unknown as Record<string, (...args: unknown[]) => void>;
  port[m](...a);
}

async function applyScratchpadFrame(m: string, a: unknown[]): Promise<void> {
  if (!SCRATCHPAD_METHODS.has(m)) {
    logger.warn('frameApplier: unknown scratchpad method, skipping', { m });
    return;
  }
  // Id-preserving special case: unlike every other frame, the scratchpad
  // entry's id cannot be re-derived from any other arg (unlike exec's
  // loopId===id trick) — the sidecar's local mirror generates it and
  // threads it as the frame's FIRST arg, entry as the second. See
  // portFrameSenders.ts's createFrameScratchpadPort doc comment.
  const [id, entry] = a as [string, Parameters<typeof applyScratchpadEntryWithId>[1]];
  applyScratchpadEntryWithId(id, entry);
}

async function applySessionFrame(m: string, a: unknown[]): Promise<void> {
  if (!SESSION_METHODS.has(m)) {
    logger.warn('frameApplier: unknown session method, skipping', { m });
    return;
  }
  // Dynamic import — same discipline as agentLoop.ts's own
  // conversationStorage call sites (avoids conversationStorage's Tauri-fs
  // dependency graph on any code path that never needs it).
  const storage = await import('../session/conversationStorage');
  const [convId, message] = a as [string, Parameters<typeof storage.replaceMessageById>[1]];
  // Chat frames enqueue addMessage persistence without blocking rendering.
  // A later explicit session replacement must not overtake that append or it
  // will fail to find the assistant placeholder and silently leave the empty
  // row behind. The snapshot write waits too: a checkpoint still pending in
  // that queue drops the snapshot entry for its id when it lands, which
  // would silently discard a snapshot revision applied while the older write
  // was in flight.
  await waitForConversationPersistence(convId);
  if (m === 'snapshotMessageRevision') await storage.snapshotMessageRevision(convId, message);
  else await storage.replaceMessageById(convId, message);
}

/**
 * Apply a batch of port frames, IN ORDER, to the real in-process ports.
 * Unknown `p`/`m` → log + skip (forward-compat: a newer sidecar build must
 * never crash an older shell mid-batch, and vice versa).
 */
export async function applyDeltaFrames(frames: readonly PortFrame[]): Promise<void> {
  for (const frame of frames) {
    switch (frame.p) {
      case 'chat':
        await applyChatFrame(frame.m, frame.a);
        break;
      case 'exec':
        await applyExecFrame(frame.m, frame.a);
        break;
      case 'scratchpad':
        await applyScratchpadFrame(frame.m, frame.a);
        break;
      case 'session':
        await applySessionFrame(frame.m, frame.a);
        break;
      default:
        logger.warn('frameApplier: unknown port, skipping', { p: (frame as PortFrame).p });
    }
  }
}
