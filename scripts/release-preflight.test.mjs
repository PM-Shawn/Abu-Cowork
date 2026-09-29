import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PREFLIGHT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-preflight.mjs');
const VERSION = '1.2.3';
const TAG = `v${VERSION}`;

// 隔离用户与系统级 git 配置（签名、hooks、默认分支名），并固定提交时间，保证 SHA 与行为确定
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Preflight Test',
  GIT_AUTHOR_EMAIL: 'preflight@example.invalid',
  GIT_COMMITTER_NAME: 'Preflight Test',
  GIT_COMMITTER_EMAIL: 'preflight@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeReleaseFiles(dir) {
  mkdirSync(path.join(dir, 'src-tauri'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'abu', version: VERSION }));
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'abu', version: VERSION, packages: { '': { name: 'abu', version: VERSION } } }),
  );
  writeFileSync(path.join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: VERSION }));
  writeFileSync(path.join(dir, 'src-tauri/Cargo.toml'), `[package]\nname = "abu"\nversion = "${VERSION}"\n`);
  writeFileSync(path.join(dir, 'src-tauri/Cargo.lock'), `[[package]]\nname = "abu"\nversion = "${VERSION}"\n`);
  writeFileSync(path.join(dir, 'CHANGELOG.md'), `# Changelog\n\n## v${VERSION}\n\n- Fixed release checks.\n`);
  writeFileSync(path.join(dir, 'CHANGELOG.zh-CN.md'), `# 更新日志\n\n## v${VERSION}\n\n- 修复发版检查。\n`);
}

// 建一个本地仓库：main 上一个提交作为 origin/main，另一个分支上再多一个提交；不配置远程、不联网
function createRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'abu-release-preflight-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  writeReleaseFiles(dir);
  git(dir, ['add', '.']);
  git(dir, ['commit', '--quiet', '-m', 'release']);
  const mainSha = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['update-ref', 'refs/remotes/origin/main', mainSha]);
  git(dir, ['checkout', '--quiet', '-b', 'side']);
  git(dir, ['commit', '--quiet', '--allow-empty', '-m', 'not promoted']);
  const sideSha = git(dir, ['rev-parse', 'HEAD']);
  return { dir, mainSha, sideSha };
}

function runPreflight(dir, extraArgs, eventName) {
  const result = spawnSync(
    process.execPath,
    [PREFLIGHT, '--tag', TAG, '--skip-branch-protection', ...extraArgs],
    {
      cwd: dir,
      encoding: 'utf8',
      // --skip-branch-protection 只允许在 GitHub Actions 里使用，这里按发版 CI 的环境运行
      env: { ...process.env, ...GIT_ENV, GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: eventName },
    },
  );
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('fails when the stable tag points at a commit that is not on origin/main', (t) => {
  const { dir, sideSha } = createRepo(t);
  git(dir, ['tag', TAG, sideSha]);
  const { status, output } = runPreflight(dir, [], 'push');
  assert.notEqual(status, 0, output);
  assert.match(output, /not on origin\/main/);
  assert.match(output, new RegExp(`tag ${TAG} points to commit ${sideSha}`));
});

test('passes when the stable tag points at the origin/main commit', (t) => {
  const { dir, mainSha } = createRepo(t);
  git(dir, ['tag', TAG, mainSha]);
  const { status, output } = runPreflight(dir, [], 'push');
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /not on origin\/main/);
  assert.match(output, /Release preflight passed/);
});

test('rejects --skip-tag-commit-check on a tag push', (t) => {
  const { dir, sideSha } = createRepo(t);
  git(dir, ['tag', TAG, sideSha]);
  const { status, output } = runPreflight(dir, ['--skip-tag-commit-check'], 'push');
  assert.notEqual(status, 0, output);
  assert.match(output, /--skip-tag-commit-check is only allowed in a manually dispatched release workflow run/);
  assert.doesNotMatch(output, /Release preflight passed/);
});

test('a manually dispatched candidate build may skip the tag commit check', (t) => {
  const { dir, sideSha } = createRepo(t);
  git(dir, ['tag', TAG, sideSha]);
  const { status, output } = runPreflight(dir, ['--skip-tag-commit-check'], 'workflow_dispatch');
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /not on origin\/main/);
});
