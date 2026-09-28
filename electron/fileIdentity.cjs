'use strict';

/**
 * Exact file identity — the `(device, file id)` pair — as decimal strings.
 *
 * ## Why `Stats.ino` is not enough
 *
 * A Windows file id is 64 bits wide: the low 48 hold the MFT record index and
 * the high 16 hold that record's reuse sequence. Any record that has been
 * reused 32 times or more therefore carries an id above
 * `Number.MAX_SAFE_INTEGER`, and `Stats.ino` reports it as a double that has
 * already been rounded to fit. Measured on an ordinary Windows 11 profile:
 * 1676 of 60137 files (2.79%) have such an id, and in a churned directory —
 * a download folder, an extraction target — the share is far higher.
 *
 * Two consequences, both fatal to a pin that is frozen now and re-checked
 * later:
 *
 *  - A guard shaped like `Number.isSafeInteger(stats.ino)` is false for exactly
 *    those files, so the identity is discarded (or the record carrying it is
 *    rejected) on the files it exists to protect.
 *  - Above 2^53 the gap between representable doubles is 4 or more, while two
 *    files in adjacent MFT records have ids that differ by 1 — which is what a
 *    file created right after the pinned one gets. Distinct files then round to
 *    the same `ino`, so dropping the guard and comparing the double would call
 *    two different files the same file.
 *
 * So identity is read with `bigint: true`, which is exact at any width, and
 * carried as a decimal string, which is the only exact form that survives
 * `JSON.stringify` (a BigInt throws there), the preload bridge, and the
 * encrypted journals on disk.
 *
 * A platform that reports no id at all (`0`) yields `null`, and callers keep
 * whatever behaviour they already had for a missing identity.
 */

const nodeFs = require('node:fs');

const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

/**
 * One device or file id as an exact decimal string, or `null` when the
 * platform reported none.
 *
 * `bigint` is what every real-filesystem read in this file produces. A plain
 * `number` arrives from two places, both exact: an injected filesystem double
 * in the tests, and an identity frozen by an older build of the app, which
 * could only ever have been written when the id fitted in a double. A string
 * is an identity that has already crossed a wire.
 *
 * @param {bigint|number|string|null|undefined} value
 * @returns {string|null}
 */
function identityText(value) {
  if (typeof value === 'bigint') return value >= 0n ? value.toString() : null;
  if (typeof value === 'number') return Number.isInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === 'string') return DECIMAL.test(value) ? value : null;
  return null;
}

/**
 * The identity of a `Stats` (of either flavour) or of an already-frozen
 * `{ ino, dev }` record.
 *
 * `ino` is `null` when the platform reports `0`, which is how a filesystem
 * without file ids arrives; `dev` is kept whenever it is a whole number, `0`
 * included.
 *
 * @param {{ ino?: unknown, dev?: unknown }|null|undefined} source
 * @returns {{ ino: string|null, dev: string|null }|null}
 */
function identityOf(source) {
  if (!source) return null;
  const ino = identityText(source.ino);
  return {
    ino: ino === '0' ? null : ino,
    dev: identityText(source.dev),
  };
}

/**
 * Do two identities name the same file?
 *
 * Both halves have to be present and equal. An identity with no `ino` cannot
 * answer the question at all, so it never matches — a caller that tolerates a
 * missing id has to say so itself.
 *
 * @param {{ ino: string|null, dev: string|null }|null|undefined} a
 * @param {{ ino: string|null, dev: string|null }|null|undefined} b
 */
function sameIdentity(a, b) {
  if (!a || !b || a.ino === null || b.ino === null) return false;
  return a.ino === b.ino && a.dev === b.dev;
}

/** Identity of `target`, following a final symbolic link. */
function statIdentitySync(target, fs = nodeFs) {
  return identityOf(fs.statSync(target, { bigint: true }));
}

/** Identity of `target` itself, symbolic link included. */
function lstatIdentitySync(target, fs = nodeFs) {
  return identityOf(fs.lstatSync(target, { bigint: true }));
}

/**
 * Identity of an open descriptor — the only read no rename can race, which is
 * what makes it the right one to check a frozen pin against.
 */
function fstatIdentitySync(fd, fs = nodeFs) {
  return identityOf(fs.fstatSync(fd, { bigint: true }));
}

module.exports = {
  identityText,
  identityOf,
  sameIdentity,
  statIdentitySync,
  lstatIdentitySync,
  fstatIdentitySync,
};
