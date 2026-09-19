'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendBrowserKey, keyEventFor } = require('./browserKeyboard.cjs');

function fixture(send) {
  const calls = [];
  const contents = { focus() {}, debugger: { isAttached: () => true,
    detach() { throw new Error('Must not detach the dialog watcher'); },
    async sendCommand(method, params) { calls.push({ method, ...params }); return send?.(params); },
  } };
  return { contents, calls };
}

test('Enter carries carriage return and completes only after both native acknowledgements', async () => {
  let downAck, upAck;
  const down = new Promise((resolve) => { downAck = resolve; });
  const up = new Promise((resolve) => { upAck = resolve; });
  const { contents, calls } = fixture(({ type }) => type === 'keyDown' ? down : up);
  let completed = false;
  const pending = sendBrowserKey(contents, { key: 'Enter' }).then(() => { completed = true; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, '\r');
  assert.equal(calls[0].windowsVirtualKeyCode, 13);
  assert.equal(completed, false);
  downAck();
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].type, 'keyUp');
  assert.equal('text' in calls[1], false);
  assert.equal(completed, false);
  upAck();
  await pending;
  assert.equal(completed, true);
});

for (const [key, modifiers, expected] of [
  ['Tab', [], { code: 'Tab', windowsVirtualKeyCode: 9, text: '' }],
  ['ArrowDown', [], { code: 'ArrowDown', windowsVirtualKeyCode: 40, text: '' }],
  ['a', ['shift'], { key: 'A', code: 'KeyA', text: 'A', modifiers: 8 }],
  ['a', ['ctrl'], { key: 'a', code: 'KeyA', text: '', modifiers: 2 }],
  ['1', ['shift'], { key: '!', code: 'Digit1', text: '!' }],
  ['?', [], { key: '?', code: 'Slash', text: '?' }],
  ['Space', [], { key: ' ', code: 'Space', text: ' ' }],
  ['Enter', ['meta'], { key: 'Enter', text: '', modifiers: 4 }],
  ['中', [], { key: '中', code: '', text: '中', windowsVirtualKeyCode: 0 }],
]) {
  test(`keyboard mapping ${key}/${modifiers}`, () => {
    const event = keyEventFor({ key, modifiers });
    for (const [name, value] of Object.entries(expected)) assert.equal(event[name], value);
  });
}

for (const [key, modifiers, command] of [
  ['a', ['meta'], 'selectAll'], ['v', ['meta'], 'paste'], ['z', ['meta', 'shift'], 'redo'],
  ['ArrowLeft', ['alt', 'shift'], 'moveWordLeftAndModifySelection'],
  ['Backspace', ['meta'], 'deleteToBeginningOfLine'],
]) {
  test(`Mac editing command ${command} does not insert shortcut text`, async () => {
    const { contents, calls } = fixture();
    await sendBrowserKey(contents, { key, modifiers }, { platform: 'darwin' });
    assert.deepEqual(calls[0].commands, [command]);
    assert.equal(calls[0].text, '');
    assert.equal(calls[0].type, 'rawKeyDown');
  });
}

test('failed ACK is surfaced without fallback, retry, or key-up replay', async () => {
  const { contents, calls } = fixture(() => { throw new Error('native ACK failed'); });
  await assert.rejects(sendBrowserKey(contents, { key: 'Enter' }), /native ACK failed/);
  assert.equal(calls.length, 1);
});

test('cancellation after keydown prevents further input', async () => {
  const controller = new AbortController();
  const { contents, calls } = fixture(() => controller.abort());
  await assert.rejects(sendBrowserKey(contents, { key: 'Enter' }, {
    beforeDispatch() { if (controller.signal.aborted) throw new Error('cancelled'); },
  }), /cancelled/);
  assert.equal(calls.length, 1);
});

for (const key of ['', '__proto__', 'constructor', 'not-a-key']) {
  test(`unsupported key ${key} fails before native input`, async () => {
    const { contents, calls } = fixture();
    await assert.rejects(sendBrowserKey(contents, { key }), /key/i);
    assert.deepEqual(calls, []);
  });
}
