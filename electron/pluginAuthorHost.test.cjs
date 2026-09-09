'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createOperationSession } = require('./pluginOperationSession.cjs');
const { createPluginAuthorHost } = require('./pluginAuthorHost.cjs');
const { createPluginSnapshotHost } = require('./pluginSnapshotHost.cjs');

async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-author-'));
  const session = createOperationSession(home);
  let next = 1;
  const snapshots = createPluginSnapshotHost({ home, mutate: input => session.mutate(input), now: () => 1,
    randomId: () => (next++).toString(16).padStart(48, '0') });
  const options = { home, session, snapshots, now: () => '2026-09-09T00:00:00.000Z', randomId: () => (next++).toString(16).padStart(32, '0') };
  const host = createPluginAuthorHost(options);
  try { await run({ home, host, snapshots, options }); }
  finally { await session.close(); fs.rmSync(home, { recursive: true, force: true }); }
}
function packageAt(dir, name = 'hello') {
  fs.mkdirSync(path.join(dir, '.abu-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.abu-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: 'Example' }));
  fs.mkdirSync(path.join(dir, 'skills', 'hello'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Say hello\n---\nSay hello.');
}

test('author creation needs no market; record survives host recreation; preparation pins exact bytes', async () => fixture(async ({ host, snapshots, options }) => {
  const sender = {};
  const author = await host.dispatch(sender, 'create', {});
  assert.equal(author.name, null);
  assert.match(author.sourceDir, /Abu Plugins/);
  await host.dispatch(sender, 'bind', { id: author.id, conversationId: 'conversation-one' });
  packageAt(author.sourceDir);
  const prepared = await host.dispatch(sender, 'prepare', { conversationId: 'conversation-one' });
  assert.equal(prepared.author.name, 'hello');
  assert.equal(prepared.snapshot.authoringId, author.id);
  fs.writeFileSync(path.join(author.sourceDir, 'skills', 'hello', 'SKILL.md'), 'changed after confirmation');
  assert.match(await snapshots.read(sender, { token: prepared.snapshot.token, path: 'skills/hello/SKILL.md' }), /Say hello/);
  assert.equal((await host.dispatch(sender, 'list', {}))[0].name, null);
  await host.dispatch(sender, 'validated', { token: prepared.snapshot.token });
  const again = createPluginAuthorHost(options);
  assert.equal((await again.dispatch(sender, 'list', {}))[0].name, 'hello');
  const revised = await again.dispatch(sender, 'prepare', { id: author.id });
  assert.notEqual(revised.snapshot.checksum, prepared.snapshot.checksum);
  assert.equal(revised.snapshot.version, prepared.snapshot.version);
  assert.equal(fs.existsSync(path.join(options.home, '.abu', 'plugin-packages', 'installed.json')), false);
}));

test('unknown conversations, source overrides, renamed package and corrupt metadata fail closed', async () => fixture(async ({ home, host }) => {
  const sender = {};
  await assert.rejects(host.dispatch(sender, 'prepare', { conversationId: 'unknown' }), /no author record/);
  await assert.rejects(host.dispatch(sender, 'create', { sourceDir: '/tmp' }), /unsupported request/);
  const author = await host.dispatch(sender, 'create', {});
  packageAt(author.sourceDir);
  const prepared = await host.dispatch(sender, 'prepare', { id: author.id });
  await host.dispatch(sender, 'validated', { token: prepared.snapshot.token });
  packageAt(author.sourceDir, 'renamed');
  await assert.rejects(host.dispatch(sender, 'prepare', { id: author.id }), /name is bound/);
  const registry = path.join(home, '.abu', 'plugin-authors', 'authors.json');
  fs.writeFileSync(registry, 'broken');
  await assert.rejects(host.dispatch(sender, 'create', {}));
  assert.equal(fs.readFileSync(registry, 'utf8'), 'broken');
}));

test('author source symlink cannot become a package', async () => fixture(async ({ home, host }) => {
  const sender = {};
  const author = await host.dispatch(sender, 'create', {});
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside); packageAt(outside);
  fs.rmdirSync(author.sourceDir); fs.symlinkSync(outside, author.sourceDir, 'dir');
  await assert.rejects(host.dispatch(sender, 'prepare', { id: author.id }), /directory\/link/);
}));

test('conversation rebinding requires the expected previous identity', async () => fixture(async ({ host }) => {
  const author = await host.dispatch({}, 'create', {});
  await host.dispatch({}, 'bind', { id: author.id, conversationId: 'one' });
  await assert.rejects(host.dispatch({}, 'bind', { id: author.id, conversationId: 'two' }), /binding changed/);
  await host.dispatch({}, 'bind', { id: author.id, conversationId: 'two', expectedConversationId: 'one' });
  await assert.rejects(host.dispatch({}, 'bind', { id: author.id, conversationId: 'three', expectedConversationId: 'one' }), /binding changed/);
}));
