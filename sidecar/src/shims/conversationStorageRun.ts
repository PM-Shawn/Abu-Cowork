/**
 * Sidecar-local replacement for `src/core/session/conversationStorage.ts`.
 *
 * `agentLoop.ts` never statically imports this module — it reaches it ONLY
 * via DYNAMIC `await import('../session/conversationStorage')` call sites
 * (verified: `grep -n "conversationStorage" src/core/agent/agentLoop.ts`),
 * currently destructuring `replaceMessageById` and `snapshotMessageRevision`.
 * (The truncate-only ledger work — plan stage 3 — retired the old
 * `isMessageWrittenToDisk` ghost-cleanup call site: the durability check now
 * lives inside the shell-side `appendTruncateEvent` skip guard, so the
 * forwarding shim and its `session.isMessageWrittenToDisk` RPC method were
 * removed with it.) `memdir/extractor.ts` additionally consumes
 * `loadMessages` (see below). No other export of the real module is
 * destructured by sidecar-bundled code; the remaining ~23 exports are
 * correctly omitted, not silently missing.
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
 * `'replaceMessageById'` as an allowlisted `SESSION_METHODS` entry, so
 * no shell-side change is needed for this half.
 *
 * ── `snapshotMessageRevision` → real forwarding shim, via `pushFrame` ───
 * Same wire pattern: `{ p: 'session', m: 'snapshotMessageRevision', a:
 * [convId, message] }`. agentLoop.ts's 5 s crash-protection flush
 * (`flushStreamingMessage`) calls this during streaming (plan stage 3's
 * stream-snapshot path). It MUST be a frame, not a `sendRequest` round trip:
 * the shell's checkpoint writers (`replaceMessageById`/`updateLastMessage`/
 * `appendTruncateEvent`) call `dropStreamSnapshotEntry` when a revision
 * enters the ledger, so snapshot writes and ledger checkpoints must apply in
 * the exact order the loop issued them — a snapshot delivered on a separate
 * RPC channel could land AFTER the turn-end checkpoint that superseded it
 * and resurrect the stale revision on the next load. The single `pushFrame`
 * FIFO gives that ordering for free.
 *
 * ── `loadMessages` → P1-3d-2 addition, real LOCAL-FS shim (no wire round trip) ──
 * `memdir/extractor.ts` dynamically imports `loadMessages` from this module
 * (`import('../session/conversationStorage')`, resolving through this SAME
 * shim redirect) once `memdirExtractorRun.ts` stopped stubbing out the real
 * extractor — a 3rd consumer beyond the 2 functions above, not previously
 * reachable. It reads the conversation's two files here and hands their text
 * to `projectLedger` (`src/core/session/ledgerReader.ts`), the shared
 * projection the renderer runs, so a `msg.truncate` / `msg.tomb` /
 * `msg.loopDrop` event cuts the history on this side exactly as it does on
 * the shell side and a revised message keeps its position.
 *
 * The read is LOCAL rather than a `sendRequest` round trip (same pattern as
 * `memdirScan.ts`/`memdirPaths.ts`): both files are written by the shell while
 * this side may be reading them, and the projection is built to survive that
 * without coordination. `messages.jsonl` only ever grows, so a concurrent
 * append lands after the prefix this read already has. The ledger is read
 * BEFORE the snapshot, so a snapshot entry written against a longer ledger than
 * the one just read is stale by `ledgerText.length < stamp` and is dropped
 * rather than overlaid on an older history. A snapshot caught half-written, or
 * unparsable for any other reason, yields the ledger alone. And
 * `messages.jsonl` lives on the SAME machine/disk the shell
 * writes to — `appDataDir()` here resolves through the existing
 * `@tauri-apps/api/path` bare-specifier shim (`tauriPathRun.ts`), which reads
 * the identical spawn-time bootstrap value the shell's own Tauri
 * `appDataDir()` call resolves to (see that shim's doc), so
 * `<appDataDir>/conversations/<convId>/messages.jsonl` is byte-identical on
 * both sides.
 *
 * `stream-snapshot.json` is merged READ-ONLY: the shell is that file's only
 * writer, so this side acts on none of the projection's verdicts — it neither
 * rewrites the file with the surviving entries nor deletes it. For the same
 * reason `populateWrittenIds` is NOT replicated: that mutates the SHELL's own
 * module-level `writtenIds` Set, so a sidecar-local copy of that state would
 * just be dead — nothing sidecar-side reads it.
 *
 * `uptoBytes` cuts the ledger's bytes at a watermark the shell measured after
 * a flush, so a caller can pin exactly the prefix the writer had made durable
 * and never see a half-written tail. Such a read returns that prefix alone: the
 * snapshot's stamps are measured against the whole ledger, so merging it into a
 * cut ledger would hand back content the watermark deliberately excludes. The
 * watermark is also what a missing ledger is judged against: a value above zero
 * says the shell measured this file, so finding no file at all is a
 * disagreement about the path and is refused instead of read as an empty
 * conversation.
 */
