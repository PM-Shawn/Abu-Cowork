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
 *
 * ── `loadMessages` → P1-3d-2 addition, real LOCAL-FS shim (no wire round trip) ──
 * `memdir/extractor.ts` dynamically imports `loadMessages` from this module
 * (`import('../session/conversationStorage')`, resolving through this SAME
 * shim redirect) once `memdirExtractorRun.ts` stopped stubbing out the real
 * extractor — a 3rd consumer beyond the 2 functions above, not previously
 * reachable. Implemented as a verbatim-ported LOCAL read (same pattern as
 * `memdirScan.ts`/`memdirPaths.ts`) rather than a `sendRequest` round trip:
 * it's a pure read with no shared mutable state to coordinate (unlike
 * `replaceMessageById`'s frame-ordering requirement or
 * `isMessageWrittenToDisk`'s dependence on the SHELL's own `writtenIds`
 * dedup set), and `messages.jsonl` lives on the SAME machine/disk the shell
 * writes to — `appDataDir()` here resolves through the existing
 * `@tauri-apps/api/path` bare-specifier shim (`tauriPathRun.ts`), which reads
 * the identical spawn-time bootstrap value the shell's own Tauri
 * `appDataDir()` call resolves to (see that shim's doc), so
 * `<appDataDir>/conversations/<convId>/messages.jsonl` is byte-identical on
 * both sides. Path construction (`ensureBase`/`messagesPath`) and parsing
 * (per-line tolerant JSON.parse + `dedupMessagesById`) are ported verbatim
 * from the real `conversationStorage.ts` — `populateWrittenIds` is
 * intentionally NOT replicated: that mutates the SHELL's own module-level
 * `writtenIds` Set (which `isMessageWrittenToDisk` above queries via RPC, not
 * a local read), so a sidecar-local copy of that state would just be dead
 * — nothing sidecar-side reads it.
 */
import type { Message } from '@/types';
import { sendRequest } from '../rpcClient';
import { getCurrentAgentRunContext } from '../agentRunContext';
import * as fs from 'node:fs/promises';
import { appDataDir } from '@tauri-apps/api/path';

export async function replaceMessageById(convId: string, message: Message): Promise<void> {
  getCurrentAgentRunContext().pushFrame({ p: 'session', m: 'replaceMessageById', a: [convId, message] });
}

export async function isMessageWrittenToDisk(id: string): Promise<boolean> {
  const { conversationId } = getCurrentAgentRunContext();
  return sendRequest('session.isMessageWrittenToDisk', { conversationId, messageId: id }) as Promise<boolean>;
}

// joinPath copied verbatim from src/utils/pathUtils.ts (same inlining
// rationale memdirPaths.ts documents: avoids dragging that file's OTHER,
// Tauri-coupled exports into the bundle for a two-line dependency).
function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/\\/g, '/'))
    .join('/')
    .replace(/\/{2,}/g, '/');
}

let basePath: string | null = null;

async function ensureBase(): Promise<string> {
  if (!basePath) {
    const appData = await appDataDir();
    basePath = joinPath(appData, 'conversations');
  }
  return basePath;
}

function messagesPath(convId: string): string {
  return joinPath(basePath!, convId, 'messages.jsonl');
}

/** Verbatim port of the real module's dedupMessagesById. */
function dedupMessagesById(messages: Message[]): Message[] {
  const lastIndex = new Map<string, number>();
  messages.forEach((m, i) => lastIndex.set(m.id, i));
  if (lastIndex.size === messages.length) return messages; // no dupes, fast path
  return messages.filter((m, i) => lastIndex.get(m.id) === i);
}

/** Verbatim-ported (minus `populateWrittenIds`, see module doc) copy of the real `loadMessages`. */
export async function loadMessages(convId: string): Promise<Message[]> {
  await ensureBase();
  const path = messagesPath(convId);

  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch {
    return []; // missing file/dir → same empty-list contract as the real module
  }

  const lines = raw.trimEnd().split('\n').filter((l) => l.length > 0);
  const messages: Message[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as Message);
    } catch {
      // Corrupt line: skip, keep the rest (same tolerance as the real module).
    }
  }
  return dedupMessagesById(messages);
}
