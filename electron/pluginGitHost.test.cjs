'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertSafeGitUrl,
  buildCloneArgs,
  buildCheckoutArgs,
  buildSparseArgs,
  cleanGitEnv,
  PluginGitError,
} = require('./pluginGitHost.cjs');

test('assertSafeGitUrl accepts an ordinary https git url', () => {
  assert.doesNotThrow(() => assertSafeGitUrl('https://github.com/owner/repo.git'));
  assert.doesNotThrow(() => assertSafeGitUrl('https://gitlab.com/a/b'));
});

test('assertSafeGitUrl rejects non-https schemes', () => {
  for (const url of [
    'file:///etc/passwd',
    'ext::sh -c whoami',
    'ssh://git@github.com/a/b',
    'git://github.com/a/b',
    'http://github.com/a/b', // plain http not allowed
  ]) {
    assert.throws(() => assertSafeGitUrl(url), PluginGitError, `should reject ${url}`);
  }
});

test('assertSafeGitUrl rejects a url that could be read as a git option', () => {
  // A url starting with '-' would be parsed by git as a flag when it reaches
  // argv, even inside an array — reject outright.
  for (const url of ['--upload-pack=touch /tmp/x', '-c core.sshCommand=x', '   https://x/y']) {
    assert.throws(() => assertSafeGitUrl(url), PluginGitError, `should reject ${url}`);
  }
});

test('assertSafeGitUrl rejects control characters and newlines', () => {
  assert.throws(() => assertSafeGitUrl('https://x/y\n--evil'), PluginGitError);
  assert.throws(() => assertSafeGitUrl('https://x/y\x00'), PluginGitError);
});

test('buildCloneArgs uses blobless partial clone, never shallow', () => {
  const args = buildCloneArgs('https://github.com/o/r.git', '/tmp/dest');
  // blobless (can checkout any historical sha), NOT --depth (shallow can't).
  assert.ok(args.includes('--filter=blob:none'), 'must be blobless');
  assert.ok(args.includes('--no-checkout'), 'defer checkout until sparse set');
  assert.ok(!args.includes('--depth'), 'must NOT be shallow');
  // url and dest are the final two positional args, passed as array elements.
  assert.equal(args[args.length - 2], 'https://github.com/o/r.git');
  assert.equal(args[args.length - 1], '/tmp/dest');
});

test('buildSparseArgs restricts to the requested subdir with --no-cone', () => {
  const args = buildSparseArgs('/tmp/dest', 'packages/plugin');
  assert.deepEqual(args, ['-C', '/tmp/dest', 'sparse-checkout', 'set', '--no-cone', '--', 'packages/plugin']);
});

test('buildCheckoutArgs checks out the exact ref', () => {
  const args = buildCheckoutArgs('/tmp/dest', 'abc123');
  assert.deepEqual(args, ['-C', '/tmp/dest', 'checkout', '--detach', 'abc123']);
});

test('cleanGitEnv disables prompts and strips hijack vars', () => {
  const env = cleanGitEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    GIT_DIR: '/evil/.git',
    GIT_CONFIG: '/evil/config',
    GIT_CONFIG_GLOBAL: '/evil/g',
    GIT_OBJECT_DIRECTORY: '/evil/obj',
    GIT_WORK_TREE: '/evil/wt',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/evil/alt',
    GIT_SSH_COMMAND: 'sh -c evil',
    GIT_ASKPASS: '/evil/askpass',
  });
  // Non-interactive, no ambient token leakage into a prompt.
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  // Every hijack vector removed.
  for (const k of [
    'GIT_DIR', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_SSH_COMMAND', 'GIT_ASKPASS',
  ]) {
    assert.equal(env[k], undefined, `${k} must be stripped`);
  }
  // Ordinary env survives.
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
});

test('cleanGitEnv does not mutate the input', () => {
  const input = { GIT_DIR: '/x' };
  cleanGitEnv(input);
  assert.equal(input.GIT_DIR, '/x');
});

// ── fetchRemoteSource orchestration ──────────────────────────────────────────
const { fetchRemoteSource } = require('./pluginGitHost.cjs');

/** A fake git runner that records calls and returns scripted HEAD shas. */
function fakeRunner(headSha, { failOn } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (failOn && args.includes(failOn)) throw new PluginGitError(`forced fail on ${failOn}`, 'forced');
    if (args.includes('rev-parse')) return `${headSha}\n`;
    return '';
  };
  return { run, calls };
}

test('fetchRemoteSource (url): clone → checkout → sha assert → atomic move', async () => {
  const { run, calls } = fakeRunner('abc123def');
  const moved = [];
  const removed = [];
  const dest = await fetchRemoteSource(
    { kind: 'url', url: 'https://github.com/o/r.git', sha: 'abc123def' },
    {
      finalDir: '/pkgs/r',
      tmpDir: '/tmp/stage',
      runGit: run,
      move: async (from, to) => moved.push([from, to]),
      remove: async (p) => removed.push(p),
    },
  );
  const flat = calls.map((a) => a.join(' '));
  assert.ok(flat.some((c) => c.includes('clone --filter=blob:none --no-checkout')), 'clones blobless');
  assert.ok(flat.some((c) => c.includes('checkout --detach abc123def')), 'checks out the sha');
  assert.ok(flat.some((c) => c.includes('rev-parse HEAD')), 'reads HEAD for the assertion');
  assert.deepEqual(moved, [['/tmp/stage', '/pkgs/r']], 'atomic move staging → final');
  assert.equal(dest, '/pkgs/r');
});