import type { Message } from '@/types';
import {
  decodeLedgerPrefix,
  LedgerWatermarkError,
  projectLedger,
  STREAM_SNAPSHOT_FILENAME,
} from '@/core/session/ledgerReader';
import { getCurrentAgentRunContext } from '../agentRunContext';
import * as fs from 'node:fs/promises';
import { appDataDir } from '@tauri-apps/api/path';

export async function replaceMessageById(convId: string, message: Message): Promise<void> {
  getCurrentAgentRunContext().pushFrame({ p: 'session', m: 'replaceMessageById', a: [convId, message] });
}

export async function snapshotMessageRevision(convId: string, message: Message): Promise<void> {
  getCurrentAgentRunContext().pushFrame({ p: 'session', m: 'snapshotMessageRevision', a: [convId, message] });
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

function streamSnapshotPath(convId: string): string {
  return joinPath(basePath!, convId, STREAM_SNAPSHOT_FILENAME);
}

/**
 * The snapshot file's text, or null when there is none or it cannot be read.
 * This process only ever reads it (see the module doc); a conversation without
 * an in-flight revision has no such file at all, which is why an unreadable one
 * leaves the ledger alone instead of failing the read.
 */
async function readSnapshotText(convId: string): Promise<string | null> {
  try {
    return await fs.readFile(streamSnapshotPath(convId), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The ledger's text, or null when there is no ledger to read.
 *
 * The file's bytes stay inside this function: on a long conversation they are
 * a copy of tens of megabytes, and the caller only needs the decoded text, so
 * the buffer becomes collectable before the projection starts allocating.
 */
async function readLedgerText(
  convId: string,
  options?: { strictRead?: boolean; uptoBytes?: number },
): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(messagesPath(convId));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    // A watermark above zero is a size the shell measured on this very file, so
    // a file that is not there contradicts it: the two sides disagree about
    // which conversation directory they are looking at, and answering "empty"
    // would start a run on a history the caller's own measurement rules out.
    // Refused exactly like a watermark past the end of a file that does exist.
    if (code === 'ENOENT' && options?.uptoBytes !== undefined && options.uptoBytes > 0) {
      throw new LedgerWatermarkError('watermark_beyond_file', options.uptoBytes, 0);
    }
    // A missing file/dir is an empty ledger, same contract as the real module.
    // Every other read failure stays tolerant unless the caller asked to tell
    // the two apart (`strictRead`, used by first-contact receipt recovery).
    if (options?.strictRead && code !== 'ENOENT') throw err;
    return null;
  }
  return decodeLedgerPrefix(bytes, options?.uptoBytes);
}

/**
 * The conversation's messages, as the renderer would show them.
 *
 * `uptoBytes` reads the ledger only up to that byte offset and returns that
 * prefix alone, with no stream snapshot merged on top. A value that does not
 * match the file throws a `LedgerWatermarkError`, which is deliberately not
 * caught — a caller that passes a watermark must learn that it is wrong. That
 * includes a value above zero on a conversation with no ledger file, which a
 * read without a watermark still reports as an empty conversation.
 */
export async function loadMessages(
  convId: string,
  options?: { strictRead?: boolean; uptoBytes?: number },
): Promise<Message[]> {
  await ensureBase();

  const ledgerText = await readLedgerText(convId, options);
  if (ledgerText === null) return [];

  // A watermark pins exactly what the writer had made durable at that offset,
  // while the snapshot's `stamp`s are measured against the whole ledger — an
  // entry judged against the full file has no meaning over a cut one.
  const snapshotText = options?.uptoBytes === undefined ? await readSnapshotText(convId) : null;
  return projectLedger({ ledgerText, snapshotText }).messages;
}
