import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  extractArchive,
  listArchiveEntries,
  packAppArchive,
  validateArchiveEntries,
} from './electron-tauri-transition.mjs';

const require = createRequire(import.meta.url);

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-transition-archive-test-'));
  const app = path.join(root, 'Abu.app');
  const contents = path.join(app, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), '<plist/>');
  fs.writeFileSync(path.join(contents, 'MacOS', 'Abu'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(contents, 'Resources', 'payload.txt'), 'payload');
  fs.symlinkSync('payload.txt', path.join(contents, 'Resources', 'payload-link'));
  return { root, app };
}

test(
  'packs exactly one Abu.app root and preserves executable mode and symlinks',
  { skip: process.platform !== 'darwin' },
  () => {
    const { root, app } = fixture();
    const archive = path.join(root, 'Abu_aarch64_electron-transition.app.tar.gz');
    const extracted = path.join(root, 'extracted');
    try {
      const summary = packAppArchive(app, archive);
      assert.equal(summary.rootName, 'Abu.app');
      const entries = listArchiveEntries(archive);
      assert.equal(entries.some((entry) => entry.startsWith('./')), false);
      assert.equal(entries.some((entry) => entry.includes('._')), false);

      extractArchive(archive, extracted);
      const executable = path.join(extracted, 'Abu.app', 'Contents', 'MacOS', 'Abu');
      const link = path.join(extracted, 'Abu.app', 'Contents', 'Resources', 'payload-link');
      fs.accessSync(executable, fs.constants.X_OK);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(link), 'payload.txt');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

test('rejects extra roots, traversal, dot roots, and AppleDouble metadata', () => {
  const base = [
    'Abu.app/',
    'Abu.app/Contents/',
    'Abu.app/Contents/Info.plist',
    'Abu.app/Contents/MacOS/Abu',
  ];
  for (const entry of [
    'Other.app/Contents/Info.plist',
    'Abu.app/../Other.app/file',
    './Abu.app/Contents/Info.plist',
    'Abu.app/Contents/Resources/._secret',
    'Abu.app/__MACOSX/file',
  ]) {
    assert.throws(() => validateArchiveEntries([...base, entry]), /archive entry/);
  }
});

test('electron-builder keeps migration disabled unless release CI sets boolean true', async () => {
  const { createYargs, configureBuildCommand, normalizeOptions } = require(
    'electron-builder/out/builder'
  );
  const { getConfig } = require('app-builder-lib/out/util/config/config');
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const base = await getConfig(projectDir, null, null);
  assert.equal(base.extraMetadata.abuRelease.tauriMigration, false);

  const parser = configureBuildCommand(createYargs());
  const parsed = await parser.parseAsync([
    '--dir',
    '--config.extraMetadata.version=0.34.0',
    '--config.extraMetadata.abuRelease.tauriMigration=true',
  ]);
  const normalized = normalizeOptions(parsed);
  const transition = await getConfig(projectDir, null, normalized.config);
  assert.equal(transition.extraMetadata.abuRelease.tauriMigration, true);
  assert.equal(typeof transition.extraMetadata.abuRelease.tauriMigration, 'boolean');
  assert.equal(transition.extraMetadata.version, '0.34.0');
});
