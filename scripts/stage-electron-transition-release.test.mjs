import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { stageRelease } from './stage-electron-transition-release.mjs';

function sha512(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function writeFeed(directory, metadataName, version, artifactName) {
  fs.mkdirSync(directory, { recursive: true });
  const artifact = path.join(directory, artifactName);
  const blockmap = `${artifact}.blockmap`;
  fs.writeFileSync(artifact, `${artifactName}-bytes`);
  fs.writeFileSync(blockmap, `${artifactName}-blockmap`);
  fs.writeFileSync(
    path.join(directory, metadataName),
    YAML.stringify({
      version,
      files: [
        {
          url: artifactName,
          sha512: sha512(artifact),
          size: fs.statSync(artifact).size,
          blockMapSize: fs.statSync(blockmap).size,
        },
      ],
      path: artifactName,
      sha512: sha512(artifact),
    })
  );
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-release-stage-test-'));
  const input = path.join(root, 'input');
  const arm = path.join(input, 'mac-arm64');
  const x64 = path.join(input, 'mac-x64');
  const win = path.join(input, 'windows-x64');
  writeFeed(arm, 'latest-mac.yml', '0.34.0', 'Abu-0.34.0-arm64.zip');
  writeFeed(x64, 'latest-mac.yml', '0.34.0', 'Abu-0.34.0-x64.zip');
  writeFeed(win, 'latest.yml', '0.34.0', 'Abu-0.34.0-windows-x64-setup.exe');
  fs.writeFileSync(path.join(arm, 'Abu-0.34.0-arm64.dmg'), 'arm-dmg');
  fs.writeFileSync(path.join(x64, 'Abu-0.34.0-x64.dmg'), 'x64-dmg');
  for (const [directory, name] of [
    [arm, 'Abu_aarch64_electron-transition.app.tar.gz'],
    [x64, 'Abu_x64_electron-transition.app.tar.gz'],
    [win, 'Abu-0.34.0-windows-x64-setup.exe'],
  ]) {
    if (!fs.existsSync(path.join(directory, name))) fs.writeFileSync(path.join(directory, name), name);
    fs.writeFileSync(path.join(directory, `${name}.sig`), `${name}-signature`);
  }
  const changelogEn = path.join(root, 'CHANGELOG.md');
  const changelogZh = path.join(root, 'CHANGELOG.zh-CN.md');
  fs.writeFileSync(changelogEn, '# Changelog\n\n## v0.34.0\n\nEnglish notes\n');
  fs.writeFileSync(changelogZh, '# 更新日志\n\n## v0.34.0\n\n中文说明\n');
  return { root, input, changelogEn, changelogZh };
}

test('stages all three transition platforms and three isolated updater feeds', () => {
  const fx = fixture();
  const output = path.join(fx.root, 'output');
  try {
    const result = stageRelease({
      input: fx.input,
      output,
      version: 'v0.34.0',
      repo: 'PM-Shawn/Abu-Cowork',
      releaseBaseUrl: 'https://example.invalid/releases/v0.34.0',
      changelogEn: fx.changelogEn,
      changelogZh: fx.changelogZh,
    });
    assert.deepEqual(Object.keys(result.latest.platforms).sort(), [
      'darwin-aarch64',
      'darwin-x86_64',
      'windows-x86_64',
    ]);
    assert.equal(result.latest.notes, 'English notes');
    assert.equal(result.latest.notes_i18n['zh-CN'], '中文说明');
    assert.ok(fs.existsSync(path.join(output, 'feeds', 'mac-arm64', 'latest-mac.yml')));
    assert.ok(fs.existsSync(path.join(output, 'feeds', 'mac-x64', 'latest-mac.yml')));
    assert.ok(fs.existsSync(path.join(output, 'feeds', 'win-x64', 'latest.yml')));
    assert.match(
      fs.readFileSync(path.join(output, 'content-map.tsv'), 'utf8'),
      /electron\/win-x64\/Abu-0\.34\.0-windows-x64-setup\.exe/
    );
    assert.equal(result.checksums.every((entry) => entry.sha256.length === 64), true);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('rejects a feed whose hash does not match the staged artifact', () => {
  const fx = fixture();
  try {
    fs.appendFileSync(path.join(fx.input, 'mac-x64', 'Abu-0.34.0-x64.zip'), 'tamper');
    assert.throws(
      () =>
        stageRelease({
          input: fx.input,
          output: path.join(fx.root, 'output'),
          version: '0.34.0',
          repo: 'PM-Shawn/Abu-Cowork',
          releaseBaseUrl: 'https://example.invalid/releases/v0.34.0',
          changelogEn: fx.changelogEn,
          changelogZh: fx.changelogZh,
        }),
      /sha512 mismatch/
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
