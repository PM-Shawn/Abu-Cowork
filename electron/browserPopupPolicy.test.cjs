'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBrowserPopupPolicy } = require('./browserPopupPolicy.cjs');
function fixture() {
  const origin = 'https://example.com';
  const source = Object.assign(new EventEmitter(), { id: 1, getURL: () => `${origin}/source`, isDestroyed: () => false });
  const owner = { key: 'conversation:calling-run' };
  const policy = createBrowserPopupPolicy({ originOf(url) {
    try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : null; } catch { return null; }
  } });
  const controller = new AbortController();
  const begin = (overrides = {}) => policy.beginAction(source, { owner, origin, signal: controller.signal, isCurrent: () => true, ...overrides });
  return { source, owner, policy, controller, begin, origin };
}

test('cancelled native children cannot dispatch even after a later navigation grant', () => {
  const { source, policy, origin } = fixture();
  policy.rejectChild(source);
  assert.equal(policy.permitsRequest(source.id, `${origin}/result`), false);
  assert.equal(policy.permitsRequest(source.id, `${origin}/script`, 'script'), false);
  assert.equal(policy.permitsRequest(source.id, 'data:text/html,cancelled', 'subFrame'), false);
  policy.approvedNavigation(source, `${origin}/result`);
  assert.equal(policy.permitsRequest(source.id, `${origin}/result`), false);
  let prevented = false;
  source.emit('will-navigate', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(policy.request(source, `${origin}/result`, { key: 'legacy' }), null);
  assert.throws(() => policy.attach(source, { valid: () => true }), /Popup blocked/);
});

test('a top-level lease allows exactly one same-origin native child owned by its caller', () => {
  const { source, owner, policy, begin, origin } = fixture();
  const lease = begin();
  const ticket = policy.request(source, `${origin}/article`, { key: 'legacy' });
  assert.equal(ticket.owner, owner);
  assert.equal(ticket.origin, origin);
  assert.equal(policy.request(source, `${origin}/other`), null);
  assert.equal(lease.blocked, true);
  lease.end();
  assert.equal(ticket.valid(), false);
});

for (const url of ['https://other.example/', 'https://example.com/checkout', 'https://example.com/%74ransfer', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'garbage']) {
  test(`lease does not authorize ${url}`, () => {
    const { source, policy, begin } = fixture();
    const lease = begin();
    assert.equal(policy.request(source, url), null);
    assert.equal(lease.blocked, true);
    lease.end();
  });
}

for (const mode of ['abort', 'document', 'owner', 'overlap', 'script', 'ended']) {
  test(`rejects ${mode} lease without falling back to legacy/manual permissions`, () => {
    const { source, policy, begin, origin, controller } = fixture();
    const lease = begin(mode === 'owner' ? { isCurrent: () => false } : mode === 'script' ? { origin: null } : {});
    if (mode === 'abort') controller.abort();
    if (mode === 'document') policy.documentChanged(source);
    if (mode === 'overlap') begin();
    if (mode === 'ended') lease.end();
    assert.equal(policy.request(source, `${origin}/article`, { key: 'legacy' }), null);
    lease.end();
  });
}

test('redirects and opener navigation remain bounded after the initiating action ends', () => {
  const { source, policy, begin, origin, controller } = fixture();
  const lease = begin();
  const ticket = policy.request(source, `${origin}/redirect`);
  const child = Object.assign(new EventEmitter(), { id: 2, getURL: () => `${origin}/child` });
  policy.attach(child, ticket);
  lease.end();
  assert.equal(policy.permitsRequest(2, `${origin}/article`), true);
  assert.equal(policy.permitsRequest(2, 'https://other.example/receive-post'), false);
  assert.equal(policy.permitsRequest(2, `${origin}/payment`), false);
  assert.equal(policy.permitsRequest(2, 'javascript:alert(1)'), false);
  controller.abort();
  assert.equal(policy.permitsRequest(2, `${origin}/article`), false);
  policy.approvedNavigation(child, 'https://other.example/checkout');
  assert.equal(policy.permitsRequest(2, 'https://other.example/checkout'), true);
  assert.equal(policy.permitsRequest(2, 'https://other.example/transfer'), false);
  child.emit('destroyed');
  assert.equal(policy.permitsRequest(2, `${origin}/article`), true, 'destroyed children release their request record');
});

test('pure manual pages use native http(s) semantics until AI first drives them', () => {
  const { source, policy, begin } = fixture();
  assert.ok(policy.request(source, 'https://other.example/', { key: 'manual' }));
  const lease = begin({ origin: null });
  lease.end();
  assert.equal(policy.request(source, 'https://other.example/', { key: 'manual' }), null);
});

// Regression from a native Electron probe: childRef.open() invokes the
// CHILD handler even though the AI executed JavaScript in its opener.
test('AI cannot borrow a previously manual child to open or navigate another origin', () => {
  const { source, policy, origin } = fixture();
  const ticket = policy.request(source, `${origin}/child`, { key: 'manual' });
  const child = Object.assign(new EventEmitter(), { id: 3, isDestroyed: () => false, getURL: () => `${origin}/child` });
  policy.attach(child, ticket);
  policy.markDriven(source);
  assert.equal(policy.request(child, 'https://other.example/', { key: 'manual' }), null);
  assert.equal(policy.permitsRequest(3, 'https://other.example/'), false);
  assert.equal(policy.permitsRequest(3, `${origin}/checkout`), false);
  assert.equal(policy.permitsRequest(3, `${origin}/article`), true);
});
