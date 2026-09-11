import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./release-preflight.mjs', import.meta.url));
for (const newline of ['\n', '\r\n']) {
  for (const mismatch of [false, true]) {
    test(`preflight ${newline === '\n' ? 'LF' : 'CRLF'} ${mismatch ? 'rejects mismatch' : 'accepts matching versions'}`, () => {
      const root = mkdtempSync(path.join(tmpdir(), 'abu-preflight-'));
      try {
        mkdirSync(path.join(root, 'src-tauri'));
        writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
        writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '1.2.3' }));
        writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), `version = "1.2.3"${newline}`);
        writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), `[[package]]${newline}name = "abu"${newline}version = "${mismatch ? '1.2.2' : '1.2.3'}"${newline}`);
        writeFileSync(path.join(root, 'CHANGELOG.md'), `## v1.2.3${newline}Fixed release checks.${newline}`);
        writeFileSync(path.join(root, 'CHANGELOG.zh-CN.md'), `## v1.2.3${newline}修复发布检查。${newline}`);
        const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, mismatch ? 1 : 0, result.stdout + result.stderr);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
