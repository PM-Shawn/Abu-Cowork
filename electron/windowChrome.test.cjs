'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DARK_CHROME,
  LIGHT_CHROME,
  WINDOWS_OVERLAY_BACKGROUND,
  WINDOWS_TOOLBAR_HEIGHT,
  WINDOWS_MENU_IDS,
  WINDOW_DRAG_REGION_CSS,
  buildWindowsMenuTemplate,
  configureApplicationMenu,
  mainWindowPlatformOptions,
  popupWindowsMenu,
  syncMainWindowChromeTheme,
  attachEditContextMenu,
} = require('./windowChrome.cjs');

/** Fake win/Menu pair capturing the context-menu handler and built templates. */
function contextMenuHarness() {
  const handlers = {};
  const built = [];
  const popups = [];
  const win = {
    webContents: {
      on: (event, handler) => {
        handlers[event] = handler;
      },
    },
  };
  const Menu = {
    buildFromTemplate: (template) => {
      built.push(template);
      return { popup: (opts) => popups.push(opts) };
    },
  };
  return { win, Menu, handlers, built, popups };
}

test('Windows overlays native caption buttons and removes the second menu-bar row', () => {
  assert.deepEqual(mainWindowPlatformOptions('win32', false), {
    backgroundColor: LIGHT_CHROME.backgroundColor,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: WINDOWS_OVERLAY_BACKGROUND,
      symbolColor: LIGHT_CHROME.symbolColor,
      height: 30,
    },
    autoHideMenuBar: true,
  });
  assert.equal(WINDOWS_TOOLBAR_HEIGHT, 30);
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
          return { native: true, getMenuItemById: () => null };
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
    menu: [null],
    autoHide: [true],
    visible: [false],
  });
  assert.deepEqual(templates[0].map((item) => item.label), [
    '编辑(&E)',
    '窗口(&W)',
    '帮助(&H)',
  ]);
  assert.deepEqual(templates[0].map((item) => item.id), [
    WINDOWS_MENU_IDS.edit,
    WINDOWS_MENU_IDS.window,
    WINDOWS_MENU_IDS.help,
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
      color: WINDOWS_OVERLAY_BACKGROUND,
      symbolColor: DARK_CHROME.symbolColor,
      height: WINDOWS_TOOLBAR_HEIGHT,
    },
    {
      color: WINDOWS_OVERLAY_BACKGROUND,
      symbolColor: LIGHT_CHROME.symbolColor,
      height: WINDOWS_TOOLBAR_HEIGHT,
    },
  ]);
});

test('Windows renderer menu buttons open the matching native submenu at a clamped DIP point', async () => {
  const popupCalls = [];
  const editSubmenu = {
    popup: (options) => {
      popupCalls.push(options);
      options.callback();
    },
  };
  const win = {
    setMenu: () => {},
    setAutoHideMenuBar: () => {},
    setMenuBarVisibility: () => {},
    isDestroyed: () => false,
    isMaximized: () => false,
    maximize: () => {},
    getContentSize: () => [1200, 800],
  };
  configureApplicationMenu(
    win,
    {
      buildFromTemplate: () => ({
        getMenuItemById: (id) => id === WINDOWS_MENU_IDS.edit
          ? { submenu: editSubmenu }
          : null,
      }),
    },
    { platform: 'win32' },
  );

  assert.equal(await popupWindowsMenu(win, { group: 'edit', x: -5, y: 36.4 }), true);
  assert.equal(popupCalls.length, 1);
  assert.equal(popupCalls[0].window, win);
  assert.equal(popupCalls[0].x, 0);
  assert.equal(popupCalls[0].y, 36);
  assert.throws(
    () => popupWindowsMenu(win, { group: 'file', x: 0, y: 0 }),
    /Unknown Windows title-bar menu/,
  );
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
  assert.doesNotMatch(WINDOW_DRAG_REGION_CSS, /\[data-electron-no-drag\] \*/);
});

test('portaled popper layers subtract themselves from the drag lanes', () => {
  // Radix renders poppers straight into document.body, so no ancestor of ours
  // can hand them the no-drag marker. Without this selector a dropdown opened
  // over the 72px Windows chrome band has every click eaten by the drag lane.
  assert.match(
    WINDOW_DRAG_REGION_CSS,
    /\[data-radix-popper-content-wrapper\]\{-webkit-app-region:no-drag\}/,
  );
});

test('edit context menu: editable fields get cut/copy/paste/select-all with editFlags-driven enabling', () => {
  const { win, Menu, handlers, built, popups } = contextMenuHarness();
  attachEditContextMenu(win, Menu, { isZh: true });
  handlers['context-menu'](null, {
    isEditable: true,
    selectionText: '',
    editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
  });
  assert.equal(built.length, 1);
  assert.deepEqual(
    built[0].map((item) => item.role ?? item.type),
    ['cut', 'copy', 'paste', 'separator', 'selectAll'],
  );
  assert.deepEqual(
    built[0].filter((item) => item.role).map((item) => item.enabled),
    [false, false, true, true],
  );
  assert.equal(built[0][0].label, '剪切');
  assert.equal(popups.length, 1);
});

test('edit context menu: selected non-editable text gets a copy-only menu', () => {
  const { win, Menu, handlers, built, popups } = contextMenuHarness();
  attachEditContextMenu(win, Menu, { isZh: false });
  handlers['context-menu'](null, {
    isEditable: false,
    selectionText: 'quoted reply',
    editFlags: { canCopy: true },
  });
  assert.equal(built.length, 1);
  assert.deepEqual(built[0].map((item) => item.role), ['copy']);
  assert.equal(built[0][0].label, 'Copy');
  assert.equal(popups.length, 1);
});

test('edit context menu: non-actionable right-clicks (no selection, not editable) show nothing', () => {
  const { win, Menu, handlers, built, popups } = contextMenuHarness();
  attachEditContextMenu(win, Menu, {});
  handlers['context-menu'](null, { isEditable: false, selectionText: '  ', editFlags: {} });
  assert.equal(built.length, 0);
  assert.equal(popups.length, 0);
});
