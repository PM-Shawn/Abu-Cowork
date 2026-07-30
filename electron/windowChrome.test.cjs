'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DARK_CHROME,
  LIGHT_CHROME,
  WINDOWS_TITLE_BAR_HEIGHT,
  WINDOW_DRAG_REGION_CSS,
  mainWindowPlatformOptions,
  removeDefaultApplicationMenu,
  syncMainWindowChromeTheme,
} = require('./windowChrome.cjs');

test('Windows uses Abu-colored window controls overlay without a persistent native menu', () => {
  assert.deepEqual(mainWindowPlatformOptions('win32', false), {
    backgroundColor: LIGHT_CHROME.backgroundColor,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: LIGHT_CHROME.backgroundColor,
      symbolColor: LIGHT_CHROME.symbolColor,
      height: WINDOWS_TITLE_BAR_HEIGHT,
    },
  });
  const calls = [];
  assert.equal(
    removeDefaultApplicationMenu({ setMenu: (menu) => calls.push(menu) }, 'win32'),
    true,
  );
  assert.deepEqual(calls, [null]);
});

test('macOS retains its application menu and traffic-light overlay', () => {
  const calls = [];
  assert.equal(
    removeDefaultApplicationMenu({ setMenu: (menu) => calls.push(menu) }, 'darwin'),
    false,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(mainWindowPlatformOptions('darwin', false), {
    backgroundColor: LIGHT_CHROME.backgroundColor,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 27 },
  });
});

test('Windows title-bar colors follow Abu dark and light theme changes', () => {
  const backgrounds = [];
  const overlays = [];
  const win = {
    isDestroyed: () => false,
    setBackgroundColor: (color) => backgrounds.push(color),
    setTitleBarOverlay: (options) => overlays.push(options),
  };
  assert.equal(syncMainWindowChromeTheme(win, true, 'win32'), true);
  assert.equal(syncMainWindowChromeTheme(win, false, 'win32'), true);
  assert.deepEqual(backgrounds, [
    DARK_CHROME.backgroundColor,
    LIGHT_CHROME.backgroundColor,
  ]);
  assert.deepEqual(overlays, [
    {
      color: DARK_CHROME.backgroundColor,
      symbolColor: DARK_CHROME.symbolColor,
      height: WINDOWS_TITLE_BAR_HEIGHT,
    },
    {
      color: LIGHT_CHROME.backgroundColor,
      symbolColor: LIGHT_CHROME.symbolColor,
      height: WINDOWS_TITLE_BAR_HEIGHT,
    },
  ]);
});

test('Electron maps both historical and current Tauri drag attributes', () => {
  assert.match(WINDOW_DRAG_REGION_CSS, /data-tauri-drag\]/);
  assert.match(WINDOW_DRAG_REGION_CSS, /data-tauri-drag-region\]/);
  assert.match(WINDOW_DRAG_REGION_CSS, /data-electron-no-drag/);
  assert.match(WINDOW_DRAG_REGION_CSS, /no-drag/);
});
