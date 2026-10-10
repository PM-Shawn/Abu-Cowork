'use strict';

/**
 * `pet_set_frame` keeps the avatar where the user left it. The pet window
 * grows for the right-click menu and the notification bubble and shrinks back
 * to the bare 80x80 avatar; whatever sequence of frames it goes through, and
 * however far the work area pushed a grown frame, the bare avatar must come
 * back to the exact bounds it had before.
 *
 * Frame requests below are the ones src/pet/PetApp.tsx sends: `anchorBottom` /
 * `anchorRight` name the corner of the requested frame the avatar sits in.
 *
 * guiHost.cjs destructures from `electron` at load time, so the `electron`
 * cache slot is pre-filled with a fake BEFORE it is required — same technique
 * as guiHost.reveal.test.cjs.
 */

const assert = require('node:assert/strict');
const { test, beforeEach } = require('node:test');

const created = [];

class FakeBrowserWindow {
  constructor(options) {
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.destroyed = false;
    this.webContents = { id: created.length + 1, isDestroyed: () => false, on() {} };
    created.push(this);
  }
  isDestroyed() { return this.destroyed; }
  show() {}
  showInactive() {}
  once() { return this; }
  on() { return this; }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  loadFile() { return Promise.resolve(); }
  hide() {}
  destroy() { this.destroyed = true; }
  getBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = { ...bounds }; }
  static getAllWindows() { return created.filter((w) => !w.destroyed); }
  static fromWebContents() { return null; }
}

const DISPLAY = {
  id: 1,
  scaleFactor: 2,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 33, width: 1512, height: 949 },
};

const electronId = require.resolve('electron');
require.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  exports: {
    BrowserWindow: FakeBrowserWindow,
    screen: {
      getPrimaryDisplay: () => DISPLAY,
      getAllDisplays: () => [DISPLAY],
      getDisplayNearestPoint: () => DISPLAY,
      getDisplayMatching: () => DISPLAY,
    },
    app: { isPackaged: false },
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    ipcMain: {},
    nativeTheme: {},
    dialog: {},
  },
};

const { guiDispatch, teardownGuiHost } = require('./guiHost.cjs');

const BARE = { width: 80, height: 80 };
const MENU = { width: 200, height: 260 };
const BUBBLE_ABOVE = { width: 200, height: 151 };
const BUBBLE_SIDE = { width: 288, height: 80 };

/** Open the pet with its bare avatar at a DIP point (`pet_show` takes physical px). */
function showPetAt(x, y) {
  guiDispatch(null, 'pet_show', { position: { x: x * DISPLAY.scaleFactor, y: y * DISPLAY.scaleFactor } });
  const pet = created[created.length - 1];
  assert.deepEqual(pet.getBounds(), { x, y, ...BARE }, 'the pet was created at the requested spot');
  return pet;
}

function setFrame(size, anchorBottom, anchorRight) {
  guiDispatch(null, 'pet_set_frame', { ...size, anchorBottom, anchorRight });
}

/** The collapse PetApp sends when nothing has set its placement yet: 'above' / 'right'. */
const collapse = () => setFrame(BARE, true, false);

beforeEach(() => {
  teardownGuiHost();
  created.length = 0;
});

const MENU_CASES = [
  { name: 'left half', home: { x: 200, y: 333 }, right: false, menuAt: { x: 200, y: 333 } },
  { name: 'right half', home: { x: 1170, y: 333 }, right: true, menuAt: { x: 1050, y: 333 } },
  { name: 'left half, near the bottom edge', home: { x: 200, y: 856 }, right: false, menuAt: { x: 200, y: 722 } },
  { name: 'right half, near the bottom edge', home: { x: 1170, y: 856 }, right: true, menuAt: { x: 1050, y: 722 } },
  { name: 'docked on the left edge', home: { x: -32, y: 333 }, right: false, menuAt: { x: 0, y: 333 } },
  { name: 'docked on the right edge', home: { x: 1464, y: 333 }, right: true, menuAt: { x: 1312, y: 333 } },
];

for (const c of MENU_CASES) {
  test(`closing the menu restores the bare avatar's bounds: ${c.name}`, () => {
    const pet = showPetAt(c.home.x, c.home.y);
    setFrame(MENU, false, c.right);
    assert.deepEqual(pet.getBounds(), { ...c.menuAt, ...MENU }, 'the menu frame stays inside the work area');
    collapse();
    assert.deepEqual(pet.getBounds(), { ...c.home, ...BARE });
  });
}

test('opening and closing the menu repeatedly never drifts', () => {
  const pet = showPetAt(1170, 856);
  for (let i = 0; i < 5; i++) {
    setFrame(MENU, false, true);
    collapse();
  }
  assert.deepEqual(pet.getBounds(), { x: 1170, y: 856, ...BARE });
});

test('the menu opened over a bubble above the avatar keeps the avatar in place', () => {
  const pet = showPetAt(1170, 333);
  setFrame(BUBBLE_ABOVE, true, true);
  assert.deepEqual(pet.getBounds(), { x: 1050, y: 262, ...BUBBLE_ABOVE });
  setFrame(MENU, false, true);
  assert.deepEqual(pet.getBounds(), { x: 1050, y: 333, ...MENU }, 'the avatar is now the top corner of the menu frame');
  setFrame(BUBBLE_ABOVE, true, true);
  assert.deepEqual(pet.getBounds(), { x: 1050, y: 262, ...BUBBLE_ABOVE });
  setFrame(BARE, true, true);
  assert.deepEqual(pet.getBounds(), { x: 1170, y: 333, ...BARE });
});

test('a bubble that arrives while the menu is open keeps the avatar in place', () => {
  const pet = showPetAt(200, 333);
  setFrame(MENU, false, false);
  setFrame(BUBBLE_ABOVE, true, false);
  assert.deepEqual(pet.getBounds(), { x: 200, y: 262, ...BUBBLE_ABOVE });
  collapse();
  assert.deepEqual(pet.getBounds(), { x: 200, y: 333, ...BARE });
});

test('a bubble beside the avatar grows and shrinks around it', () => {
  const pet = showPetAt(1170, 73);
  setFrame(BUBBLE_SIDE, false, true);
  assert.deepEqual(pet.getBounds(), { x: 962, y: 73, ...BUBBLE_SIDE });
  setFrame(BARE, false, true);
  assert.deepEqual(pet.getBounds(), { x: 1170, y: 73, ...BARE });
});

test('dragging the pet while a bubble shows moves the spot it collapses to', () => {
  const pet = showPetAt(1170, 333);
  setFrame(BUBBLE_ABOVE, true, true);
  const grown = pet.getBounds();
  pet.setBounds({ ...grown, x: grown.x - 300, y: grown.y + 40 });
  setFrame(BARE, true, true);
  assert.deepEqual(pet.getBounds(), { x: 870, y: 373, ...BARE });
});

test('a pet reopened in a new window starts from its own bounds', () => {
  showPetAt(200, 856);
  setFrame(MENU, false, false);
  teardownGuiHost();
  const pet = showPetAt(600, 400);
  collapse();
  assert.deepEqual(pet.getBounds(), { x: 600, y: 400, ...BARE });
});
