'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { replayFile } = require('./replay-computer-use.cjs');

function fixture(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-cu-replay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, contents);
  return file;
}
const event = { schemaVersion: 1, process: 'main', event: 'main.computer_use_trajectory', timestamp: 100,
  appSessionId: 'a1111111-1111-4111-8111-111111111111', trajectoryVersion: 1,
  trajectoryId: 'b1111111-1111-4111-8111-111111111111', computerRunId: 'cu-0123456789abcdef01234567',
  trajectorySequence: 1, stage: 'turn-stopped', reason: 'user-stopped', text: 'private-text' };

test('CLI and runtime use the same read-only privacy-safe replay projection', (t) => {
  const file = fixture(t, JSON.stringify(event));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'replay-computer-use.cjs'), file], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), replayFile(file));
  assert.equal(result.stdout.includes('private-text'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(event));
});

test('partial final record yields incomplete diagnostics and a nonzero CLI result', (t) => {
  const file = fixture(t, `${JSON.stringify(event)}\n{"event":`);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'replay-computer-use.cjs'), file], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).complete, false);
});

test('missing, oversized and empty logs are not reported as successful evaluation', (t) => {
  const file = fixture(t, '');
  assert.throws(() => replayFile(`${file}-missing`), /unavailable/);
  assert.throws(() => replayFile(fixture(t, '123456'), { maxBytes: 5 }), /too-large/);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'replay-computer-use.cjs'), file], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).runs.length, 0);
});
