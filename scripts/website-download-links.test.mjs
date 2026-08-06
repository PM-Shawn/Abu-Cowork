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
    for (const id of ['dlMacSilicon', 'dlMacIntel', 'dlWindows']) {
      assert.ok(
        source.includes(`href="/" id="${id}"`),
        `${page} ${id} must stay on the official website until metadata resolves`,
      );
    }
    assert.ok(
      source.includes('.then(d => applyFromOSS(d.tag_name))'),
      `${page} must convert fallback release metadata into OSS download URLs`,
    );
    assert.ok(source.includes('.catch(markDownloadUnavailable)'), `${page} must fail closed on the homepage`);
    assert.ok(!source.includes('browser_download_url'), `${page} still links installers through GitHub`);
    assert.ok(!source.includes('GH_LATEST'), `${page} still has a GitHub release-page fallback`);
    assert.ok(!source.includes('Abu_${ver}'), `${page} still contains a legacy Tauri installer name`);
  });
}
