'use strict';

// L5 chrome (W2 virtual cursor / W4 watchdog): the pure half of guiHost's
// chrome logic. The Electron half (timers, windows, screen) is exercised by
// electron/spike/overlayChromeVerify.cjs against real windows.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { __test } = require('./guiHost.cjs');

const { describeChromeEvent, chromePointFromDip, stripBounds, STRIP_WIDTH, STRIP_HEIGHT } = __test;

test('the strip sits bottom-centre of its display, follows the drag offset, and never leaves the display', () => {
  const display = { x: 2560, y: 0, width: 1920, height: 1080 };
  const home = stripBounds(display, null);
  assert.equal(home.width, STRIP_WIDTH);
  assert.equal(home.height, STRIP_HEIGHT);
  assert.equal(home.x + home.width / 2, display.x + display.width / 2);
  assert.equal(home.y + home.height, display.y + display.height - 16);

  const dragged = stripBounds(display, { dx: -300, dy: -500 });
  assert.deepEqual([dragged.x, dragged.y], [home.x - 300, home.y - 500]);

  const clamped = stripBounds(display, { dx: 99_999, dy: 99_999 });
  assert.equal(clamped.x, display.x + display.width - STRIP_WIDTH);
  assert.equal(clamped.y, display.y + display.height - STRIP_HEIGHT);
  const clampedUp = stripBounds(display, { dx: -99_999, dy: -99_999 });
  assert.deepEqual([clampedUp.x, clampedUp.y], [display.x, display.y]);
  // Garbage offsets count as none.
  assert.deepEqual(stripBounds(display, { dx: 'left', dy: null }), home);
});

test('the input lease drives the cursor marker: active on activate, off on observe/pause/end', () => {
  assert.deepEqual(describeChromeEvent('input_lease_activate', {}, {}), { kind: 'cursor', active: true });
  for (const cmd of ['input_lease_observe', 'input_lease_pause', 'input_lease_end']) {
    assert.deepEqual(describeChromeEvent(cmd, {}, {}), { kind: 'cursor', active: false }, cmd);
  }
  // Beginning or committing an observation says nothing about the pointer.
  assert.equal(describeChromeEvent('input_lease_begin', {}, {}), null);
  assert.equal(describeChromeEvent('input_lease_commit_observation', {}, {}), null);
});

test('pointer actions pulse at the point the helper was given; a drag pulses where it ended', () => {
  assert.deepEqual(describeChromeEvent('mouse_click', { x: 120, y: 340 }, 'ok'), { kind: 'pulse', pulse: 'click', x: 120, y: 340 });
  assert.deepEqual(describeChromeEvent('mouse_move', { x: 1, y: 2 }, 'ok'), { kind: 'pulse', pulse: 'move', x: 1, y: 2 });
  assert.deepEqual(describeChromeEvent('mouse_scroll', { x: 5, y: 6, delta_y: -3 }, 'ok'), { kind: 'pulse', pulse: 'scroll', x: 5, y: 6 });
  assert.deepEqual(
    describeChromeEvent('mouse_drag', { start_x: 10, start_y: 10, end_x: 200, end_y: 300 }, 'ok'),
    { kind: 'pulse', pulse: 'drag', x: 200, y: 300 },
  );
});

test('keyboard and element actions pulse without a point; observations and unknown commands do nothing', () => {
  for (const cmd of ['keyboard_type', 'keyboard_press']) {
    assert.deepEqual(describeChromeEvent(cmd, { text: 'never shown' }, 'ok'), { kind: 'pulse', pulse: 'keys' }, cmd);
  }
  for (const cmd of ['ax_press', 'ax_set_value', 'ax_replace_text', 'ax_perform_action']) {
    assert.deepEqual(describeChromeEvent(cmd, { elementId: 3 }, 'ok'), { kind: 'pulse', pulse: 'element' }, cmd);
  }
  for (const cmd of ['ax_snapshot', 'capture_screen', 'hello', 'list_windows', 'frontmost_app_identity']) {
    assert.equal(describeChromeEvent(cmd, {}, { bounds: [0, 0, 10, 10] }), null, cmd);
  }
});

test('a resolved target window makes the chrome follow it, but only with a full bounds tuple', () => {
  assert.deepEqual(
    describeChromeEvent('activate_window', { windowId: 'hwnd:0x1' }, { window_id: 'hwnd:0x1', bounds: [100, 200, 800, 600] }),
    { kind: 'follow', bounds: [100, 200, 800, 600] },
  );
  assert.deepEqual(
    describeChromeEvent('get_window', {}, { bounds: [1, 2, 3, 4] }),
    { kind: 'follow', bounds: [1, 2, 3, 4] },
  );
  assert.equal(describeChromeEvent('get_window', {}, { bounds: [1, 2, 3] }), null);
  assert.equal(describeChromeEvent('get_window', {}, 'notepad'), null);
  assert.equal(describeChromeEvent('activate_window', {}, null), null);
});

test('chrome page coordinates are relative to the display the chrome covers', () => {
  assert.deepEqual(chromePointFromDip({ x: 2600, y: 40 }, { x: 2560, y: 0, width: 1920, height: 1080 }), { x: 40, y: 40 });
  assert.deepEqual(chromePointFromDip({ x: 10.4, y: 20.6 }, { x: 0, y: 0, width: 1, height: 1 }), { x: 10, y: 21 });
  assert.equal(chromePointFromDip({ x: 1, y: 1 }, null), null);
  assert.equal(chromePointFromDip(null, { x: 0, y: 0 }), null);
});
