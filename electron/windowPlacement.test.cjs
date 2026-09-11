'use strict';

/**
 * Window position contract (electron/windowPlacement.cjs) and the Tauri-shaped
 * window commands built on it in tauriHost.cjs's windowDispatch:
 * `plugin:window|set_position`, `show`, `unminimize`, `set_focus`, and the
 * `tauri://move` event.
 *
 * tauriHost.cjs destructures `screen`/`BrowserWindow` from `electron` at load
 * time, so the `electron` cache slot is pre-filled with a fake BEFORE it is
 * required — same technique as browserHost.ownership.test.cjs.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

/** Fake Electron `screen` over a fixed display list (DIP geometry, like Electron). */
function fakeScreen(displays, primaryIndex = 0) {
  const area = (r, b) => {
    const w = Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x);
    const h = Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y);
    return Math.max(0, w) * Math.max(0, h);
  };
  const distance = (p, b) => {
    const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.width));
    const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.height));
    return Math.hypot(dx, dy);
  };
  const nearest = (p) => displays.reduce((a, d) => (distance(p, d.bounds) < distance(p, a.bounds) ? d : a));
  return {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[primaryIndex],
    getDisplayNearestPoint: nearest,
    // Electron: the display that most closely intersects the bounds.
    getDisplayMatching(rect) {
      let best = null;
      for (const d of displays) {
        const a = area(rect, d.bounds);
        if (a > 0 && (!best || a > best.a)) best = { d, a };
      }
      return best ? best.d : nearest({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    },
  };
}

const RETINA = {
  id: 1,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 33, width: 1512, height: 949 },
};
const EXTERNAL_1X = {
  id: 2,
  scaleFactor: 1,
  bounds: { x: 1512, y: 0, width: 1920, height: 1080 },
  workArea: { x: 1512, y: 25, width: 1920, height: 1055 },
};
const WIN_150 = {
  id: 3,
  scaleFactor: 1.5,
  bounds: { x: 0, y: 0, width: 1707, height: 960 },
  workArea: { x: 0, y: 0, width: 1707, height: 912 },
};

/** Fake BrowserWindow with just the geometry/visibility surface windowDispatch uses. */
class FakeWindow {
  constructor(bounds, webContents = { id: Math.random(), isDestroyed: () => false, sent: [] }) {
    this.bounds = { ...bounds };
    this.webContents = webContents;
    this.webContents.send = (channel, message) => this.webContents.sent.push({ channel, message });
    this.minimized = false;
    this.visible = true;
    this.focusCalls = 0;
    this.listeners = new Map();
  }
  isDestroyed() { return false; }
  getPosition() { return [this.bounds.x, this.bounds.y]; }
  getSize() { return [this.bounds.width, this.bounds.height]; }
  getBounds() { return { ...this.bounds }; }
  setPosition(x, y) {
    assert.ok(Number.isInteger(x) && Number.isInteger(y), 'BrowserWindow.setPosition needs integers');
    this.bounds.x = x;
    this.bounds.y = y;
    for (const fn of this.listeners.get('move') || []) fn();
  }
  isMinimized() { return this.minimized; }
  restore() { this.minimized = false; }
  show() { this.visible = true; }
  focus() { this.focusCalls += 1; }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
    return this;
  }
}

let currentScreen = fakeScreen([RETINA]);
const screenProxy = new Proxy({}, { get: (_t, key) => currentScreen[key] });
const electronId = require.resolve('electron');
require.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: {
    screen: screenProxy,
    app: { isPackaged: false },
    BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
    ipcMain: {},
    nativeTheme: {},
    dialog: {},
  },
};

const placement = require('./windowPlacement.cjs');
const tauriHost = require('./tauriHost.cjs');
const guiHost = require('./guiHost.cjs');
const { windowDispatch, WINDOW_DISPATCH_MISS } = tauriHost.__test;

function useDisplays(displays, primaryIndex = 0) {
  currentScreen = fakeScreen(displays, primaryIndex);
  return currentScreen;
}

test('set_position values: Tauri wire forms and the contextBridge-degraded Position are accepted', () => {
  const { parsePositionValue } = placement;
  assert.deepEqual(parsePositionValue({ Physical: { x: 480, y: 360 } }), { unit: 'Physical', x: 480, y: 360 });
  assert.deepEqual(parsePositionValue({ Logical: { x: 240, y: 180 } }), { unit: 'Logical', x: 240, y: 180 });
  // `new Position(new PhysicalPosition(x, y))` after contextBridge drops its prototype.
  assert.deepEqual(
    parsePositionValue({ position: { type: 'Physical', x: -32, y: 400 } }),
    { unit: 'Physical', x: -32, y: 400 }
  );
  assert.deepEqual(parsePositionValue({ type: 'Logical', x: 1, y: 2 }), { unit: 'Logical', x: 1, y: 2 });
});

