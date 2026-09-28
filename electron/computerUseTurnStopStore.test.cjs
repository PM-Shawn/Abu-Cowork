'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createComputerUseTurnStopStore,
  hashTurnKey,
} = require('./computerUseTurnStopStore.cjs');

test('turn-stop markers survive a store reload without persisting raw conversation ids', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-cu-stop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'stopped-turns.json');
  let now = 1000;
  const first = createComputerUseTurnStopStore({ filePath, now: () => now });
  const key = 'conversation-secret\u0000loop-secret';

  const marker = first.stop(key, 'User clicked STOP');
  assert.equal(marker.persisted, true);
  assert.equal(marker.reason, 'user-clicked-stop');
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.includes('conversation-secret'), false);
  assert.equal(raw.includes('loop-secret'), false);
  assert.equal(raw.includes(hashTurnKey(key)), true);

  const reloaded = createComputerUseTurnStopStore({ filePath, now: () => now });
  assert.equal(reloaded.get(key)?.reason, 'user-clicked-stop');

  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(reloaded.get(key), null);
});

test('an unavailable persistence path keeps the in-memory stop boundary fail closed', () => {
  const errors = [];
  const store = createComputerUseTurnStopStore({
    filePath: '\0invalid',
    onError: (error) => errors.push(error),
  });
  const marker = store.stop('conversation\u0000loop', 'physical Escape');
  assert.equal(marker.persisted, false);
  assert.equal(store.get('conversation\u0000loop')?.reason, 'physical-escape');
  assert.equal(errors.length > 0, true);
});
