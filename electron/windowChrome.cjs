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
      autoHideMenuBar: false,
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
    win.setMenu(menu);
    win.setAutoHideMenuBar(false);
    win.setMenuBarVisibility(true);
    return true;
  }
  win.setMenu(null);
  return true;
}

function syncMainWindowChromeTheme(win, dark, platform = process.platform) {
  if (!win || win.isDestroyed?.()) return false;
  const colors = chromeColors(dark);
  win.setBackgroundColor?.(colors.backgroundColor);
  return true;
}

module.exports = {
  DARK_CHROME,
  LIGHT_CHROME,
  WINDOWS_TOOLBAR_HEIGHT,
  WINDOW_DRAG_REGION_CSS,
  buildWindowsMenuTemplate,
  configureApplicationMenu,
  mainWindowPlatformOptions,
  syncMainWindowChromeTheme,
};