test('set_position values: anything that is not two finite coordinates is rejected', () => {
  const { parsePositionValue } = placement;
  const bad = [
    null,
    undefined,
    42,
    'Physical',
    [],
    {},
    { Physical: null },
    { Physical: { x: 1 } },
    { Physical: { x: '1', y: 2 } },
    { Physical: { x: Number.NaN, y: 2 } },
    { Logical: { x: Infinity, y: 2 } },
    { Physical: { x: 1e7, y: 0 } },
    { position: { type: 'Device', x: 1, y: 2 } },
  ];
  for (const value of bad) {
    assert.throws(() => parsePositionValue(value), /set_position/, JSON.stringify(value));
  }
});

test('a physical position round-trips through outer_position/move and set_position on scale-2 and 1.5 displays', () => {
  for (const display of [RETINA, WIN_150]) {
    const screen = useDisplays([display]);
    for (let x = display.workArea.x; x < display.workArea.x + 400; x += 7) {
      const win = new FakeWindow({ x, y: display.workArea.y + 120, width: 80, height: 80 });
      const physical = placement.physicalPositionOf(screen, win);
      const back = placement.resolveWindowPosition(screen, { Physical: physical }, { width: 80, height: 80 });
      assert.deepEqual(back, { x, y: display.workArea.y + 120 }, `scale ${display.scaleFactor} at x=${x}`);
    }
  }
});

test('mixed scale factors: the display the window is on breaks the tie (Tauri converts with the current scale)', () => {
  const screen = useDisplays([RETINA, EXTERNAL_1X]);
  // Physical (1600, 100) is consistent on both: (800, 50) on the Retina panel
  // and (1600, 100) on the 1x external display.
  const value = { Physical: { x: 1600, y: 100 } };
  const size = { width: 80, height: 80 };
  assert.deepEqual(placement.resolveWindowPosition(screen, value, size, EXTERNAL_1X), { x: 1600, y: 100 });
  assert.deepEqual(placement.resolveWindowPosition(screen, value, size, RETINA), { x: 800, y: 50 });
  // A point only the external display explains is found even when the window
  // currently sits on the Retina panel.
  assert.deepEqual(
    placement.resolveWindowPosition(screen, { Physical: { x: 3000, y: 600 } }, size, RETINA),
    { x: 3000, y: 600 }
  );
});

test('the edge-snapped pet (40% off-screen) is restored exactly where it was parked', () => {
  const screen = useDisplays([RETINA]);
  const size = { width: 80, height: 80 };
  // usePetDrag parks 32 of 80 px past the left or right edge.
  assert.deepEqual(
    placement.resolveWindowPosition(screen, { Physical: { x: -64, y: 800 } }, size),
    { x: -32, y: 400 }
  );
  assert.deepEqual(
    placement.resolveWindowPosition(screen, { Physical: { x: (1512 - 80 + 32) * 2, y: 800 } }, size),
    { x: 1512 - 80 + 32, y: 400 }
  );
});

test('a position from a monitor that is gone is pulled fully onto the nearest work area', () => {
  const screen = useDisplays([RETINA]);
  const size = { width: 80, height: 80 };
  // Saved on a 1x external display to the right that is no longer attached.
  assert.deepEqual(
    placement.resolveWindowPosition(screen, { Physical: { x: 3000, y: 600 } }, size),
    { x: 1512 - 80, y: 300 }
  );
  // Far above the top: only a sliver would show — clamped below the menu bar.
  assert.deepEqual(
    placement.resolveWindowPosition(screen, { Logical: { x: 200, y: -70 } }, size),
    { x: 200, y: 33 }
  );
  // Just 10 px showing at the right edge is not "reachable" — pulled back in.
  assert.deepEqual(
    placement.resolveWindowPosition(screen, { Logical: { x: 1502, y: 300 } }, size),
    { x: 1512 - 80, y: 300 }
  );
});

test('the move event carries the physical position (same units as outer_position) of the window that moved', () => {
  const screen = useDisplays([RETINA]);
  const win = new FakeWindow({ x: 100, y: 200, width: 80, height: 80 });
  const emitted = [];
  placement.wireWindowMoveEvent(win, {
    screen,
    emitWindowEvent: (target, event, payload) => emitted.push({ target, event, payload }),
  });
  win.setPosition(240, 180);
  assert.deepEqual(emitted, [{ target: win, event: 'tauri://move', payload: { x: 480, y: 360 } }]);
});

