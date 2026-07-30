'use strict';

const LIGHT_CHROME = {
  backgroundColor: '#f2f0e9',
  symbolColor: '#656358',
};
const DARK_CHROME = {
  backgroundColor: '#121110',
  symbolColor: '#f0ede8',
};
const WINDOWS_TITLE_BAR_HEIGHT = 32;
const WINDOW_DRAG_REGION_CSS = [
  '[data-tauri-drag],[data-tauri-drag-region]{-webkit-app-region:drag}',
  '[data-tauri-drag] *,[data-tauri-drag-region] *{-webkit-app-region:no-drag}',
  '[data-electron-no-drag]{-webkit-app-region:no-drag}',
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
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: colors.backgroundColor,
        symbolColor: colors.symbolColor,
        height: WINDOWS_TITLE_BAR_HEIGHT,
      },
    };
  }
  return {
    backgroundColor: colors.backgroundColor,
    autoHideMenuBar: true,
  };
}

function removeDefaultApplicationMenu(win, platform = process.platform) {
  if (platform === 'darwin') return false;
  win.setMenu(null);
  return true;
}

function syncMainWindowChromeTheme(win, dark, platform = process.platform) {
  if (!win || win.isDestroyed?.()) return false;
  const colors = chromeColors(dark);
  win.setBackgroundColor?.(colors.backgroundColor);
  if (platform === 'win32') {
    win.setTitleBarOverlay({
      color: colors.backgroundColor,
      symbolColor: colors.symbolColor,
      height: WINDOWS_TITLE_BAR_HEIGHT,
    });
  }
  return true;
}

module.exports = {
  DARK_CHROME,
  LIGHT_CHROME,
  WINDOWS_TITLE_BAR_HEIGHT,
  WINDOW_DRAG_REGION_CSS,
  mainWindowPlatformOptions,
  removeDefaultApplicationMenu,
  syncMainWindowChromeTheme,
};
