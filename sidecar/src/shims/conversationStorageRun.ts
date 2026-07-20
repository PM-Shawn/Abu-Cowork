/**
 * Sidecar-local replacement for `src/core/session/conversationStorage.ts`.
 *
 * `agentLoop.ts` never statically imports this module — it reaches it ONLY
 * via 3 DYNAMIC `await import('../session/conversationStorage')` call
 * sites (verified: `grep -n "conversationStorage" src/core/agent/agentLoop.ts`),
 * destructuring exactly 2 names total across all 3 sites:
 * `replaceMessageById` (2 call sites) and `isMessageWrittenToDisk` (1 call
 * site). No other function this module exports (`appendMessage`/
 * `updateIndexEntry`/`updateLastMessage`/`catalogSearch`/`flushWrites`/...
 * — 23 more exports, enumerated by reading the file's full `^export` list)
 * is ever destructured by `agentLoop.ts`. A repo-wide grep for
 * `session/conversationStorage` importers confirms only `agentLoop.ts`
 * itself, `agentLoopRunner.ts` (shell-side, already has its own
 * `session.isMessageWrittenToDisk` handler), `frameApplier.ts` (shell-side
 * applier, already dynamic-imports `replaceMessageById`), and
 * `ports/conversationReader.ts` (type-only) touch this module anywhere
 * reachable — so this shim's 2-function surface is a COMPLETE, not partial,
 * cover of what's actually consumed. The other 23 exports are correctly
 * omitted, not silently missing.
 *
 * ── `replaceMessageById` → real forwarding shim, via `pushFrame` ────────
 * Sends a `{ p: 'session', m: 'replaceMessageById', a: [convId, message] }`
 * `PortFrame` through `AgentRunContext.pushFrame` — the SAME coalescer/
 * `agent.delta` stream `chatDelta`/`executionPort`/`scratchpadPort` already
 * use (see `agentRunContext.ts`'s `pushFrame` doc: "wired by
 * `agentLoopHost.ts` to the SAME `push` callback... so frame order across
 * all 4 sources is preserved by the single coalescer's FIFO"). Arg shape
 * verified against `src/core/agent/frameApplier.ts`'s EXISTING `session`
 * port handling (`applySessionFrame`): `const [convId, message] = a as
 * [string, Parameters<typeof replaceMessageById>[1]]; await
 * replaceMessageById(convId, message);` — my `[convId, message]` tuple
 * matches exactly, and `frameApplier.ts` already lists
 * `'replaceMessageById'` as the one allowlisted `SESSION_METHODS` entry, so
 * no shell-side change is needed for this half.
 *
 * ── `isMessageWrittenToDisk` → real forwarding shim, `session.isMessageWrittenToDisk` REQUEST ──
 * Params/response shape verified against `agentLoopRunner.ts`'s
 * `handleIsMessageWrittenToDisk` (already built, this batch's cluster):
 * `{ conversationId, messageId }` → boolean. `conversationId` comes from the
 * current run context (`agentLoop.ts`'s call site doesn't pass a
 * conversationId explicitly — it's implicit in which run is calling — so
 * this shim reads it off `AgentRunContext.conversationId` rather than
 * requiring a caller-supplied param, matching the real function's own
 * single-arg `(id: string)` signature exactly).
 */
import type { Message } from '@/types';
import { sendRequest } from '../rpcClient';
import { getCurrentAgentRunContext } from '../agentRunContext';

export async function replaceMessageById(convId: string, message: Message): Promise<void> {
  getCurrentAgentRunContext().pushFrame({ p: 'session', m: 'replaceMessageById', a: [convId, message] });
}

export async function isMessageWrittenToDisk(id: string): Promise<boolean> {
  const { conversationId } = getCurrentAgentRunContext();
  return sendRequest('session.isMessageWrittenToDisk', { conversationId, messageId: id }) as Promise<boolean>;
}
