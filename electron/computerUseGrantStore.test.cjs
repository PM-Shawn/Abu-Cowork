'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createComputerUseGrantStore,
  grantIdentityKey,
} = require('./computerUseGrantStore.cjs');

const QQ = Object.freeze({
  app_name: 'QQ',
  bundle_id: 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
  process_id: 4242,
  title: 'Chat with someone private',
  signature_status: 'valid',
  signer_subject: 'Tencent Technology (Shenzhen) Company Limited',
});

function tempStorePath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-cu-grants-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'computer-use-grants.json');
}

test('always-allow survives a reload and binds to the signer, not the file name', (t) => {
  const filePath = tempStorePath(t);
  let now = 1_000;
  const first = createComputerUseGrantStore({ filePath, platform: 'win32', now: () => now });

  const granted = first.grant(QQ, { tier: 'approval-required' });
  assert.equal(granted.persisted, true);
  assert.equal(granted.key, grantIdentityKey(QQ));
  assert.equal(granted.displayName, 'QQ');
  const raw = fs.readFileSync(filePath, 'utf8');
  assert.equal(raw.includes('4242'), false, 'no process id on disk');
  assert.equal(raw.includes('Chat with someone'), false, 'no window title on disk');

  now = 2_000;
  const reloaded = createComputerUseGrantStore({ filePath, platform: 'win32', now: () => now });
  const remembered = reloaded.remembered(QQ);
  assert.equal(remembered?.tier, 'approval-required');
  assert.equal(remembered?.lastUsedAt, 2_000);

  // Same path, another signer: a replaced binary does not inherit the grant.
  assert.equal(reloaded.remembered({ ...QQ, signer_subject: 'Contoso Ltd' }), null);
  // Same path, signature gone: neither.
  assert.equal(reloaded.remembered({ ...QQ, signature_status: 'untrusted', signer_subject: undefined }), null);
  // Different path calling itself qq.exe: a different key altogether.
  assert.equal(reloaded.remembered({ ...QQ, bundle_id: 'C:\\Users\\me\\Desktop\\qq.exe' }), null);
});

test('unsigned apps are remembered by identity key only', () => {
  const store = createComputerUseGrantStore({ platform: 'win32', now: () => 5 });
  const tool = { app_name: 'Tool', bundle_id: 'D:\\tools\\tool.exe', signature_status: 'untrusted' };
  store.grant(tool, { tier: 'approval-required' });
  assert.equal(store.remembered(tool)?.displayName, 'Tool');
  assert.equal(store.remembered({ ...tool, signature_status: 'valid', signer_subject: 'Anyone' }), null);
});

test('denying an app removes its grant, and listings never expose the signer', () => {
  const store = createComputerUseGrantStore({ platform: 'win32', now: () => 7 });
  store.grant(QQ, { tier: 'approval-required' });
  assert.equal(store.isDenied(QQ), false);

  const [listed] = store.list().grants;
  assert.deepEqual(Object.keys(listed).sort(), ['displayName', 'grantedAt', 'key', 'lastUsedAt', 'source', 'tier']);

  assert.equal(store.setDenied({ key: listed.key, displayName: 'QQ' }, true), true);
  assert.equal(store.isDenied(QQ), true);
  assert.equal(store.remembered(QQ), null);
  assert.deepEqual(store.list().grants, []);
  assert.equal(store.list().denied[0]?.displayName, 'QQ');

  store.setDenied({ key: listed.key }, false);
  assert.equal(store.isDenied(QQ), false);
  assert.deepEqual(store.list().denied, []);

  // Granting again from the dialog clears a stale denial too.
  store.setDenied(QQ, true);
  store.grant(QQ, { tier: 'approval-required' });
  assert.equal(store.isDenied(QQ), false);
});

test('revoke forgets the app, and records from another platform are ignored', (t) => {
  const filePath = tempStorePath(t);
  const windows = createComputerUseGrantStore({ filePath, platform: 'win32', now: () => 9 });
  windows.grant(QQ, { tier: 'approval-required' });
  assert.equal(windows.revoke({ key: grantIdentityKey(QQ) }), true);
  assert.equal(windows.remembered(QQ), null);
  assert.equal(windows.revoke({ key: grantIdentityKey(QQ) }), false);

  windows.grant(QQ, { tier: 'approval-required' });
  const mac = createComputerUseGrantStore({ filePath, platform: 'darwin', now: () => 9 });
  assert.equal(mac.remembered(QQ), null);
  assert.deepEqual(mac.list(), { grants: [], denied: [] });
});

test('grant rejects hard-deny-shaped input and unknown tiers', () => {
  const store = createComputerUseGrantStore({ platform: 'darwin', now: () => 1 });
  assert.throws(() => store.grant({ app_name: 'x' }, { tier: 'ordinary' }), /identity is unavailable/);
  assert.throws(() => store.grant({ app_name: 'x', bundle_id: 'com.x' }, { tier: 'hard-deny' }), /tier is invalid/);
  assert.throws(() => store.grant({ app_name: 'x', bundle_id: 'com.x' }, { tier: 'communication' }), /tier is invalid/);
});

test('corrupt or unwritable storage fails open to "ask again", never to "allowed"', (t) => {
  const filePath = tempStorePath(t);
  fs.writeFileSync(filePath, '{not json');
  const errors = [];
  const store = createComputerUseGrantStore({
    filePath,
    platform: 'win32',
    now: () => 3,
    onError: (error) => errors.push(error),
  });
  assert.equal(store.remembered(QQ), null);
  assert.equal(errors.length, 1);

  const unwritable = createComputerUseGrantStore({
    filePath: '\0invalid',
    platform: 'win32',
    now: () => 3,
    onError: (error) => errors.push(error),
  });
  const granted = unwritable.grant(QQ, { tier: 'approval-required' });
  assert.equal(granted.persisted, false);
  // In-memory it still holds for this process, like the stop store.
  assert.equal(unwritable.remembered(QQ)?.key, grantIdentityKey(QQ));
  assert.equal(errors.length > 1, true);

  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    grants: [
      { key: 'com.valid', displayName: 'Valid', platform: 'win32', tier: 'ordinary', signatureStatus: null, signer: null, grantedAt: 1, lastUsedAt: 1, source: 'dialog' },
      { key: 'com.bad-tier', displayName: 'Bad', platform: 'win32', tier: 'vip', signatureStatus: null, signer: null, grantedAt: 1, lastUsedAt: 1, source: 'dialog' },
      { key: 'com.bad-time', displayName: 'Bad', platform: 'win32', tier: 'ordinary', signatureStatus: null, signer: null, grantedAt: 'soon', lastUsedAt: 1, source: 'dialog' },
    ],
    denied: [{ key: 'com.denied', displayName: 'Denied', platform: 'win32', deniedAt: 1 }, { key: '' }],
  }));
  const partial = createComputerUseGrantStore({ filePath, platform: 'win32', now: () => 3 });
  assert.deepEqual(partial.list().grants.map((record) => record.key), ['com.valid']);
  assert.deepEqual(partial.list().denied.map((record) => record.key), ['com.denied']);
});
