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
// Both home pages run the same script; it picks its language from <html lang>.
const script = fs.readFileSync(path.join(root, 'website/home.js'), 'utf8');

test('home script uses the dedicated bilingual Electron release metadata', () => {
  for (const key of ['mac-arm64', 'mac-x64', 'windows-x64']) {
    assert.ok(script.includes(`downloads['${key}']?.url`), `home.js is missing ${key}`);
  }
  assert.ok(
    script.includes('`${OSS_BASE}/electron/latest-release.json`'),
    'home.js must use the Electron website release pointer',
  );
  assert.ok(
    script.includes('const releasePath = `/releases/${version}/`'),
    'home.js must bind installer paths to the metadata version',
  );
  assert.ok(
    script.includes('url.origin !== OSS_BASE || !url.pathname.startsWith(releasePath)'),
    'home.js must reject installer URLs outside the official OSS release path',
  );
  assert.ok(
    script.includes("trustedDownloadUrl(downloads['mac-arm64']?.url, '.dmg', data.version)"),
    'home.js must validate installers against the metadata version',
  );
  assert.ok(script.includes('.catch(markDownloadUnavailable)'), 'home.js must fail closed');
  assert.ok(!script.includes('/latest.json'), 'home.js still reads the frozen Tauri pointer');
  assert.ok(!script.includes('raw.githubusercontent.com'), 'home.js still depends on GitHub Raw');
  assert.ok(!script.includes('browser_download_url'), 'home.js still links through GitHub');
});

test('the GitHub API serves the star count only', () => {
  // The shared script reads the count for every page that shows it; the home script does not touch the API.
  const shared = fs.readFileSync(path.join(root, 'website/site.js'), 'utf8');
  assert.equal(shared.split('api.github.com').length - 1, 1, 'site.js must call the GitHub API exactly once');
  assert.ok(shared.includes("fetch('https://api.github.com/repos/PM-Shawn/Abu-Cowork')"));
  assert.ok(shared.includes("document.getElementById('stars')"));
  assert.ok(!script.includes('api.github.com'), 'home.js must not call the GitHub API');
  assert.ok(!script.includes('/releases/latest') && !shared.includes('/releases/latest'), 'installer links must not come from the GitHub API');
});

for (const page of pages) {
  test(`${page.file} keeps the installer links closed until metadata resolves`, () => {
    const source = fs.readFileSync(path.join(root, page.file), 'utf8');

    for (const id of ['dlMacSilicon', 'dlMacIntel', 'dlWindows']) {
      assert.ok(
        source.includes(`href="/" id="${id}"`),
        `${page.file} ${id} must stay on the official website until metadata resolves`,
      );
      assert.match(source, new RegExp(`id="${id}"[^>]*aria-disabled="true"`), `${page.file} ${id} must start disabled`);
    }
    assert.ok(source.includes('id="dlChevron"') && source.includes('id="dlMenu" hidden'), `${page.file} is missing the installer list`);
    assert.ok(source.includes('id="dlPrimaryLabel"'), `${page.file} is missing the download label`);
    assert.ok(source.includes(`href="${page.help}"`), `${page.file} has the wrong help locale`);
    assert.equal(source.split('data-release-version').length - 1, 2, `${page.file} must show the version in the hero and the closing block`);
    assert.ok(source.includes('<script src="home.js"></script>'), `${page.file} must load the home script`);
    assert.ok(!source.includes('id="dlVersion"'), `${page.file} still shows a dropdown version`);
    assert.ok(!source.includes('/latest.json'), `${page.file} still reads the frozen Tauri pointer`);
    assert.ok(!source.includes('api.github.com'), `${page.file} still depends on the GitHub API`);
    assert.ok(!source.includes('raw.githubusercontent.com'), `${page.file} still depends on GitHub Raw`);
    assert.ok(!source.includes('browser_download_url'), `${page.file} still links through GitHub`);
  });
}

test('English and Chinese documentation pages select different notes from the same metadata record', () => {
  // The release notes are shown by the documentation viewer; each page takes its own language and never the other one.
  const viewer = fs.readFileSync(path.join(root, 'website/docs.js'), 'utf8');
  assert.match(fs.readFileSync(path.join(root, 'website/docs.html'), 'utf8'), /<html lang="en">/);
  assert.match(fs.readFileSync(path.join(root, 'website/docs.zh-CN.html'), 'utf8'), /<html lang="zh-CN">/);
  assert.ok(viewer.includes("const zh = document.documentElement.lang.toLowerCase().indexOf('zh') === 0;"));
  assert.ok(viewer.includes("'changelog': { release: 'zh-CN', title: '更新日志' }"));
  assert.ok(viewer.includes("'changelog': { release: 'en-US', title: 'Release notes' }"));
  assert.ok(
    viewer.includes("const notes = ((data.notes_i18n || {})[doc.release] || '').trim();"),
    'docs.js must not fall back to another language',
  );
});
