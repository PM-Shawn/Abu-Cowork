'use strict';

// Standard DOM key names and Windows virtual-key values used by Chromium's
// input protocol. This is deliberately independent of the page's JavaScript.
const SPECIAL_KEYS = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9], Escape: ['Escape', 27],
  Backspace: ['Backspace', 8], Delete: ['Delete', 46], Insert: ['Insert', 45],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38],
  ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
  Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18], Meta: ['MetaLeft', 91],
  CapsLock: ['CapsLock', 20],
};
const PUNCTUATION = [
  ['`', '~', 'Backquote', 192], ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187],
  ['[', '{', 'BracketLeft', 219], [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220],
  [';', ':', 'Semicolon', 186], ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188],
  ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191], [' ', ' ', 'Space', 32],
];
const ALIASES = { Return: 'Enter', Esc: 'Escape', Space: ' ', Spacebar: ' ', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Del: 'Delete' };
const MODIFIERS = { alt: 1, control: 2, ctrl: 2, meta: 4, shift: 8 };

function keyEventFor(payload) {
  let key = Object.hasOwn(ALIASES, payload.key) ? ALIASES[payload.key] : String(payload.key || '');
  if (!key) throw new Error('Keyboard key is required');
  let modifiers = 0;
  for (const modifier of payload.modifiers || []) {
    const name = String(modifier).toLowerCase();
    const bit = Object.hasOwn(MODIFIERS, name) ? MODIFIERS[name] : 0;
    if (!bit) throw new Error(`Unsupported keyboard modifier: ${modifier}`);
    modifiers |= bit;
  }
  let definition = Object.hasOwn(SPECIAL_KEYS, key) ? SPECIAL_KEYS[key] : undefined;
  if (!definition && /^F([1-9]|1\d|2[0-4])$/.test(key)) definition = [key, 111 + Number(key.slice(1))];
  if (!definition && /^[a-z]$/i.test(key)) {
    if (modifiers & 8) key = key.toUpperCase();
    definition = [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), key];
  }
  if (!definition) {
    const shiftedDigits = ')!@#$%^&*(';
    const digit = /^\d$/.test(key) ? Number(key) : shiftedDigits.indexOf(key);
    if (digit >= 0 && digit <= 9 && key.length === 1) {
      if (modifiers & 8) key = shiftedDigits[digit];
      definition = [`Digit${digit}`, 48 + digit, key];
    }
  }
  if (!definition) {
    const punctuation = PUNCTUATION.find(([plain, shifted]) => key === plain || key === shifted);
    if (punctuation) {
      if (modifiers & 8) key = punctuation[1];
      definition = [punctuation[2], punctuation[3], key];
    }
  }
  if (!definition && Array.from(key).length === 1 && key.codePointAt(0) >= 160) {
    definition = ['', 0, key]; // Text without a US physical-key counterpart.
  }
  if (!definition) throw new Error(`Unsupported keyboard key: ${key}`);
  return { key, code: definition[0], windowsVirtualKeyCode: definition[1],
    modifiers, text: modifiers & 7 ? '' : definition[2] || '' };
}

function editingCommands(event, platform) {
  if (platform !== 'darwin') return [];
  const { key, modifiers } = event;
  const shift = !!(modifiers & 8);
  const base = modifiers & ~8;
  if (base === 4) {
    const shortcut = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: shift ? 'redo' : 'undo' }[key.toLowerCase()];
    if (shortcut) return [shortcut];
  }
  const movement = base === 4
    ? { ArrowLeft: 'moveToBeginningOfLine', ArrowRight: 'moveToEndOfLine', ArrowUp: 'moveToBeginningOfDocument', ArrowDown: 'moveToEndOfDocument' }
    : base === 1 ? { ArrowLeft: 'moveWordLeft', ArrowRight: 'moveWordRight', ArrowUp: 'moveParagraphBackward', ArrowDown: 'moveParagraphForward' } : {};
  if (movement[key]) return [movement[key] + (shift ? 'AndModifySelection' : '')];
  if (base === 4 && key === 'Backspace') return ['deleteToBeginningOfLine'];
  if (base === 4 && key === 'Delete') return ['deleteToEndOfLine'];
  if (base === 1 && key === 'Backspace') return ['deleteWordBackward'];
  if (base === 1 && key === 'Delete') return ['deleteWordForward'];
  return [];
}

async function sendBrowserKey(contents, payload, { beforeDispatch = () => {}, platform = process.platform } = {}) {
  const event = keyEventFor(payload);
  const debug = contents.debugger;
  // The host's dialog watcher normally owns this attachment. Never detach it
  // or replay an event after an ACK error: the page may already have submitted.
  if (!debug.isAttached()) debug.attach('1.3');
  contents.focus();
  beforeDispatch();
  await debug.sendCommand('Input.dispatchKeyEvent', {
    ...event, type: event.text ? 'keyDown' : 'rawKeyDown', unmodifiedText: event.text,
    commands: editingCommands(event, platform),
  });
  beforeDispatch();
  const { text: _text, ...released } = event;
  await debug.sendCommand('Input.dispatchKeyEvent', { ...released, type: 'keyUp' });
  return { success: true, message: `Key press: ${payload.modifiers?.length ? `${payload.modifiers.join('+')}+` : ''}${payload.key}` };
}

module.exports = { sendBrowserKey, keyEventFor };
