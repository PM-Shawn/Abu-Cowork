import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = ['website/index.html', 'website/index.zh-CN.html'];
const expectedLinks = [
  'macSilicon: `${OSS_BASE}/releases/${tag}/Abu-${ver}-mac-arm64.dmg`,',
  'macIntel:   `${OSS_BASE}/releases/${tag}/Abu-${ver}-mac-x64.dmg`,',
  'windows:    `${OSS_BASE}/releases/${tag}/Abu-${ver}-windows-x64-setup.exe`,',
];

for (const page of pages) {
  test(`${page} uses Electron installer names`, () => {
    const source = fs.readFileSync(path.join(root, page), 'utf8');

    for (const link of expectedLinks) {
      assert.ok(source.includes(link), `${page} is missing ${link}`);
    }
    assert.ok(
      source.includes('macSilicon: find(/(?:aarch64|arm64).*\\.dmg$/i),'),
      `${page} GitHub fallback must recognize Electron arm64 DMGs`
    );
    assert.ok(!source.includes('Abu_${ver}'), `${page} still contains a legacy Tauri installer name`);
  });
}
