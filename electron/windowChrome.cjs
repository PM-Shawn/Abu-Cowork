'use strict';

const LIGHT_CHROME = {
  backgroundColor: '#f2f0e9',
  symbolColor: '#656358',
};
const DARK_CHROME = {
  backgroundColor: '#121110',
  symbolColor: '#f0ede8',
};
const WINDOWS_TOOLBAR_HEIGHT = 36;
// The renderer owns the complete visual title-bar plane. Keeping Electron's
// Window Controls Overlay background transparent lets theme colors and every
// full-window scrim flow underneath the native caption buttons automatically.
// This avoids a second modal/theme state machine in the main process.
const WINDOWS_OVERLAY_BACKGROUND = '#00000000';
const WINDOWS_MENU_IDS = Object.freeze({
  edit: 'abu-window-menu-edit',
  window: 'abu-window-menu-window',
  help: 'abu-window-menu-help',
});
const windowsMenus = new WeakMap();
const WINDOW_DRAG_REGION_CSS = [
  '[data-tauri-drag],[data-tauri-drag-region]{-webkit-app-region:drag;-webkit-user-select:none;user-select:none}',
  '[data-electron-no-drag],[data-electron-no-drag] *{-webkit-app-region:no-drag}',
].join('');

function chromeColors(dark) {
  return dark ? DARK_CHROME : LIGHT_CHROME;
}

function mainWindowPlatformOptions(platform = process.platform, dark = false) {
  const colors = chromeColors(dark);
  if (platform === 'darwin') {
    return {
      backgroundColor: colors.backgroundColor,
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 20, y: 27 },
    };
  }
  if (platform === 'win32') {
    return {
      backgroundColor: colors.backgroundColor,
      // Keep the system-owned caption buttons/Snap behavior, but let the
      // renderer use the rest of this SAME row for Abu's icon and menus.
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: WINDOWS_OVERLAY_BACKGROUND,
        symbolColor: colors.symbolColor,
        height: WINDOWS_TOOLBAR_HEIGHT,
      },
      autoHideMenuBar: true,
    };
  }
  return {
    backgroundColor: colors.backgroundColor,
    autoHideMenuBar: true,
  };
}

function buildWindowsMenuTemplate({
  isZh = false,
  version = '',
  onAbout = () => {},
  onToggleMaximize = () => {},
} = {}) {
  const label = (zh, en) => (isZh ? zh : en);
  return [
    {
      id: WINDOWS_MENU_IDS.edit,
      label: label('编辑(&E)', '&Edit'),
      submenu: [
        { role: 'undo', label: label('撤销', 'Undo') },
        { role: 'redo', label: label('重做', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: label('剪切', 'Cut') },
        { role: 'copy', label: label('复制', 'Copy') },
        { role: 'paste', label: label('粘贴', 'Paste') },
        { role: 'selectAll', label: label('全选', 'Select All') },
      ],
    },
    {
      id: WINDOWS_MENU_IDS.window,
      label: label('窗口(&W)', '&Window'),
      submenu: [
        { role: 'minimize', label: label('最小化', 'Minimize') },
        {
          label: label('最大化/还原', 'Maximize / Restore'),
          click: onToggleMaximize,
        },
        { type: 'separator' },
        { role: 'close', label: label('关闭窗口', 'Close Window') },
      ],
    },
    {
      id: WINDOWS_MENU_IDS.help,
      label: label('帮助(&H)', '&Help'),
      submenu: [
        {
          label: label(`关于 Abu（v${version}）`, `About Abu (v${version})`),
          click: onAbout,
        },
      ],
    },
  ];
}

function configureApplicationMenu(
  win,
  Menu,
  { platform = process.platform, isZh = false, version = '', onAbout } = {},
) {
  if (platform === 'darwin') return false;
  if (platform === 'win32') {
    const onToggleMaximize = () => {
      if (win.isDestroyed?.()) return;
      if (win.isMaximized?.()) win.unmaximize?.();
      else win.maximize?.();
    };
    const menu = Menu.buildFromTemplate(
      buildWindowsMenuTemplate({ isZh, version, onAbout, onToggleMaximize }),
    );
    // Store the native submenus for the renderer title-bar buttons, while
    // removing the OS menu BAR that otherwise consumes a second full row.
    // The popup itself is still an Electron Menu, so edit/window roles retain
    // native behavior and keyboard semantics.
    windowsMenus.set(win, menu);
    win.setMenu(null);
    win.setAutoHideMenuBar(true);
    win.setMenuBarVisibility(false);
    return true;
  }
  win.setMenu(null);
  return true;
}

function syncMainWindowChromeTheme(win, dark, platform = process.platform) {
  if (!win || win.isDestroyed?.()) return false;
  const colors = chromeColors(dark);
  win.setBackgroundColor?.(colors.backgroundColor);
  if (platform === 'win32') {
    win.setTitleBarOverlay?.({
      color: WINDOWS_OVERLAY_BACKGROUND,
      symbolColor: colors.symbolColor,
      height: WINDOWS_TOOLBAR_HEIGHT,
    });
  }
  return true;
}

function popupWindowsMenu(win, { group, x, y } = {}) {
  if (!win || win.isDestroyed?.()) return false;
  const id = WINDOWS_MENU_IDS[group];
  if (!id) throw new Error('Unknown Windows title-bar menu');
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('Windows title-bar menu coordinates must be finite');
  }
  const menu = windowsMenus.get(win);
  const submenu = menu?.getMenuItemById?.(id)?.submenu;
  if (!submenu || typeof submenu.popup !== 'function') return false;

  // Renderer client coordinates and Electron popup coordinates are both DIP.
  // Clamp untrusted renderer input to the current content bounds so a corrupt
  // value cannot strand a native menu off-screen.
  const [width, height] = win.getContentSize?.() || [0, 0];
  const clamp = (value, max) => Math.max(0, Math.min(Math.round(value), Math.max(0, max)));
  const popupX = clamp(x, width);
  const popupY = clamp(y, height);
  return new Promise((resolve) => {
    submenu.popup({
      window: win,
      x: popupX,
      y: popupY,
      callback: () => resolve(true),
    });
  });
}

module.exports = {
  DARK_CHROME,
  LIGHT_CHROME,
  WINDOWS_TOOLBAR_HEIGHT,
  WINDOWS_OVERLAY_BACKGROUND,
  WINDOW_DRAG_REGION_CSS,
  WINDOWS_MENU_IDS,
  buildWindowsMenuTemplate,
  configureApplicationMenu,
  mainWindowPlatformOptions,
  popupWindowsMenu,
  syncMainWindowChromeTheme,
};
