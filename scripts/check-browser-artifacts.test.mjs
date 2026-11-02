import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionFiles = [
  'background.js', 'background.js.map', 'content.js', 'content.js.map',
  'offscreen.js', 'offscreen.js.map', 'popup.js', 'popup.js.map',
  'manifest.json', 'popup.html', 'offscreen.html',
];
const extensionDirs = ['abu-chrome-extension/dist', 'src-tauri/browser-extension'];

async function fixture(t) {
  mkdirSync(path.join(root, '.agent'), { recursive: true });
  const dir = mkdtempSync(path.join(root, '.agent/browser-artifacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'scripts/check-browser-artifacts.mjs');
  mkdirSync(path.dirname(script), { recursive: true });
  copyFileSync(path.join(root, 'scripts/check-browser-artifacts.mjs'), script);
  const copyScript = path.join(dir, 'scripts/copy-resources.js');
  copyFileSync(path.join(root, 'scripts/copy-resources.js'), copyScript);
  const checker = await import(pathToFileURL(script).href);
  const write = (relative, content) => {
    const destination = path.join(dir, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  for (const source of new Set(checker.ARTIFACTS.flatMap(entry => entry.sources))) {
    write(path.extname(source) ? source : `${source}/fixture.ts`, 'export const value = 1;\n');
  }
  for (const entry of checker.ARTIFACTS) write(entry.artifact, '// current build\n');
  for (const output of extensionDirs) {
    for (const file of extensionFiles) write(`${output}/${file}`, '// current build\n');
  }
  for (const entry of checker.ARTIFACTS) checker.recordSourceDigest(entry.artifact);
  const check = () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  assert.equal(check().status, 0, 'the complete initial build must pass');
  const copy = () => spawnSync(process.execPath, [copyScript], { encoding: 'utf8' });
  return { dir, write, check, copy };
}

for (const output of extensionDirs) {
  for (const file of extensionFiles) {
    test(`rejects a missing ${output}/${file}`, async t => {
      const { dir, check } = await fixture(t);
      rmSync(path.join(dir, output, file));
      const result = check();
      assert.equal(result.status, 1);
      assert.ok(result.output.includes(`MISSING ${output}/${file}`));
    });

    test(`rejects a replaced ${output}/${file} with unchanged source stamps`, async t => {
      const { write, check } = await fixture(t);
      write(`${output}/${file}`, '// previous build\n');
      const result = check();
      assert.equal(result.status, 1);
      assert.ok(result.output.includes(`STALE ${output}/${file}`));
    });
  }
}

for (const source of ['manifest.json', 'package.json', 'package-lock.json', 'build.js']) {
  test(`requires rebuilding after the extension ${source} changes`, async t => {
    const { write, check } = await fixture(t);
    write(`abu-chrome-extension/${source}`, '{}\n');
    assert.equal(check().status, 1);
  });
}

test('does not require rebuilding after a test-only source changes', async t => {
  const { write, check } = await fixture(t);
  write('abu-chrome-extension/src/fixture.test.ts', 'export const testValue = 2;\n');
  assert.equal(check().status, 0);
});

test('copying verified extension outputs preserves a passing build', async t => {
  const { copy, check } = await fixture(t);
  const result = copy();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(check().status, 0);
});

test('refuses copying an extension built from previous sources', async t => {
  const { write, copy } = await fixture(t);
  write('abu-chrome-extension/src/fixture.ts', 'export const value = 2;\n');
  const result = copy();
  assert.ifError(result.error);
  assert.equal(result.status, 1);
});

test('refuses copying a replaced extension output with its original build record', async t => {
  const { write, copy } = await fixture(t);
  write('abu-chrome-extension/dist/background.js', '// previous build\n');
  const result = copy();
  assert.ifError(result.error);
  assert.equal(result.status, 1);
});