test('fetchRemoteSource (git-subdir): adds sparse-checkout, then hoists the subdir before the sha assert', async () => {
  const r = fakeRunner('deadbeef');
  const hoisted = [];
  await fetchRemoteSource(
    { kind: 'git-subdir', url: 'https://x/y.git', path: 'pkgs/p', sha: 'deadbeef' },
    {
      finalDir: '/f',
      tmpDir: '/t',
      runGit: r.run,
      move: async () => {},
      remove: async () => {},
      hoist: async (dir, subdir) => hoisted.push([dir, subdir, r.calls.length]),
    },
  );
  const flat = r.calls.map((a) => a.join(' '));
  assert.ok(flat.some((c) => c.includes('sparse-checkout set --no-cone -- pkgs/p')));
  assert.deepEqual(hoisted, [['/t', 'pkgs/p', 3]], 'hoisted once, after clone+sparse+checkout');
  assert.ok(flat[3].includes('rev-parse HEAD'), 'sha assertion runs after the hoist');
});

test('fetchRemoteSource (url) never hoists', async () => {
  const r = fakeRunner('deadbeef');
  let hoisted = 0;
  await fetchRemoteSource(
    { kind: 'url', url: 'https://x/y.git', sha: 'deadbeef' },
    { finalDir: '/f', tmpDir: '/t', runGit: r.run, move: async () => {}, remove: async () => {}, hoist: async () => { hoisted += 1; } },
  );
  assert.equal(hoisted, 0);
});

test('fetchRemoteSource rejects when HEAD does not match the declared sha', async () => {
  // The guarantee Codex lacks: a marketplace cannot advertise sha X and serve Y.
  const { run } = fakeRunner('aaaa1111');
  const removed = [];
  await assert.rejects(
    fetchRemoteSource(
      { kind: 'url', url: 'https://x/y.git', sha: 'bbbb2222' },
      { finalDir: '/f', tmpDir: '/t', runGit: run, move: async () => { throw new Error('must not move'); }, remove: async (p) => removed.push(p) },
    ),
    /sha/i,
  );
  assert.ok(removed.includes('/t'), 'staging cleaned up on sha mismatch');
});

test('fetchRemoteSource cleans up staging when a git step fails', async () => {
  const { run } = fakeRunner('cccc3333', { failOn: 'checkout' });
  const removed = [];
  await assert.rejects(
    fetchRemoteSource(
      { kind: 'url', url: 'https://x/y.git', sha: 'cccc3333' },
      { finalDir: '/f', tmpDir: '/t', runGit: run, move: async () => {}, remove: async (p) => removed.push(p) },
    ),
    PluginGitError,
  );
  assert.ok(removed.includes('/t'), 'staging cleaned up on failure');
});

test('fetchRemoteSource rejects an unsafe url before spawning anything', async () => {
  let spawned = false;
  await assert.rejects(
    fetchRemoteSource(
      { kind: 'url', url: 'file:///etc/passwd', sha: 'x' },
      { finalDir: '/f', tmpDir: '/t', runGit: async () => { spawned = true; return ''; }, move: async () => {}, remove: async () => {} },
    ),
    /https/i,
  );
  assert.equal(spawned, false, 'no git ran for an unsafe url');
});

test('fetchRemoteSource requires a sha (no unpinned installs)', async () => {
  const { run } = fakeRunner('x');
  await assert.rejects(
    fetchRemoteSource(
      { kind: 'url', url: 'https://x/y.git' },
      { finalDir: '/f', tmpDir: '/t', runGit: run, move: async () => {}, remove: async () => {} },
    ),
    /sha/i,
  );
});

// ── dispatch (IPC surface) ───────────────────────────────────────────────────
const os = require('node:os');
const path = require('node:path');
const fsSync = require('node:fs');
const { pluginGitDispatch, PLUGIN_GIT_MISS } = require('./pluginGitHost.cjs');

test('pluginGitDispatch misses on non-plugin-git commands', () => {
  assert.equal(pluginGitDispatch('plugin:fs|exists', { args: {} }), PLUGIN_GIT_MISS);
  assert.equal(pluginGitDispatch('some_other_cmd', { args: {} }), PLUGIN_GIT_MISS);
});

test('plugin_git_fetch validates its input shape before any work', async () => {
  await assert.rejects(
    pluginGitDispatch('plugin_git_fetch', { args: { source: { kind: 'url', url: 'https://x/y.git', sha: 'a' } } }),
    /destDir/i,
  );
  await assert.rejects(
    pluginGitDispatch('plugin_git_fetch', {
      args: { source: { kind: 'url', url: 'file:///x', sha: 'a' }, destDir: '/tmp/x' },
    }),
    /https/i,
  );
});

test('plugin_git_fetch rejects a destDir outside the plugin-packages root', async () => {
  // The renderer names the destination; a compromised renderer must not be
  // able to point the fetch at ~/Library/LaunchAgents.
  await assert.rejects(
    pluginGitDispatch('plugin_git_fetch', {
      args: {
        source: { kind: 'url', url: 'https://x/y.git', sha: 'abc' },
        destDir: path.join(os.homedir(), 'Library', 'LaunchAgents'),
      },
    }),
    /plugin-packages/i,
  );
});

