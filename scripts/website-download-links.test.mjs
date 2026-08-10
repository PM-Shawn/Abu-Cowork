import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pages = [
  { file: 'website/index.html', locale: 'en-US', help: 'docs.html#installation' },
  { file: 'website/index.zh-CN.html', locale: 'zh-CN', help: 'docs.zh-CN.html#installation' },
];

for (const page of pages) {
  test(`${page.file} uses the dedicated bilingual Electron release metadata`, () => {
    const source = fs.readFileSync(path.join(root, page.file), 'utf8');

    for (const id of ['dlMacSilicon', 'dlMacIntel', 'dlWindows']) {
      assert.ok(
        source.includes(`href="/" id="${id}"`),
        `${page.file} ${id} must stay on the official website until metadata resolves`,
      );
    }
    for (const key of ['mac-arm64', 'mac-x64', 'windows-x64']) {
      assert.ok(source.includes(`downloads['${key}']?.url`), `${page.file} is missing ${key}`);
    }
    assert.ok(
      source.includes('`${OSS_BASE}/electron/latest-release.json`'),
      `${page.file} must use the Electron website release pointer`,
    );
    assert.ok(
      source.includes('const releasePath = `/releases/${version}/`'),
      `${page.file} must bind installer paths to the metadata version`,
    );
    assert.ok(
      source.includes('url.origin !== OSS_BASE || !url.pathname.startsWith(releasePath)'),
      `${page.file} must reject installer URLs outside the official OSS release path`,
    );
    assert.ok(
      source.includes("trustedDownloadUrl(downloads['mac-arm64']?.url, '.dmg', data.version)"),
      `${page.file} must validate installers against the metadata version`,
    );
    assert.ok(
      source.includes("paintNotes(data.version, i18n[key] || '')"),
      `${page.file} must not fall back to another language`,
    );
    assert.ok(source.includes(`href="${page.help}"`), `${page.file} has the wrong help locale`);
    assert.ok(source.includes('.catch(markDownloadUnavailable)'), `${page.file} must fail closed`);
    assert.ok(!source.includes('id="dlVersion"'), `${page.file} still shows a dropdown version`);
    assert.ok(!source.includes('/latest.json'), `${page.file} still reads the frozen Tauri pointer`);
    assert.ok(!source.includes('api.github.com'), `${page.file} still depends on the GitHub API`);
    assert.ok(!source.includes('raw.githubusercontent.com'), `${page.file} still depends on GitHub Raw`);
    assert.ok(!source.includes('browser_download_url'), `${page.file} still links through GitHub`);
  });
}

test('English and Chinese pages select different notes from the same metadata record', () => {
  const en = fs.readFileSync(path.join(root, pages[0].file), 'utf8');
  const zh = fs.readFileSync(path.join(root, pages[1].file), 'utf8');
  assert.match(en, /<html lang="en">/);
  assert.match(zh, /<html lang="zh-CN">/);
  assert.ok(en.includes("? 'zh-CN' : 'en-US'"));
  assert.ok(zh.includes("? 'zh-CN' : 'en-US'"));
});
