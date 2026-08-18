/**
 * Electron-main port of the message-ledger fold.
 *
 * Source of truth for the semantics: `src/core/session/messageLedger.ts` (see
 * its module doc for the full spec — plan `docs/abu-message-ledger-plan.md`
 * §3.1/§3.3). The renderer module cannot be required from the main process
 * (ESM + TS + the `src/` boundary rule), so this is a hand port pinned to the
 * original by a shared fixture replay:
 *
 *   src/core/session/__fixtures__/messageLedgerFold.fixtures.json
 *
 * `electron/messageLedgerFold.contract.test.ts` replays those fixtures through
 * BOTH implementations and asserts identical output, so the two can never
 * drift silently. Keep this file dependency-free (no node:sqlite, no Electron)
 * so that contract test stays cheap.
 */

'use strict';

const LEDGER_KIND_PUT = 'msg.put';

/**
 * Replay an append-only message log into its current projection.
 *
 * @param {readonly string[]} lines
 * @returns {{ messages: object[], corruptCount: number, totalLines: number }}
 */
function foldMessageLog(lines) {
  /** @type {object[]} */
  const state = [];
  let index = new Map();
  let corruptCount = 0;
  let totalLines = 0;

  const reindex = () => {
    index = new Map();
    for (let i = 0; i < state.length; i++) index.set(state[i].id, i);
  };

  for (const rawLine of lines) {
    if (rawLine.trim() === '') continue;
    totalLines++;

    let parsed;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      corruptCount++;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      corruptCount++;
      continue;
    }
    const kind = typeof parsed.lk === 'string' ? parsed.lk : LEDGER_KIND_PUT;

    if (kind === LEDGER_KIND_PUT) {
      // Key is `parsed.id` verbatim, so every id-less line collapses onto one
      // shared `undefined` key — matching the TS port and the pre-ledger dedup.
      const at = index.get(parsed.id);
      if (at === undefined) {
        state.push(parsed);
        index.set(parsed.id, state.length - 1);
      } else {
        // In place, NOT move-to-end — a revision must not reorder the log.
        state[at] = parsed;
      }
    } else if (kind === 'msg.tomb') {
      if (typeof parsed.target !== 'string') continue;
      const at = index.get(parsed.target);
      if (at === undefined) continue;
      state.splice(at, 1);
      reindex();
    } else if (kind === 'msg.truncate') {
      if (typeof parsed.from !== 'string') continue;
      const at = index.get(parsed.from);
      if (at === undefined) continue;
      state.length = at;
      reindex();
    } else if (kind === 'msg.loopDrop') {
      if (typeof parsed.loopId !== 'string') continue;
      const kept = state.filter((m) => m.loopId !== parsed.loopId);
      if (kept.length === state.length) continue;
      state.length = 0;
      for (const m of kept) state.push(m);
      reindex();
    }
    // Unknown kind (written by a newer build): not a message, ignore it.
  }

  return { messages: state, corruptCount, totalLines };
}

module.exports = { foldMessageLog, LEDGER_KIND_PUT };