test('tauri://move reaches only the moved window\'s own subscriptions', () => {
  useDisplays([RETINA]);
  tauriHost.__test.clearSubscriptions();
  const pet = new FakeWindow({ x: 100, y: 200, width: 80, height: 80 });
  const main = new FakeWindow({ x: 0, y: 33, width: 1200, height: 800 });
  tauriHost.__test.subscribe('tauri://move', 11, pet.webContents);
  tauriHost.__test.subscribe('tauri://move', 22, main.webContents);
  tauriHost.__test.subscribe('pet-status-update', 33, pet.webContents);

  placement.wireWindowMoveEvent(pet, { screen: screenProxy, emitWindowEvent: tauriHost.emitWindowEvent });
  pet.setPosition(240, 180);

  assert.equal(pet.webContents.sent.length, 1);
  assert.equal(pet.webContents.sent[0].channel, 'tauri:callback');
  assert.equal(pet.webContents.sent[0].message.id, 11);
  assert.deepEqual(pet.webContents.sent[0].message.payload.payload, { x: 480, y: 360 });
  assert.equal(pet.webContents.sent[0].message.payload.event, 'tauri://move');
  assert.equal(main.webContents.sent.length, 0, 'another window never hears this window move');
  tauriHost.__test.clearSubscriptions();
});

test('set_position moves the CALLING window (the pet restoring itself), not the main window', () => {
  useDisplays([RETINA]);
  const main = new FakeWindow({ x: 0, y: 33, width: 1200, height: 800 });
  const pet = new FakeWindow({ x: 1332, y: 802, width: 80, height: 80 });
  tauriHost.setMainWindow(main);
  const result = windowDispatch(
    { setBadgeCount() {} },
    'plugin:window|set_position',
    { label: 'main', value: { position: { type: 'Physical', x: 480, y: 360 } } },
    pet
  );
  assert.equal(result, null);
  assert.deepEqual(pet.getBounds(), { x: 240, y: 180, width: 80, height: 80 });
  assert.deepEqual(main.getBounds(), { x: 0, y: 33, width: 1200, height: 800 });
  assert.throws(
    () => windowDispatch({}, 'plugin:window|set_position', { label: 'main', value: { Physical: { x: 'a', y: 1 } } }, pet),
    /set_position/
  );
  assert.deepEqual(pet.getBounds(), { x: 240, y: 180, width: 80, height: 80 }, 'a rejected value moves nothing');
  // An unresolvable caller moves nothing — never the main window.
  assert.equal(
    windowDispatch({}, 'plugin:window|set_position', { label: 'main', value: { Physical: { x: 0, y: 66 } } }, null),
    null
  );
  assert.deepEqual(main.getBounds(), { x: 0, y: 33, width: 1200, height: 800 });
});

test('show / unminimize / set_focus act on the calling window and are real handlers', () => {
  useDisplays([RETINA]);
  const main = new FakeWindow({ x: 0, y: 33, width: 1200, height: 800 });
  tauriHost.setMainWindow(main);

  main.visible = false;
  assert.equal(windowDispatch({}, 'plugin:window|show', { label: 'main' }, main), null);
  assert.equal(main.visible, true);

  main.minimized = true;
  assert.equal(windowDispatch({}, 'plugin:window|unminimize', { label: 'main' }, main), null);
  assert.equal(main.minimized, false);
  // Not minimized: unminimize is a no-op, never an error.
  assert.equal(windowDispatch({}, 'plugin:window|unminimize', { label: 'main' }, main), null);

  assert.equal(windowDispatch({}, 'plugin:window|set_focus', { label: 'main' }, main), null);
  assert.equal(main.focusCalls, 1);

  // With no resolvable caller they fall back to the tracked main window.
  main.visible = false;
  windowDispatch({}, 'plugin:window|show', { label: 'main' }, null);
  assert.equal(main.visible, true);

  // Still a miss for commands this family does not own.
  assert.equal(windowDispatch({}, 'plugin:window|maximize', {}, main), WINDOW_DISPATCH_MISS);
});

test('pet_show creates the pet at its saved spot, or at the default corner when there is none or it is bad', () => {
  useDisplays([RETINA]);
  const { initialPetPosition } = guiHost.__test;
  assert.deepEqual(initialPetPosition({ x: 480, y: 360 }), { x: 240, y: 180 });
  // Edge-snapped spot is kept as-is.
  assert.deepEqual(initialPetPosition({ x: -64, y: 800 }), { x: -32, y: 400 });
  const corner = { x: 1512 - 80 - 100, y: 982 - 80 - 100 };
  assert.deepEqual(initialPetPosition(undefined), corner);
  assert.deepEqual(initialPetPosition(null), corner);
  assert.deepEqual(initialPetPosition({ x: Number.NaN, y: 1 }), corner);
  assert.deepEqual(initialPetPosition({ x: 'far', y: 1 }), corner);
});
