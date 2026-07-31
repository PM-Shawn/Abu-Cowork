'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DARK_CHROME,
  LIGHT_CHROME,
  WINDOWS_TOOLBAR_HEIGHT,
  WINDOW_DRAG_REGION_CSS,
  buildWindowsMenuTemplate,
  configureApplicationMenu,
  mainWindowPlatformOptions,
  syncMainWindowChromeTheme,
} = require('./windowChrome.cjs');

test('Windows keeps the native frame and a visible localized application menu', () => {
  assert.deepEqual(mainWindowPlatformOptions('win32', false), {
    backgroundColor: LIGHT_CHROME.backgroundColor,
    autoHideMenuBar: false,
  });
  assert.equal(WINDOWS_TOOLBAR_HEIGHT, 36);
  const templates = [];
  const calls = { menu: [], autoHide: [], visible: [], maximize: [], unmaximize: [] };
  let maximized = false;
  assert.equal(
    configureApplicationMenu(
      {
        setMenu: (menu) => calls.menu.push(menu),
        setAutoHideMenuBar: (value) => calls.autoHide.push(value),
        setMenuBarVisibility: (value) => calls.visible.push(value),
        isDestroyed: () => false,
        isMaximized: () => maximized,
        maximize: () => calls.maximize.push(true),
        unmaximize: () => calls.unmaximize.push(true),
      },
      {
        buildFromTemplate: (template) => {
          templates.push(template);
          return { native: true };
        },
      },
      { platform: 'win32', isZh: true, version: '0.34.0-rc.29' },
    ),
    true,
  );
  assert.deepEqual({
    menu: calls.menu,
    autoHide: calls.autoHide,
    visible: calls.visible,
  }, {
    menu: [{ native: true }],
    autoHide: [false],
    visible: [true],
  });
  assert.deepEqual(templates[0].map((item) => item.label), [
    '编辑(&E)',
    '窗口(&W)',
    '帮助(&H)',
  ]);
  assert.match(templates[0][2].submenu[0].label, /0\.34\.0-rc\.29/);
  const toggleMaximize = templates[0][1].submenu[1];
  assert.equal(toggleMaximize.role, undefined);
  toggleMaximize.click();
  assert.deepEqual(calls.maximize, [true]);
  maximized = true;
  toggleMaximize.click();
  assert.deepEqual(calls.unmaximize, [true]);
});

test('macOS retains its application menu and traffic-light overlay', () => {
  const calls = [];
  assert.equal(
    configureApplicationMenu(
      { setMenu: (menu) => calls.push(menu) },
      { buildFromTemplate: () => { throw new Error('must not build'); } },
      { platform: 'darwin' },
    ),
    false,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(mainWindowPlatformOptions('darwin', false), {
    backgroundColor: LIGHT_CHROME.backgroundColor,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 27 },
  });
});

test('Windows background follows Abu dark and light theme changes', () => {
  const backgrounds = [];
  const win = {
    isDestroyed: () => false,
    setBackgroundColor: (color) => backgrounds.push(color),
  };
  assert.equal(syncMainWindowChromeTheme(win, true, 'win32'), true);
  assert.equal(syncMainWindowChromeTheme(win, false, 'win32'), true);
  assert.deepEqual(backgrounds, [
    DARK_CHROME.backgroundColor,
    LIGHT_CHROME.backgroundColor,
  ]);
});

test('Windows menu exposes only the reviewed Edit, Window, and Help groups', () => {
  const template = buildWindowsMenuTemplate({ isZh: false, version: '1.2.3' });
  assert.deepEqual(template.map((item) => item.label), ['&Edit', '&Window', '&Help']);
  assert.equal(template.some((item) => /file|view/i.test(item.label)), false);
});

test('Electron maps both historical and current Tauri drag attributes', () => {
  assert.match(WINDOW_DRAG_REGION_CSS, /data-tauri-drag\]/);
  assert.match(WINDOW_DRAG_REGION_CSS, /data-tauri-drag-region\]/);
  assert.match(WINDOW_DRAG_REGION_CSS, /data-electron-no-drag/);
  assert.match(WINDOW_DRAG_REGION_CSS, /no-drag/);
});
