'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {loadAutomationUrl} = require('./browserNavigation.cjs');
function fixture() {
  const contents = new EventEmitter(); let settle; let stops = 0;
  contents.isDestroyed = () => false;
  contents.loadURL = url => { contents.emit('did-start-navigation',{},url,false,true); return new Promise(resolve=>{settle=resolve;}); };
  contents.stop = () => {stops++; settle();};
  return {contents, finish:()=>settle(), stops:()=>stops};
}
test('abort stops the outstanding native navigation and removes listeners after it settles', async () => {
  const f=fixture(); const controller=new AbortController();
  const pending=loadAutomationUrl(f.contents,'https://example.com/',controller.signal);
  controller.abort(); await pending;
  assert.equal(f.stops(),1); assert.equal(f.contents.listenerCount('did-start-navigation'),0);
});
test('abort never stops a newer user navigation, including the same URL', async () => {
  const f=fixture(); const controller=new AbortController();
  const pending=loadAutomationUrl(f.contents,'https://example.com/',controller.signal);
  f.contents.emit('did-start-navigation',{},'https://example.com/',false,true);
  controller.abort(); assert.equal(f.stops(),0); f.finish(); await pending;
});
test('a child-frame navigation does not surrender ownership of the main load', async () => {
  const f=fixture(); const controller=new AbortController();
  const pending=loadAutomationUrl(f.contents,'https://example.com/',controller.signal);
  f.contents.emit('did-start-navigation',{},'https://frame.example/',false,false);
  controller.abort(); await pending; assert.equal(f.stops(),1);
});
test('same-document history changes do not strand an unfinished page load on cancellation', async () => {
  const f=fixture(); const controller=new AbortController();
  const pending=loadAutomationUrl(f.contents,'https://example.com/',controller.signal);
  f.contents.emit('did-start-navigation',{},'https://example.com/#loading',true,true);
  controller.abort(); await pending; assert.equal(f.stops(),1);
});
