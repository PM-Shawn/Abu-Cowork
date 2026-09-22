'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  identityText, identityOf, sameIdentity, statIdentitySync, lstatIdentitySync, fstatIdentitySync,
} = require('./fileIdentity.cjs');

/**
 * The arithmetic the whole module exists for.
 *
 * `Stats.ino` is a double. Above 2^53 the gap between representable doubles is
 * 2 or more, and two NTFS files in adjacent MFT records have ids that differ by
 * exactly 1 — which is what a file created right after the pinned one gets. So
 * on the numeric wire the two ids below are one value, and every «is this still
 * the same file» check built on it answers yes for a file it has never seen.
 */
test('two file ids one apart stay apart, where a double could not tell them', () => {
  // A file id measured on this project's Windows profile, and its neighbour.
  const wide = 16_044_073_672_723_084n;
  assert.ok(wide > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(Number(wide), Number(wide + 1n), 'premise: a double cannot separate these');

  const pinned = identityOf({ ino: wide, dev: 66n });
  const neighbour = identityOf({ ino: wide + 1n, dev: 66n });
  assert.equal(pinned.ino, '16044073672723084');
  assert.equal(neighbour.ino, '16044073672723085');
  assert.equal(sameIdentity(pinned, neighbour), false);
  assert.equal(sameIdentity(pinned, identityOf({ ino: wide, dev: 66n })), true);
});

test('an identity survives JSON, which is what a BigInt cannot do', () => {
  const identity = identityOf({ ino: 18_446_744_073_709_551_615n, dev: 4_002_352_658n });
  const round = JSON.parse(JSON.stringify(identity));
  assert.deepEqual(round, { ino: '18446744073709551615', dev: '4002352658' });
  assert.equal(sameIdentity(round, identity), true);
  assert.throws(() => JSON.stringify({ ino: 1n }), TypeError);
});

test('a different device is a different file, even at the same id', () => {
  assert.equal(
    sameIdentity(identityOf({ ino: 4242n, dev: 66n }), identityOf({ ino: 4242n, dev: 67n })),
    false,
  );
});

/**
 * A filesystem that reports no id says so with `0`, and an entry carrying only
 * that cannot answer the question. It must not read as an identity that always
 * matches — which is what comparing `0 === 0` would do.
 */
test('an id of zero is no identity at all', () => {
  const none = identityOf({ ino: 0n, dev: 0n });
  assert.equal(none.ino, null);
  assert.equal(sameIdentity(none, none), false);
});

test('reads back the plain numbers an older build froze', () => {
  assert.equal(identityText(4242), '4242');
  assert.equal(identityText(4242n), '4242');
  assert.equal(identityText('4242'), '4242');
  assert.equal(
    sameIdentity(identityOf({ ino: 4242, dev: 66 }), identityOf({ ino: 4242n, dev: 66n })),
    true,
  );
});

test('refuses anything that is not a whole, unsigned id', () => {
  for (const value of [null, undefined, -1, 1.5, NaN, Infinity, '', '0x10', '4242 ', '-1', {}]) {
    assert.equal(identityText(value), null, `${String(value)} is not an id`);
  }
});

test('reads the real filesystem exactly, by path, by link and by descriptor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-identity-'));
  try {
    const file = path.join(root, 'report.txt');
    fs.writeFileSync(file, 'PUBLIC!!');
    const stats = fs.lstatSync(file, { bigint: true });

    assert.equal(lstatIdentitySync(file).ino, stats.ino.toString());
    assert.equal(lstatIdentitySync(file).dev, stats.dev.toString());
    assert.equal(sameIdentity(statIdentitySync(file), lstatIdentitySync(file)), true);

    const fd = fs.openSync(file, fs.constants.O_RDONLY);
    try {
      assert.equal(sameIdentity(fstatIdentitySync(fd), lstatIdentitySync(file)), true);
    } finally { fs.closeSync(fd); }

    const other = path.join(root, 'other.txt');
    fs.writeFileSync(other, 'SECRET!!');
    assert.equal(sameIdentity(lstatIdentitySync(other), lstatIdentitySync(file)), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
