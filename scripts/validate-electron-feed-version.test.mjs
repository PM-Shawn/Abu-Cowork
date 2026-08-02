import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertElectronFeedCanAdvance,
  readElectronFeedVersion,
} from './validate-electron-feed-version.mjs';

test('reads electron-builder YAML metadata versions', () => {
  assert.equal(
    readElectronFeedVersion('version: 0.35.0\npath: Abu-0.35.0.dmg\n'),
    '0.35.0',
  );
});

test('allows a newer release and an idempotent same-version retry', () => {
  const feed = 'version: 0.35.0\npath: Abu-0.35.0.dmg\n';
  assert.deepEqual(assertElectronFeedCanAdvance('0.36.0', feed), {
    candidateVersion: '0.36.0',
    currentVersion: '0.35.0',
  });
  assert.deepEqual(assertElectronFeedCanAdvance('v0.35.0', feed), {
    candidateVersion: '0.35.0',
    currentVersion: '0.35.0',
  });
});

test('rejects an older release and malformed current metadata', () => {
  assert.throws(
    () => assertElectronFeedCanAdvance('0.35.0', 'version: 0.36.0\n'),
    /must not replace newer published 0\.36\.0/,
  );
  assert.throws(
    () => readElectronFeedVersion('path: Abu-0.36.0.dmg\n'),
    /invalid published Electron feed version/,
  );
});