test('plugin_git_fetch clones, asserts sha, and lands the package atomically', async (t) => {
  // Real end-to-end against a local git repo — git is available on this
  // machine (used by this very checkout), no network involved.
  const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-git-e2e-'));
  t.after(() => fsSync.rmSync(scratch, { recursive: true, force: true }));

  const srcRepo = path.join(scratch, 'src-repo');
  fsSync.mkdirSync(path.join(srcRepo, '.abu-plugin'), { recursive: true });
  fsSync.writeFileSync(path.join(srcRepo, '.abu-plugin', 'plugin.json'), '{"name":"remote-demo"}');
  const { execFileSync } = require('node:child_process');
  const g = (...args) => execFileSync('git', ['-C', srcRepo, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', srcRepo], { stdio: 'pipe' });
  g('config', 'user.email', 'e2e@abu.test');
  g('config', 'user.name', 'abu-e2e');
  g('add', '.');
  g('commit', '-q', '-m', 'seed');
  const sha = execFileSync('git', ['-C', srcRepo, 'rev-parse', 'HEAD']).toString().trim();

  // file:// is rejected by the https guard, so exercise the orchestration via
  // a destDir override scoped to the scratch root (test hook).
  const destDir = path.join(scratch, 'plugin-packages', 'mkt', 'remote-demo', '1.0.0');
  const result = await pluginGitDispatch('plugin_git_fetch', {
    args: {
      source: { kind: 'url', url: 'https://ignored.example/repo.git', sha },
      destDir,
    },
    __testOverrides: { cloneUrl: srcRepo },
  }, { packagesRoot: path.join(scratch, 'plugin-packages') });

  assert.equal(result.sha, sha);
  assert.ok(
    fsSync.existsSync(path.join(destDir, '.abu-plugin', 'plugin.json')),
    'manifest landed in the final dir',
  );
});

test('plugin_git_fetch (git-subdir) hoists the subdir to the package root', async (t) => {
  // The renderer installer reads the manifest at `<destDir>/.abu-plugin/plugin.json`
  // (package ROOT), and the archive fallback already lands it there. The git
  // path must match: after sparse-checkout, `<path>/*` is hoisted to the root.
  const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-git-e2e-subdir-'));
  t.after(() => fsSync.rmSync(scratch, { recursive: true, force: true }));

  const srcRepo = path.join(scratch, 'src-repo');
  fsSync.mkdirSync(path.join(srcRepo, 'pkgs', 'p', '.abu-plugin'), { recursive: true });
  fsSync.writeFileSync(path.join(srcRepo, 'pkgs', 'p', '.abu-plugin', 'plugin.json'), '{"name":"subdir-demo"}');
  fsSync.writeFileSync(path.join(srcRepo, 'pkgs', 'p', 'README.md'), 'subdir plugin');
  fsSync.mkdirSync(path.join(srcRepo, 'pkgs', 'other'), { recursive: true });
  fsSync.writeFileSync(path.join(srcRepo, 'pkgs', 'other', 'noise.txt'), 'not ours');
  fsSync.writeFileSync(path.join(srcRepo, 'top.txt'), 'repo root noise');
  const { execFileSync } = require('node:child_process');
  const g = (...args) => execFileSync('git', ['-C', srcRepo, ...args], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', srcRepo], { stdio: 'pipe' });
  g('config', 'user.email', 'e2e@abu.test');
  g('config', 'user.name', 'abu-e2e');
  g('add', '.');
  g('commit', '-q', '-m', 'seed');
  const sha = execFileSync('git', ['-C', srcRepo, 'rev-parse', 'HEAD']).toString().trim();

  const destDir = path.join(scratch, 'plugin-packages', 'mkt', 'subdir-demo', '1.0.0');
  const result = await pluginGitDispatch('plugin_git_fetch', {
    args: {
      source: { kind: 'git-subdir', url: 'https://ignored.example/mono.git', path: 'pkgs/p', sha },
      destDir,
    },
    __testOverrides: { cloneUrl: srcRepo, packagesRoot: path.join(scratch, 'plugin-packages') },
  });

  assert.equal(result.sha, sha);
  assert.equal(result.via, 'git');
  assert.ok(
    fsSync.existsSync(path.join(destDir, '.abu-plugin', 'plugin.json')),
    'manifest landed at the package root, not under pkgs/p/',
  );
  assert.ok(fsSync.existsSync(path.join(destDir, 'README.md')), 'sibling subdir file hoisted too');
  assert.ok(!fsSync.existsSync(path.join(destDir, 'pkgs')), 'no leftover pkgs/ wrapper dir');
  assert.ok(!fsSync.existsSync(path.join(destDir, 'top.txt')), 'repo-root files outside the subdir are not shipped');
  assert.ok(!fsSync.existsSync(path.join(destDir, '.git')), '.git is stripped');
});

test('plugin_git_fetch refuses when the repo HEAD is not the declared sha', async (t) => {
  const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-git-e2e2-'));
  t.after(() => fsSync.rmSync(scratch, { recursive: true, force: true }));

  const srcRepo = path.join(scratch, 'src-repo');
  fsSync.mkdirSync(srcRepo, { recursive: true });
  const { execFileSync } = require('node:child_process');
  execFileSync('git', ['init', '-q', srcRepo], { stdio: 'pipe' });
  const g = (...args) => execFileSync('git', ['-C', srcRepo, ...args], { stdio: 'pipe' });
  g('config', 'user.email', 'e2e@abu.test');
  g('config', 'user.name', 'abu-e2e');
  fsSync.writeFileSync(path.join(srcRepo, 'f.txt'), 'x');
  g('add', '.');
  g('commit', '-q', '-m', 'seed');

  const destDir = path.join(scratch, 'plugin-packages', 'mkt', 'p', '1.0.0');
  await assert.rejects(
    pluginGitDispatch('plugin_git_fetch', {
      args: {
        source: { kind: 'url', url: 'https://ignored.example/r.git', sha: '0000000000000000000000000000000000000000' },
        destDir,
      },
      __testOverrides: { cloneUrl: srcRepo, packagesRoot: path.join(scratch, 'plugin-packages') },
    }),
    /checkout|sha|git exited/i,
  );
  assert.ok(!fsSync.existsSync(destDir), 'nothing landed in the final dir');
});

// ── Windows containment (de-escalates the fsHost allow-all finding) ──────────
// fsHost.cjs returns allow-all on win32, so plugin containment on Windows must
// come from these platform-independent JS guards, not from fsHost scope. These
// pin that guarantee.
test('destDir guard rejects a parent-traversal regardless of separator', async () => {
  const root = path.join(os.homedir(), '.abu', 'plugin-packages');
  // The dispatch resolves via path.resolve + path.sep, so a `..` escaping the
  // root is rejected on every platform (dispatch is async → assert.rejects).
  await assert.rejects(
    pluginGitDispatch('plugin_git_fetch', {
      args: { source: { kind: 'url', url: 'https://x/y.git', sha: 'a' }, destDir: path.join(root, '..', '..', 'evil') },
    }),
    /plugin-packages/i,
  );
});

test('destDir guard accepts a normal nested package dir', async () => {
  // A well-formed destination under the root passes the guard (it fails later
  // for other reasons in this unit, but NOT on containment).
  const root = path.join(os.homedir(), '.abu', 'plugin-packages');
  const dest = path.join(root, 'mkt', 'plugin', '1.0.0');
  await assert.rejects(
    pluginGitDispatch('plugin_git_fetch', {
      args: { source: { kind: 'url', url: 'https://x/y.git', sha: 'a' }, destDir: dest },
    }),
    // Rejected on the (real) clone, not on containment — proving the path was accepted.
    (err) => !/plugin-packages/i.test(String(err)),
  );
});

// ── Security review batch-2 fixes ────────────────────────────────────────────
const { assertSafeSha } = require('./pluginGitHost.cjs');

test('cleanGitEnv strips the GIT_CONFIG_COUNT/KEY_n/VALUE_n injection family', () => {
  const env = cleanGitEnv({
    PATH: '/usr/bin',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: 'sh -c evil',
    GIT_CONFIG_KEY_7: 'core.hooksPath',
    GIT_CONFIG_VALUE_7: '/evil',
  });
  // COUNT gates the whole mechanism; the numbered pairs are stripped for
  // defense in depth so no residue can inject config.
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(env.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(env.GIT_CONFIG_KEY_7, undefined);
  assert.equal(env.GIT_CONFIG_VALUE_7, undefined);
  assert.equal(env.PATH, '/usr/bin'); // ordinary env survives
});

test('assertSafeSha accepts a real sha and rejects anything option-shaped', () => {
  assert.doesNotThrow(() => assertSafeSha('abc123'));
  assert.doesNotThrow(() => assertSafeSha('a'.repeat(40)));
  for (const bad of ['--upload-pack=x', '-flag', 'abc; rm -rf', 'abc def', '../x', 'ABCXYZ', '', 'g'.repeat(41)]) {
    assert.throws(() => assertSafeSha(bad), PluginGitError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('fetchRemoteSource rejects an option-shaped sha before running git', async () => {
  let ran = false;
  await assert.rejects(
    fetchRemoteSource(
      { kind: 'url', url: 'https://x/y.git', sha: '--upload-pack=touch /tmp/x' },
      { finalDir: '/f', tmpDir: '/t', runGit: async () => { ran = true; return ''; }, move: async () => {}, remove: async () => {} },
    ),
    PluginGitError,
  );
  assert.equal(ran, false, 'no git ran for an unsafe sha');
});

// ── GitHub archive fallback (P1-4) ───────────────────────────────────────────
// When git is missing or the clone fails, a `https://github.com/<owner>/<repo>`
// source falls back to the codeload zip for the pinned sha. The archive's single
// root folder must be `<repo>-<sha>` — the only integrity assertion available
// without git (Codex's guarantee level; weaker than rev-parse).
test('falls back to a GitHub codeload archive when git is missing', async () => {
  const fflate = require('fflate');
  const sha = 'a'.repeat(40);
  const zip = Buffer.from(fflate.zipSync({
    [`repo-${sha}/.abu-plugin/plugin.json`]: fflate.strToU8(JSON.stringify({ name: 'p', version: '1.0.0' })),
    [`repo-${sha}/skills/s/SKILL.md`]: fflate.strToU8('---\nname: s\n---\n'),
  }));
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  const finalDir = path.join(tmp, 'final');
  const calls = [];
  const result = await fetchRemoteSource(
    { kind: 'url', url: 'https://github.com/o/repo', sha },
    {
      finalDir, tmpDir: path.join(tmp, 'clone'),
      runGit: async () => { throw new PluginGitError('spawn git ENOENT', 'git_missing'); },
      move: async (from, to) => { fsSync.mkdirSync(path.dirname(to), { recursive: true }); fsSync.renameSync(from, to); },
      remove: async (p) => fsSync.rmSync(p, { recursive: true, force: true }),
      downloadArchive: async (url) => { calls.push(url); return zip; },
    },
  );
  assert.equal(calls[0], `https://codeload.github.com/o/repo/zip/${sha}`);
  assert.equal(result, finalDir);
  assert.ok(fsSync.existsSync(path.join(finalDir, '.abu-plugin', 'plugin.json')));
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

test('archive fallback refuses a zip whose root folder is not <repo>-<sha>', async () => {
  const fflate = require('fflate');
  const sha = 'b'.repeat(40);
  const zip = Buffer.from(fflate.zipSync({ 'repo-deadbeef/.abu-plugin/plugin.json': fflate.strToU8('{}') }));
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  await assert.rejects(
    fetchRemoteSource({ kind: 'url', url: 'https://github.com/o/repo', sha }, {
      finalDir: path.join(tmp, 'final'), tmpDir: path.join(tmp, 'clone'),
      runGit: async () => { throw new PluginGitError('x', 'clone_failed'); },
      move: async () => {}, remove: async () => {},
      downloadArchive: async () => zip,
    }),
    (e) => e.code === 'sha_mismatch',
  );
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

// Fallback eligibility is deliberately narrow: only the two codes that mean
// "git could not run/transport", and only github.com repo urls.
test('archive fallback is NOT taken for a non-GitHub url', async () => {
  let downloaded = false;
  await assert.rejects(
    fetchRemoteSource({ kind: 'url', url: 'https://gitlab.com/o/repo', sha: 'c'.repeat(40) }, {
      finalDir: '/f', tmpDir: '/t',
      runGit: async () => { throw new PluginGitError('spawn git ENOENT', 'git_missing'); },
      move: async () => {}, remove: async () => {},
      downloadArchive: async () => { downloaded = true; return Buffer.alloc(0); },
    }),
    (e) => e.code === 'git_missing',
  );
  assert.equal(downloaded, false, 'no archive download for a non-GitHub source');
});

test('archive fallback is NOT taken for a sha mismatch or a checkout failure', async () => {
  let downloaded = false;
  const dl = async () => { downloaded = true; return Buffer.alloc(0); };
  const { run } = fakeRunner('aaaa1111');
  await assert.rejects(
    fetchRemoteSource({ kind: 'url', url: 'https://github.com/o/repo', sha: 'bbbb2222' }, {
      finalDir: '/f', tmpDir: '/t', runGit: run, move: async () => {}, remove: async () => {}, downloadArchive: dl,
    }),
    (e) => e.code === 'sha_mismatch',
  );
  await assert.rejects(
    fetchRemoteSource({ kind: 'url', url: 'https://github.com/o/repo', sha: 'bbbb2222' }, {
      finalDir: '/f', tmpDir: '/t',
      runGit: async (args) => { if (args.includes('checkout')) throw new PluginGitError('git exited 128', 'git_exit'); return ''; },
      move: async () => {}, remove: async () => {}, downloadArchive: dl,
    }),
    (e) => e.code === 'git_exit',
  );
  assert.equal(downloaded, false, 'sha/checkout problems never reach the archive path');
});

test('archive fallback (git-subdir) extracts only the declared subdir and reports the fallback', async () => {
  const fflate = require('fflate');
  const sha = 'd'.repeat(40);
  const zip = Buffer.from(fflate.zipSync({
    [`repo-${sha}/pkgs/p/.abu-plugin/plugin.json`]: fflate.strToU8('{}'),
    [`repo-${sha}/other/README.md`]: fflate.strToU8('x'),
  }));
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  const finalDir = path.join(tmp, 'final');
  const fallbacks = [];
  await fetchRemoteSource({ kind: 'git-subdir', url: 'https://github.com/o/repo.git', path: 'pkgs/p', sha }, {
    finalDir, tmpDir: path.join(tmp, 'clone'),
    runGit: async () => { throw new PluginGitError('x', 'clone_failed'); },
    move: async (from, to) => fsSync.renameSync(from, to),
    remove: async (p) => fsSync.rmSync(p, { recursive: true, force: true }),
    downloadArchive: async () => zip,
    onArchiveFallback: (e) => fallbacks.push(e.code),
  });
  assert.ok(fsSync.existsSync(path.join(finalDir, '.abu-plugin', 'plugin.json')), 'subdir content landed at the root');
  assert.ok(!fsSync.existsSync(path.join(finalDir, 'other')), 'content outside the subdir is not extracted');
  assert.deepEqual(fallbacks, ['clone_failed']);
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

const { extractArchive, githubArchiveUrl, isAllowedArchiveUrl } = require('./pluginGitHost.cjs');

const { hoistSubdir } = require('./pluginGitHost.cjs');

test('hoistSubdir refuses a missing subdir and a symlinked subdir', (t) => {
  const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-hoist-'));
  t.after(() => fsSync.rmSync(scratch, { recursive: true, force: true }));
  assert.throws(() => hoistSubdir(scratch, 'pkgs/nope'), { code: 'subdir_missing' });
  // A symlinked subdir could point outside the staging tree — never follow it.
  fsSync.mkdirSync(path.join(scratch, 'pkgs'), { recursive: true });
  const outside = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-hoist-outside-'));
  t.after(() => fsSync.rmSync(outside, { recursive: true, force: true }));
  fsSync.symlinkSync(outside, path.join(scratch, 'pkgs', 'link'));
  assert.throws(() => hoistSubdir(scratch, 'pkgs/link'), { code: 'subdir_missing' });
  assert.throws(() => hoistSubdir(scratch, '../escape'), { code: 'bad_args' });
});

test('extractArchive rejects entries that could escape the staging dir', () => {
  const fflate = require('fflate');
  const sha = 'e'.repeat(40);
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  for (const bad of [`repo-${sha}/../evil.txt`, `repo-${sha}/a/../../evil.txt`, `repo-${sha}/..\\evil.txt`, `repo-${sha}//abs.txt`]) {
    const zip = Buffer.from(fflate.zipSync({ [bad]: fflate.strToU8('x'), [`repo-${sha}/ok.txt`]: fflate.strToU8('y') }));
    assert.throws(
      () => extractArchive(zip, { kind: 'url', sha }, path.join(tmp, 'stage'), 'repo'),
      (e) => e.code === 'bad_args',
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  assert.ok(!fsSync.existsSync(path.join(tmp, 'evil.txt')), 'nothing escaped');
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

test('extractArchive caps the unpacked size independently of the download size', () => {
  const fflate = require('fflate');
  const sha = 'f'.repeat(40);
  // 1 MiB of zeros compresses to ~1 KiB: a small download that unpacks large.
  const zip = Buffer.from(fflate.zipSync({ [`repo-${sha}/zeros.bin`]: new Uint8Array(1024 * 1024) }));
  assert.ok(zip.length < 16 * 1024, 'fixture must be a small download');
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  assert.throws(
    () => extractArchive(zip, { kind: 'url', sha }, path.join(tmp, 'stage'), 'repo', { maxUnpackedBytes: 512 * 1024 }),
    (e) => e.code === 'archive_failed',
  );
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

test('extractArchive (git-subdir) fails when the subdir has no files', () => {
  const fflate = require('fflate');
  const sha = '1'.repeat(40);
  const zip = Buffer.from(fflate.zipSync({ [`repo-${sha}/README.md`]: fflate.strToU8('x') }));
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  assert.throws(
    () => extractArchive(zip, { kind: 'git-subdir', path: 'pkgs/missing', sha }, path.join(tmp, 'stage'), 'repo'),
    (e) => e.code === 'archive_failed' && /pkgs\/missing/.test(e.message),
  );
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

test('githubArchiveUrl only maps github.com repo urls', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(githubArchiveUrl('https://github.com/o/repo', sha), { url: `https://codeload.github.com/o/repo/zip/${sha}`, repo: 'repo' });
  assert.deepEqual(githubArchiveUrl('https://github.com/o/repo.git', sha), { url: `https://codeload.github.com/o/repo/zip/${sha}`, repo: 'repo' });
  assert.deepEqual(githubArchiveUrl('https://github.com/o/repo/', sha), { url: `https://codeload.github.com/o/repo/zip/${sha}`, repo: 'repo' });
  for (const url of ['https://gitlab.com/o/repo', 'https://github.com/o', 'https://github.com/o/repo/tree/main', 'https://www.github.com/o/repo', 'https://github.com.evil.com/o/repo']) {
    assert.equal(githubArchiveUrl(url, sha), null, `should not map ${url}`);
  }
});

test('archive redirects are confined to https on GitHub hosts', () => {
  assert.ok(isAllowedArchiveUrl('https://codeload.github.com/o/r/zip/abc'));
  assert.ok(isAllowedArchiveUrl('https://objects.githubusercontent.com/x'));
  assert.ok(isAllowedArchiveUrl('https://github.com/o/r'));
  for (const url of ['http://codeload.github.com/o/r/zip/abc', 'https://evil.com/x', 'https://codeload.github.com.evil.com/x', 'file:///etc/passwd', 'not a url']) {
    assert.equal(isAllowedArchiveUrl(url), false, `should refuse ${url}`);
  }
});

test('runGit maps ENOENT → git_missing and a failed clone → clone_failed, nothing else', async () => {
  const { runGit } = require('./pluginGitHost.cjs');
  const { EventEmitter } = require('node:events');
  const fakeSpawn = ({ error, exitCode }) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (error) child.emit('error', error);
      else { child.stderr.emit('data', 'boom'); child.emit('close', exitCode); }
    });
    return child;
  };
  const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  await assert.rejects(runGit(['clone', 'x', 'y'], { spawnImpl: fakeSpawn({ error: enoent }) }), (e) => e.code === 'git_missing');
  const eacces = Object.assign(new Error('spawn git EACCES'), { code: 'EACCES' });
  await assert.rejects(runGit(['clone', 'x', 'y'], { spawnImpl: fakeSpawn({ error: eacces }) }), (e) => e.code === 'spawn_failed');
  await assert.rejects(
    runGit(['clone', 'x', 'y'], { spawnImpl: fakeSpawn({ exitCode: 128 }) }),
    (e) => e.code === 'clone_failed' && /git exited 128: boom/.test(e.message),
  );
  await assert.rejects(
    runGit(['-C', 'y', 'checkout', '--detach', 'abc'], { spawnImpl: fakeSpawn({ exitCode: 1 }) }),
    (e) => e.code === 'git_exit' && /git exited 1: boom/.test(e.message),
  );
});

// ── Review fix round 1 ───────────────────────────────────────────────────────
test('archive fallback requires a full 40-hex sha; a short sha propagates the git error', async () => {
  let downloaded = false;
  await assert.rejects(
    fetchRemoteSource({ kind: 'url', url: 'https://github.com/o/repo', sha: 'abc1234' }, {
      finalDir: '/f', tmpDir: '/t',
      runGit: async () => { throw new PluginGitError('spawn git ENOENT', 'git_missing'); },
      move: async () => {}, remove: async () => {},
      downloadArchive: async () => { downloaded = true; return Buffer.alloc(0); },
    }),
    (e) => e.code === 'git_missing',
  );
  assert.equal(downloaded, false, 'an abbreviated sha must not be rescued by the archive path');
});

test('archive fallback failure reports BOTH the archive and the git diagnostic', async () => {
  const sha = 'e'.repeat(40);
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  await assert.rejects(
    fetchRemoteSource({ kind: 'url', url: 'https://github.com/o/repo', sha }, {
      finalDir: path.join(tmp, 'final'), tmpDir: path.join(tmp, 'clone'),
      runGit: async () => { throw new PluginGitError('spawn git ENOENT', 'git_missing'); },
      move: async () => {}, remove: async (p) => fsSync.rmSync(p, { recursive: true, force: true }),
      downloadArchive: async () => { throw new PluginGitError('archive download timed out', 'archive_failed'); },
    }),
    (e) =>
      e.code === 'archive_failed'
      && e.message === 'archive download timed out; git: spawn git ENOENT'
      && e.cause instanceof PluginGitError && e.cause.code === 'git_missing',
  );
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

/** A scripted `https.get` stand-in: `script(url, n)` → { statusCode, headers, body }. */
function scriptedGet(script) {
  const { EventEmitter } = require('node:events');
  const calls = [];
  const get = (url, _opts, cb) => {
    calls.push(url);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    const r = script(url, calls.length);
    const res = new EventEmitter();
    res.statusCode = r.statusCode;
    res.headers = r.headers || {};
    res.resume = () => {};
    setImmediate(() => {
      cb(res);
      if (r.body !== undefined) res.emit('data', Buffer.from(r.body));
      res.emit('end');
    });
    return req;
  };
  return { get, calls };
}

const { downloadArchiveHttps } = require('./pluginGitHost.cjs');
const START = `https://codeload.github.com/o/r/zip/${'a'.repeat(40)}`;

test('downloadArchiveHttps resolves a relative redirect against the current url', async () => {
  const { get, calls } = scriptedGet((url, n) =>
    n === 1 ? { statusCode: 302, headers: { location: '/o/r/legacy.zip/abc' } } : { statusCode: 200, body: 'ZIP' });
  const bytes = await downloadArchiveHttps(START, { getImpl: get });
  assert.equal(bytes.toString(), 'ZIP');
  assert.deepEqual(calls, [START, 'https://codeload.github.com/o/r/legacy.zip/abc']);
});

test('downloadArchiveHttps refuses a redirect to http://', async () => {
  const { get, calls } = scriptedGet(() => ({ statusCode: 302, headers: { location: 'http://codeload.github.com/o/r/zip/x' } }));
  await assert.rejects(downloadArchiveHttps(START, { getImpl: get }), (e) => e.code === 'archive_failed' && /not allowed/.test(e.message));
  assert.equal(calls.length, 1, 'the http:// target was never requested');
});

test('downloadArchiveHttps refuses a redirect to a non-allowlisted host', async () => {
  const { get, calls } = scriptedGet(() => ({ statusCode: 302, headers: { location: 'https://evil.example/o/r.zip' } }));
  await assert.rejects(downloadArchiveHttps(START, { getImpl: get }), (e) => e.code === 'archive_failed' && /not allowed/.test(e.message));
  assert.equal(calls.length, 1, 'the off-host target was never requested');
});

test('downloadArchiveHttps stops after 3 redirects', async () => {
  const { get, calls } = scriptedGet((url, n) => ({ statusCode: 302, headers: { location: `https://github.com/o/r/hop${n}` } }));
  await assert.rejects(downloadArchiveHttps(START, { getImpl: get }), (e) => e.code === 'archive_failed' && /redirect limit/.test(e.message));
  assert.equal(calls.length, 4, 'start + 3 redirects, then the 4th 3xx is refused');
});

test('downloadArchiveHttps fails on an invalid Location header', async () => {
  const { get, calls } = scriptedGet(() => ({ statusCode: 302, headers: { location: 'https://[not-a-host' } }));
  await assert.rejects(downloadArchiveHttps(START, { getImpl: get }), (e) => e.code === 'archive_failed' && /not a valid url/.test(e.message));
  assert.equal(calls.length, 1);
});

test('extractArchive rejects NUL and ":" in entry names and reports corrupt zips as archive_failed', () => {
  const fflate = require('fflate');
  const sha = '2'.repeat(40);
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  for (const bad of [`repo-${sha}/a\0b.txt`, `repo-${sha}/c:d.txt`, `repo-${sha}/dir/C:/x.txt`]) {
    const zip = Buffer.from(fflate.zipSync({ [bad]: fflate.strToU8('x') }));
    assert.throws(
      () => extractArchive(zip, { kind: 'url', sha }, path.join(tmp, 'stage'), 'repo'),
      (e) => e.code === 'bad_args',
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(
    () => extractArchive(Buffer.from('definitely not a zip file'), { kind: 'url', sha }, path.join(tmp, 'stage'), 'repo'),
    (e) => e.code === 'archive_failed' && /could not be unpacked/.test(e.message),
  );
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

test('extractArchive validates every entry before writing any (no partial staging on a bad entry)', () => {
  const fflate = require('fflate');
  const sha = '3'.repeat(40);
  // Good entry FIRST, bad entry after: a single-pass writer would have written ok.txt.
  const zip = Buffer.from(fflate.zipSync({
    [`repo-${sha}/ok.txt`]: fflate.strToU8('y'),
    [`repo-${sha}/sub/also-ok.txt`]: fflate.strToU8('z'),
    [`repo-${sha}/../evil.txt`]: fflate.strToU8('x'),
  }));
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-arch-'));
  const stage = path.join(tmp, 'stage');
  assert.throws(() => extractArchive(zip, { kind: 'url', sha }, stage, 'repo'), (e) => e.code === 'bad_args');
  assert.ok(!fsSync.existsSync(path.join(stage, 'ok.txt')), 'nothing written before validation finished');
  assert.ok(!fsSync.existsSync(stage), 'staging dir was never created');
  fsSync.rmSync(tmp, { recursive: true, force: true });
});

// ── Review fix round 2 ───────────────────────────────────────────────────────
const { assertSafeSubdirPath } = require('./pluginGitHost.cjs');
const BAD_SUBDIR_PATHS = ['../escape', 'pkgs/../..', '/abs/pkgs', '--help', '.git/hooks', 'a\nb', 'a\0b', 'c:d', 'a\\b', 'pkgs//p', './p', ''];
// Task 9 round-2 lows: `.git` anywhere (any case) and pattern characters.
const BAD_SUBDIR_PATHS_R2 = ['.GIT/hooks', 'pkgs/.git', 'pkgs/.Git/x', 'pkgs/*', 'pkgs/?', 'pkgs/[a]', '!pkgs', '#x', 'pkgs#1'];

test('assertSafeSubdirPath accepts plain relative paths and refuses everything else', () => {
  assert.equal(assertSafeSubdirPath('pkgs/p'), 'pkgs/p');
  assert.equal(assertSafeSubdirPath('a/b-c/d.e'), 'a/b-c/d.e');
  for (const bad of [...BAD_SUBDIR_PATHS, ...BAD_SUBDIR_PATHS_R2]) {
    assert.throws(() => assertSafeSubdirPath(bad), { code: 'bad_args' }, `should reject ${JSON.stringify(bad)}`);
  }
  // `.git`-like names that are NOT the object store stay allowed.
  assert.equal(assertSafeSubdirPath('pkgs/.github/x'), 'pkgs/.github/x');
  assert.equal(assertSafeSubdirPath('git/hooks'), 'git/hooks');
});

test('fetchRemoteSource (git-subdir) refuses an unsafe path with ZERO git calls', async () => {
  for (const bad of ['../escape', 'pkgs/../..', '/abs/pkgs', '--help', '.git/hooks', 'a\nb', ...BAD_SUBDIR_PATHS_R2]) {
    const r = fakeRunner('deadbeef');
    let hoisted = 0;
    await assert.rejects(
      fetchRemoteSource(
        { kind: 'git-subdir', url: 'https://x/y.git', path: bad, sha: 'deadbeef' },
        { finalDir: '/f', tmpDir: '/t', runGit: r.run, move: async () => {}, remove: async () => {}, hoist: async () => { hoisted += 1; } },
      ),
      (e) => e.code === 'bad_args',
      `should reject ${JSON.stringify(bad)}`,
    );
    assert.equal(r.calls.length, 0, `no git call for ${JSON.stringify(bad)}`);
    assert.equal(hoisted, 0);
  }
});

test('plugin_git_fetch refuses an unsafe git-subdir path before any git or staging work', async (t) => {
  const scratch = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-git-badpath-'));
  t.after(() => fsSync.rmSync(scratch, { recursive: true, force: true }));
  const destDir = path.join(scratch, 'plugin-packages', 'mkt', 'x', '1.0.0');
  for (const bad of ['../escape', '--help', '.git/hooks']) {
    await assert.rejects(
      pluginGitDispatch('plugin_git_fetch', {
        args: { source: { kind: 'git-subdir', url: 'https://ignored.example/mono.git', path: bad, sha: 'a'.repeat(40) }, destDir },
        // A clone target that does not exist: had git run, the code would be clone_failed, not bad_args.
        __testOverrides: { cloneUrl: path.join(scratch, 'no-such-repo'), packagesRoot: path.join(scratch, 'plugin-packages') },
      }),
      (e) => e.code === 'bad_args',
      `should reject ${JSON.stringify(bad)}`,
    );
  }
  assert.ok(!fsSync.existsSync(destDir));
});

test('hoistSubdir refuses a subdir that physically escapes the checkout via an intermediate symlink', (t) => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-hoist-root-'));
  const outside = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-hoist-outside-'));
  t.after(() => fsSync.rmSync(root, { recursive: true, force: true }));
  t.after(() => fsSync.rmSync(outside, { recursive: true, force: true }));
  fsSync.mkdirSync(path.join(outside, 'p'));
  fsSync.writeFileSync(path.join(outside, 'p', 'keep.txt'), 'untouched');
  fsSync.symlinkSync(outside, path.join(root, 'pkgs'));
  // Lexically `root/pkgs/p` is inside root and its final component is a real directory.
  assert.throws(() => hoistSubdir(root, 'pkgs/p'), (e) => e.code === 'bad_args' && /escapes the checkout/.test(e.message));
  assert.ok(fsSync.existsSync(path.join(outside, 'p', 'keep.txt')), 'outside dir still exists untouched');
  assert.equal(fsSync.readdirSync(outside).join(','), 'p');
  assert.ok(fsSync.lstatSync(path.join(root, 'pkgs')).isSymbolicLink(), 'the symlink itself was not moved');
});

test('hoistSubdir replaces a dangling symlink at the destination and reports fs failures as git_exit', (t) => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'abu-hoist-dangling-'));
  t.after(() => fsSync.rmSync(root, { recursive: true, force: true }));
  fsSync.mkdirSync(path.join(root, 'pkgs', 'p', 'sub'), { recursive: true });
  fsSync.writeFileSync(path.join(root, 'pkgs', 'p', 'x.txt'), 'x');
  fsSync.writeFileSync(path.join(root, 'pkgs', 'p', 'sub', 'y.txt'), 'y');
  fsSync.symlinkSync(path.join(root, 'gone-file'), path.join(root, 'x.txt'));
  fsSync.symlinkSync(path.join(root, 'gone-dir'), path.join(root, 'sub'));
  hoistSubdir(root, 'pkgs/p');
  assert.ok(fsSync.lstatSync(path.join(root, 'x.txt')).isFile(), 'dangling link replaced by the real file');
  assert.ok(fsSync.lstatSync(path.join(root, 'sub')).isDirectory(), 'dangling link replaced by the real dir');
  assert.equal(fsSync.readFileSync(path.join(root, 'sub', 'y.txt'), 'utf8'), 'y');
  assert.ok(!fsSync.existsSync(path.join(root, 'pkgs')));
  assert.ok(!fsSync.readdirSync(root).some((n) => n.startsWith('.abu-hoist-')), 'aside dir cleaned up');
  // A live (non-dangling) entry at the destination is still a collision.
  fsSync.mkdirSync(path.join(root, 'pkgs2', 'q'), { recursive: true });
  fsSync.writeFileSync(path.join(root, 'pkgs2', 'q', 'x.txt'), 'dup');
  assert.throws(() => hoistSubdir(root, 'pkgs2/q'), { code: 'bad_args' });
});
