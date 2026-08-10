import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertWebsiteReleaseCanAdvance,
  createWebsiteReleaseMetadata,
  readWebsiteReleaseVersion,
} from './website-release-metadata.mjs';

function metadata(version = 'v0.36.0') {
  return createWebsiteReleaseMetadata({
    version,
    releaseBaseUrl: `https://example.invalid/releases/${version}`,
    downloads: {
      'mac-arm64': 'Abu-0.36.0-mac-arm64.dmg',
      'mac-x64': 'Abu-0.36.0-mac-x64.dmg',
      'windows-x64': 'Abu-0.36.0-windows-x64-setup.exe',
    },
    notesEn: 'English notes',
    notesZh: '中文说明',
  });
}

test('creates one release record with explicit downloads and two locale-specific notes', () => {
  const result = metadata();
  assert.equal(result.schema_version, 1);
  assert.equal(result.version, 'v0.36.0');
  assert.deepEqual(Object.keys(result.downloads), ['mac-arm64', 'mac-x64', 'windows-x64']);
  assert.equal(result.notes_i18n['en-US'], 'English notes');
  assert.equal(result.notes_i18n['zh-CN'], '中文说明');
  assert.equal(
    result.downloads['mac-arm64'].url,
    'https://example.invalid/releases/v0.36.0/Abu-0.36.0-mac-arm64.dmg',
  );
});

test('requires both languages and platform-appropriate installer extensions', () => {
  const base = {
    version: 'v0.36.0',
    releaseBaseUrl: 'https://example.invalid/releases/v0.36.0',
    downloads: {
      'mac-arm64': 'Abu-arm64.dmg',
      'mac-x64': 'Abu-x64.dmg',
      'windows-x64': 'Abu.exe',
    },
    notesEn: 'English',
    notesZh: '中文',
  };
  assert.throws(
    () => createWebsiteReleaseMetadata({ ...base, notesZh: '' }),
    /missing Chinese release notes/,
  );
  assert.throws(
    () => createWebsiteReleaseMetadata({ ...base, notesEn: 'English 中文' }),
    /English release notes.*must not contain CJK text/,
  );
  assert.throws(
    () => createWebsiteReleaseMetadata({ ...base, notesZh: 'Chinese notes' }),
    /Chinese release notes.*must contain CJK text/,
  );
  assert.throws(
    () =>
      createWebsiteReleaseMetadata({
        ...base,
        downloads: {
          'mac-arm64': 'Abu.exe',
          'mac-x64': 'Abu.dmg',
          'windows-x64': 'Abu.exe',
        },
      }),
    /mac-arm64 installer must end with \.dmg/,
  );
});

test('allows equal or newer metadata and rejects downgrades or malformed records', () => {
  const current = JSON.stringify(metadata());
  assert.equal(readWebsiteReleaseVersion(current), '0.36.0');
  assert.deepEqual(assertWebsiteReleaseCanAdvance('v0.36.0', current), {
    candidateVersion: '0.36.0',
    currentVersion: '0.36.0',
  });
  assert.deepEqual(assertWebsiteReleaseCanAdvance('v0.37.0', current), {
    candidateVersion: '0.37.0',
    currentVersion: '0.36.0',
  });
  assert.throws(
    () => assertWebsiteReleaseCanAdvance('v0.35.0', current),
    /must not replace newer published 0\.36\.0/,
  );
  assert.throws(() => readWebsiteReleaseVersion('{}'), /unsupported schema/);
});
