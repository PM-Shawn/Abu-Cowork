/**
 * Message ledger — the single authoritative fold from the append-only JSONL
 * event log to the current `Message[]` projection.
 *
 * Design: `docs/abu-message-ledger-plan.md` §3.1 (event envelope) and §3.3
 * (fold spec). Three consumers must agree byte-for-byte on the result:
 *
 *   1. `loadMessages()` in `conversationStorage.ts` (this implementation)
 *   2. `scanConversationFile()` in `electron/messageLedgerFold.cjs`
 *   3. `scan_conversation_file()` in `src-tauri/src/catalog_db.rs` (legacy Tauri)
 *
 * They cannot share a module (renderer / Electron main / Rust), so they are
 * pinned to each other by a shared fixture file —
 * `__fixtures__/messageLedgerFold.fixtures.json` — replayed by contract tests
 * on every side. Change the fold? Change the fixtures, and every port turns
 * red until it agrees again.
 *
 * ## Line format
 *
 * A ledger line is a plain `Message` object with at most two extra fields:
 *
 *   {"lk":"msg.put","pid":"m_122","id":"m_123","role":"user","content":"…"}
 *
 * `lk` (ledger kind) defaults to `msg.put` when absent, so every pre-ledger
 * bare `Message` line is already a valid put — that is what makes the format
 * change a zero-migration one (plan §5). `pid` (parent id) is write-only
 * bookkeeping for a future branch/fork feature and is never read here.
 *
 * ## Fold semantics (plan §3.3)
 *
 * Strictly sequential, single pass: every event applies to the state folded
 * from the lines BEFORE it, never to a globally pre-collected delete set. That
 * ordering is load-bearing, not a detail — "edit and resend" appends a
 * truncate event and then immediately appends the new turn's messages behind
 * it. Collecting truncations first and applying them at the end would delete
 * the very turn the user just produced. For the same reason a `msg.put` after
 * a `msg.tomb` for the same id resurrects that message.
 */

import type { Message } from '@/types';

/** Ledger event kinds. Absent `lk` means `msg.put`. */
export type LedgerKind = 'msg.put' | 'msg.tomb' | 'msg.truncate' | 'msg.loopDrop';

export const LEDGER_KIND_PUT = 'msg.put';

/**
 * One physical line of `messages.jsonl`.
 *
 * It extends `Message` rather than wrapping it in a `{type, payload}` envelope
 * on purpose (plan §3.1): every stored line stays a legal `Message` for older
 * app versions, so a downgrade renders the log instead of crashing on it.
 */
export interface LedgerLine extends Message {
  /** Ledger kind. Omitted on puts — absent is the canonical spelling of `msg.put`. */
  lk?: LedgerKind;
  /**
   * Parent pointer: the id of the last surviving message at append time.
   * Written but never read (plan §3.2) — it exists so a future branch/fork
   * feature does not have to guess the chain by re-reading line order.
   */
  pid?: string;
  /** `msg.tomb`: id of the message being removed. */
  target?: string;
  /** `msg.truncate`: id of the first message to remove (it and everything after). */
  from?: string;
}

export interface FoldResult {
  /** Current projection, in conversation order. */
  messages: Message[];
  /** Lines that were not parseable JSON objects and were skipped. */
  corruptCount: number;
  /** Non-blank lines seen (corrupt ones included). */
  totalLines: number;
}

/**
 * Fields every event line must carry so that an older build parses it as a
 * harmless, invisible `Message` instead of choking on it (plan §5.2):
 * `content: ''` because `Message.content` is required and older renderers do
 * `content.length`, and `isSystem: true` because that is the flag existing UI
 * already uses to hide a message. `content: ''` also makes the row harmless if
 * an older build still feeds system messages into the LLM context.
 */
export interface LedgerEventInit {
  /** Unique id for the event row itself (never the id of the affected message). */
  id: string;
  timestamp: number;
  /** `msg.tomb`: the message being removed. */
  target?: string;
  /** `msg.truncate`: the first message to remove. */
  from?: string;
  /** `msg.loopDrop`: the loop whose messages are removed. */
  loopId?: string;
  /** Parent pointer — see `LedgerLine.pid`. */
  pid?: string;
}

/**
 * Build an event line that is simultaneously a legal, invisible `Message`.
 *
 * Always construct event rows through this helper: the rollback-safety
 * contract in plan §5.2 is exactly the four fields it hard-codes, and a
 * hand-rolled object is one forgotten `content: ''` away from breaking an
 * older build's renderer.
 */
export function createLedgerEvent(
  kind: Exclude<LedgerKind, 'msg.put'>,
  init: LedgerEventInit,
): LedgerLine {
  const event: LedgerLine = {
    lk: kind,
    id: init.id,
    role: 'system',
    content: '',
    isSystem: true,
    timestamp: init.timestamp,
  };
  if (init.pid !== undefined) event.pid = init.pid;
  if (init.target !== undefined) event.target = init.target;
  if (init.from !== undefined) event.from = init.from;
  if (init.loopId !== undefined) event.loopId = init.loopId;
  return event;
}

/**
 * Replay an append-only message log into its current projection.
 *
 * Pure, no I/O — see the module doc for the semantics this implements and for
 * the two sibling ports that must stay identical to it.
 */
export function foldMessageLog(lines: readonly string[]): FoldResult {
  const state: LedgerLine[] = [];
  let index = new Map<string | undefined, number>();
  let corruptCount = 0;
  let totalLines = 0;

  const reindex = (): void => {
    index = new Map<string | undefined, number>();
    for (let i = 0; i < state.length; i++) index.set(state[i].id, i);
  };

  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue;
    totalLines++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      corruptCount++;
      continue;
    }
    // A line that parses to a non-object (null, number, string, array) cannot
    // be a Message. Older code pushed it through and then threw on `.id`,
    // taking the whole conversation down with it; counting it as corrupt keeps
    // the damage to the one line.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      corruptCount++;
      continue;
    }
    const line = parsed as LedgerLine;
    const kind: string = typeof line.lk === 'string' ? line.lk : LEDGER_KIND_PUT;

    switch (kind) {
      case LEDGER_KIND_PUT: {
        // Note the map key is `line.id` verbatim, so every id-less line
        // collapses onto one shared `undefined` key — the behaviour the
        // pre-ledger dedup had and both ports deliberately mirror.
        const at = index.get(line.id);
        if (at === undefined) {
          state.push(line);
          index.set(line.id, state.length - 1);
        } else {
          // In place, NOT move-to-end: a revision must not reorder the
          // conversation. This is the semantics that makes "replace a message"
          // expressible as "append a second line with the same id".
          state[at] = line;
        }
        break;
      }
      case 'msg.tomb': {
        if (typeof line.target !== 'string') break;
        const at = index.get(line.target);
        if (at === undefined) break;
        state.splice(at, 1);
        reindex();
        break;
      }
      case 'msg.truncate': {
        if (typeof line.from !== 'string') break;
        const at = index.get(line.from);
        if (at === undefined) break;
        state.length = at;
        reindex();
        break;
      }
      case 'msg.loopDrop': {
        if (typeof line.loopId !== 'string') break;
        const kept = state.filter((m) => m.loopId !== line.loopId);
        if (kept.length === state.length) break;
        state.length = 0;
        for (const m of kept) state.push(m);
        reindex();
        break;
      }
      default:
        // Unknown kind — written by a newer build. It is not a message, so it
        // must not render; ignoring it is the forward-compatible choice.
        break;
    }
  }

  return { messages: state as Message[], corruptCount, totalLines };
}
