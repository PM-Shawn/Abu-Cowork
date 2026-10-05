import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const websiteDir = path.join(root, 'website');

const BAIDU_TONGJI_SITE_ID = '01567fba26100539d5fb9f494c789f4d';
const BAIDU_TONGJI_SNIPPET = [
  '<script>',
  'var _hmt = _hmt || [];',
  '(function() {',
  'var hm = document.createElement("script");',
  `hm.src = "https://hm.baidu.com/hm.js?${BAIDU_TONGJI_SITE_ID}";`,
  'var s = document.getElementsByTagName("script")[0];',
  's.parentNode.insertBefore(hm, s);',
  '})();',
  '</script>',
].join('\n');

const pages = fs.readdirSync(websiteDir).filter((name) => name.endsWith('.html'));

function headLines(page) {
  const source = fs.readFileSync(path.join(websiteDir, page), 'utf8');
  const head = source.slice(0, source.indexOf('</head>'));
  return head.split('\n').map((line) => line.trim()).join('\n');
}

test('website has pages to track', () => {
  assert.ok(pages.length > 0, 'website/ contains no HTML pages');
});

for (const page of pages) {
  test(`website/${page} loads Baidu Tongji in <head>`, () => {
    const head = headLines(page);
    const occurrences = head.split(BAIDU_TONGJI_SNIPPET).length - 1;

    assert.equal(occurrences, 1, `website/${page} must contain the Baidu Tongji snippet exactly once before </head>`);
  });
}
