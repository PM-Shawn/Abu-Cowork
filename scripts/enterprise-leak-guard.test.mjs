import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageScripts = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
const LEAK_COMMAND = 'npm run check:enterprise-leak';

// Children must not inherit the caller's HUSKY switch (HUSKY=0 disables hooks) or
// git's hook-time variables (GIT_DIR / GIT_INDEX_FILE when this suite runs inside a hook).
function cleanEnv() {
  const env = { ...process.env };
  delete env.HUSKY;
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, env: cleanEnv(), encoding: 'utf8' });
}

// A throwaway repo wired exactly like a real checkout: the real guard script,
// the real npm script, the real .husky/pre-commit, installed by the real husky.
function fixtureRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'abu-leak-guard-'));
  // Callers only clean up once they hold the path, so a failed setup removes its own directory.
  try {
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, '.husky'));
    mkdirSync(path.join(root, 'src'));
    copyFileSync(
      path.join(repoRoot, 'scripts/enterprise-leak-guard.sh'),
      path.join(root, 'scripts/enterprise-leak-guard.sh'),
    );
    copyFileSync(path.join(repoRoot, '.husky/pre-commit'), path.join(root, '.husky/pre-commit'));
    writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'leak-guard-fixture',
        private: true,
        scripts: { 'check:enterprise-leak': packageScripts['check:enterprise-leak'] },
      }),
    );
    writeFileSync(path.join(root, 'src/ok.ts'), 'export const ok = true;\n');
    assert.equal(run('git', ['init', '-q'], root).status, 0);
    const husky = run(process.execPath, [path.join(repoRoot, 'node_modules/husky/bin.js')], root);
    assert.equal(husky.status, 0, husky.stderr);
    assert.equal(run('git', ['config', 'core.hooksPath'], root).stdout.trim(), '.husky/_');
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

test('CI, the pre-commit hook, and verify all run the same leak-guard command', () => {
  assert.equal(packageScripts['check:enterprise-leak'], 'bash scripts/enterprise-leak-guard.sh');

  const ci = YAML.parse(readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  const step = ci.jobs['leak-guard'].steps.find((s) => s.name === 'Enterprise leak guard (open-core)');
  assert.equal(step?.run, LEAK_COMMAND);

  const stages = packageScripts['verify:full'].split(' && ');
  assert.equal(stages[0], LEAK_COMMAND, 'verify:full must run the leak guard first');

  const hook = readFileSync(path.join(repoRoot, '.husky/pre-commit'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  assert.equal(hook[0], LEAK_COMMAND, 'the hook must run the leak guard before lint-staged');
});

test('the pre-commit hook blocks a commit that stages a closed-source enterprise file', () => {
  const root = fixtureRepo();
  try {
    mkdirSync(path.join(root, 'src/core/kb'), { recursive: true });
    writeFileSync(path.join(root, 'src/core/kb/query.ts'), 'export const leaked = true;\n');
    assert.equal(run('git', ['add', '-A'], root).status, 0);

    const commit = run(
      'git',
      ['-c', 'user.name=leak-guard', '-c', 'user.email=leak-guard@example.invalid', 'commit', '-m', 'leak'],
      root,
    );
    assert.notEqual(commit.status, 0, 'the commit must be rejected');
    const output = commit.stdout + commit.stderr;
    assert.match(output, /Enterprise closed-source module\(s\) found/);
    assert.match(output, /src\/core\/kb\/query\.ts/);
    assert.match(output, /husky - pre-commit script failed/);
    assert.notEqual(run('git', ['rev-parse', '--verify', '-q', 'HEAD'], root).status, 0, 'no commit may be created');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the leak-guard command passes on a tree without closed-source files', () => {
  const root = fixtureRepo();
  try {
    assert.equal(run('git', ['add', '-A'], root).status, 0);
    const result = run('npm', ['run', 'check:enterprise-leak'], root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /no closed-source enterprise modules in OSS tree/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
