'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserControl } = require('./browserControl.cjs');
function setup() {
  const parent = { isDestroyed: () => false };
  const child = { isDestroyed: () => false };
  const family = new Set([parent, child]);
  const changes = [];
  const control = createBrowserControl({ familyFor: () => family, onChange: (page, phase) => changes.push([page, phase]) });
  return { parent, child, control, changes };
}
test('takeover freezes the entire opener family before cancelling and waits for work to settle', async () => {
  const { parent, child, control } = setup();
  const work = control.acquire(child);
  const taken = control.take(parent);
  assert.equal(control.phase(parent), 'yielding');
  assert.equal(control.phase(child), 'yielding');
  assert.equal(work.signal.aborted, true);
  assert.throws(() => work.assert(), /user has taken control/);
  assert.throws(() => control.acquire(child), /user has taken control/);
  assert.throws(() => control.release(parent), /still finishing/);
  assert.equal(control.manualTicket(child, {}, () => assert.fail('not ready')), null);
  work.end();
  assert.equal(await taken, 'human');
  assert.equal(control.phase(child), 'human');
  control.release(child);
  assert.equal(control.phase(parent), 'ai');
  assert.throws(() => work.assert(), /user has taken control/, 'old work never revives');
  const next = control.acquire(parent);
  next.assert();
  next.end();
});
test('exact native popup confirmation is single-request and expires on handback', async () => {
  const { parent, child, control } = setup();
  await control.take(parent);
  const owner = { key: 'original-owner' };
  const ticket = control.manualTicket(child, owner, () => true);
  assert.equal(ticket.owner, owner);
  assert.equal(ticket.valid(), true);
  control.release(parent);
  assert.equal(ticket.valid(), false);
  assert.equal(control.manualTicket(child, owner, () => assert.fail()), null);
});
test('denying one popup suppresses prompt storms for this takeover only', async () => {
  const { parent, control } = setup();
  await control.take(parent);
  assert.equal(control.manualTicket(parent, {}, () => false), null);
  assert.equal(control.manualTicket(parent, {}, () => assert.fail()), null);
  control.release(parent);
  await control.take(parent);
  assert.ok(control.manualTicket(parent, {}, () => true));
});
test('destruction or release during confirmation cannot authorize a child', async () => {
  const { parent, control } = setup();
  await control.take(parent);
  assert.equal(control.manualTicket(parent, {}, () => { control.release(parent); return true; }), null);
  await control.take(parent);
  assert.equal(control.manualTicket(parent, {}, () => { parent.isDestroyed = () => true; return true; }), null);
});
test('external cancellation remains wired and does not require takeover', () => {
  const { parent, control } = setup();
  const external = new AbortController();
  const work = control.acquire(parent, external.signal);
  external.abort();
  assert.equal(work.signal.aborted, true);
  assert.throws(() => work.assert());
  work.end();
  assert.equal(control.phase(parent), 'ai');
});

test('a newly adopted human child stays human after its opener closes', async () => {
  const parent = { isDestroyed: () => false };
  const child = { isDestroyed: () => false };
  const family = new Set([parent]);
  const control = createBrowserControl({ familyFor: () => family });
  await control.take(parent);
  family.add(child);
  control.inherit(parent, child);
  family.delete(parent);
  assert.equal(control.phase(child), 'human');
  assert.throws(() => control.acquire(child), /user has taken control/);
  control.release(child);
  const next = control.acquire(child);
  next.end();
});

test('takeover prepares suspended dialogs before waiting for the underlying action', async () => {
  const parent = { isDestroyed: () => false };
  let work;
  const control = createBrowserControl({ familyFor: () => new Set([parent]), prepare: async () => { work.end(); } });
  work = control.acquire(parent);
  assert.equal(await control.take(parent), 'human');
});

test('failed preparation remains frozen, reports failure, and permits a safe retry', async () => {
  const page = { isDestroyed: () => false };
  let fail = true;
  const control = createBrowserControl({ familyFor: () => new Set([page]), prepare: async () => { if (fail) throw new Error('dialog unavailable'); } });
  await assert.rejects(control.take(page), /dialog unavailable/);
  assert.equal(control.phase(page), 'yield-failed');
  assert.throws(() => control.acquire(page));
  assert.throws(() => control.release(page));
  fail = false;
  assert.equal(await control.take(page), 'human');
});

test('late dialog failure interrupts handover visibly without unfreezing AI', async () => {
  const { parent, control } = setup();
  const work = control.acquire(parent);
  const handover = control.take(parent);
  const failure = assert.rejects(handover, /late dialog/);
  control.fail(parent, new Error('late dialog'));
  await failure;
  assert.equal(control.phase(parent), 'yield-failed');
  work.end();
  assert.equal(await control.take(parent), 'human');
});

test('native confirmation failure cannot escape the window-open callback', async () => {
  const { parent, control } = setup();
  await control.take(parent);
  assert.equal(control.manualTicket(parent, {}, () => { throw new Error('window gone'); }), null);
});
test('native resources are finalized only after pending operations have really drained', async () => {
  const page = {isDestroyed:()=>false}; const events = [];
  const control = createBrowserControl({familyFor:()=>new Set([page]),
    prepare:async()=>{events.push('prepare');},finalize:async()=>{events.push('finalize');}});
  const work = control.acquire(page); const taken = control.take(page);
  await Promise.resolve(); assert.deepEqual(events,['prepare']);
  work.end(); assert.equal(await taken,'human'); assert.deepEqual(events,['prepare','finalize']);
});
