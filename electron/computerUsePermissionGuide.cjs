'use strict';

const { BrowserWindow, ipcMain, nativeImage, nativeTheme, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  nativeHelperDispatch,
  NATIVE_HELPER_MISS,
} = require('./nativeHelperManager.cjs');
const {
  computerUsePermissionHostDispatch,
  COMPUTER_USE_PERMISSION_HOST_MISS,
} = require('./computerUsePermissionHost.cjs');
const { registerPrivilegedWindow } = require('./securityBoundary.cjs');
const {
  sanitizeGuideStrings,
  normalizePermissions,
  normalizeRequirements,
  requiredPermissionsReady,
  derivePermissionGuideViewState,
  permissionsEqual,
  permissionWaitTimedOut,
} = require('./computerUsePermissionGuideState.cjs');

const COMPUTER_USE_PERMISSION_GUIDE_MISS =
  Symbol('computer-use-permission-guide-dispatch-miss');

const GUIDE_COMMANDS = new Set([
  'computer_use_permission_guide_show',
  'computer_use_permission_guide_close',
]);

const GET_STATE_CHANNEL = 'computer-use-permission-guide:get-state';
const STATE_CHANNEL = 'computer-use-permission-guide:state';
const ACTION_CHANNEL = 'computer-use-permission-guide:action';
const PRELOAD_PATH = path.join(__dirname, 'computerUsePermissionGuidePreload.cjs');
const GUIDE_FILE_NAME = 'computer-use-permission-guide.html';
const POLL_INTERVAL_MS = 1_200;
const POLL_TIMEOUT_MS = 120_000;
const COMPLETE_CLOSE_DELAY_MS = 850;
const GUIDE_WIDTH = 384;
const GUIDE_HEIGHT = 360;
const GUIDE_MARGIN = 20;

let guideWindow = null;
let guideState = null;
let guidePromise = null;
let guideResolve = null;
let pollTimer = null;
let completeTimer = null;
let permissionCheck = null;
let permissionRequest = null;
let destroyingWindow = false;
let handlersInstalled = false;

function tauriHost() {
  return require('./tauriHost.cjs');
}

function resolveGuidePage() {
  const built = path.join(__dirname, '..', 'dist-electron-spike', GUIDE_FILE_NAME);
  if (fs.existsSync(built)) return built;
  return path.join(__dirname, '..', 'public', GUIDE_FILE_NAME);
}

function resolveIconDataUrl(app) {
  const iconDirectory = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(__dirname, '..', 'src-tauri', 'icons');
  for (const fileName of ['128x128.png', '32x32.png', '512x512.png']) {
    const candidate = path.join(iconDirectory, fileName);
    if (!fs.existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image.toDataURL();
  }
  return '';
}

function currentPublicState() {
  if (!guideState) return null;
  return {
    strings: guideState.strings,
    iconDataUrl: guideState.iconDataUrl,
    development: guideState.development,
    requestedByTask: guideState.requestedByTask,
    view: derivePermissionGuideViewState({
      permissions: guideState.permissions,
      requirements: guideState.requirements,
      requesting: guideState.requesting,
      error: guideState.error,
      complete: guideState.complete,
    }),
  };
}

function sendState() {
  if (!guideWindow || guideWindow.isDestroyed()) return;
  guideWindow.webContents.send(STATE_CHANNEL, currentPublicState());
}

function setGuideState(patch) {
  if (!guideState) return;
  guideState = { ...guideState, ...patch };
  sendState();
}

function focusMainWindow() {
  const mainWindow = tauriHost().getMainWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function clearTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (completeTimer) clearTimeout(completeTimer);
  pollTimer = null;
  completeTimer = null;
}

function destroyGuideWindow() {
  if (!guideWindow || guideWindow.isDestroyed()) {
    guideWindow = null;
    return;
  }
  destroyingWindow = true;
  try {
    guideWindow.destroy();
  } finally {
    guideWindow = null;
    destroyingWindow = false;
  }
}

function settleGuide(status, { focusMain = true, error = null } = {}) {
  if (!guideResolve) {
    clearTimers();
    destroyGuideWindow();
    guideState = null;
    return;
  }
  const resolve = guideResolve;
  const permissions = normalizePermissions(guideState?.permissions);
  guideResolve = null;
  guidePromise = null;
  clearTimers();
  destroyGuideWindow();
  guideState = null;
  if (focusMain) focusMainWindow();
  resolve({
    status,
    permissions,
    error: typeof error === 'string' ? error : null,
  });
}

async function readPermissions() {
  if (permissionCheck) return permissionCheck;
  permissionCheck = Promise.resolve().then(async () => {
    let result = await computerUsePermissionHostDispatch(
      'check_macos_permissions',
    );
    if (result === COMPUTER_USE_PERMISSION_HOST_MISS) {
      result = await nativeHelperDispatch('check_macos_permissions', {});
    }
    if (result === NATIVE_HELPER_MISS) {
      throw new Error('Computer Use permission service is unavailable');
    }
    return normalizePermissions({
      screenRead: result?.screen_recording,
      uiControl: result?.accessibility,
      screen_recording_status: result?.screen_recording_status,
      accessibility_status: result?.accessibility_status,
      restart_required: result?.restart_required,
    });
  }).finally(() => {
    permissionCheck = null;
  });
  return permissionCheck;
}

function scheduleComplete() {
  if (completeTimer || !guideResolve) return;
  setGuideState({ complete: true, requesting: null, error: null });
  completeTimer = setTimeout(() => {
    settleGuide('complete');
  }, COMPLETE_CLOSE_DELAY_MS);
}

async function refreshPermissions() {
  if (!guideState) return null;
  try {
    const permissions = await readPermissions();
    if (!guideState) return permissions;
    const changed = !permissionsEqual(guideState.permissions, permissions);
    guideState = {
      ...guideState,
      permissions,
      error: null,
      complete: requiredPermissionsReady(permissions, guideState.requirements),
    };
    if (changed || guideState.complete) sendState();
    if (guideState.complete) scheduleComplete();
    return permissions;
  } catch (error) {
    if (guideState) {
      setGuideState({
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

function stopTimedOutPolling() {
  if (!guideState || guideState.complete) return false;
  if (!permissionWaitTimedOut(guideState.startedAt, Date.now(), POLL_TIMEOUT_MS)) {
    return false;
  }
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  setGuideState({
    requesting: null,
    error: guideState.strings.timeout,
  });
  return true;
}

async function requestPermission(permission) {
  if (
    !guideState
    || permissionRequest
    || !['screenRead', 'uiControl'].includes(permission)
  ) {
    return;
  }
  const view = derivePermissionGuideViewState({
    permissions: guideState.permissions,
    requirements: guideState.requirements,
    requesting: null,
  });
  if (view.currentPermission !== permission) return;

  setGuideState({ requesting: permission, error: null });
  const command = permission === 'screenRead'
    ? 'request_screen_recording'
    : 'request_accessibility';

  permissionRequest = Promise.resolve(computerUsePermissionHostDispatch(command))
    .then((result) => {
      if (result === COMPUTER_USE_PERMISSION_HOST_MISS) {
        throw new Error('Computer Use permission service is unavailable');
      }
    })
    .catch((error) => {
      if (guideState) {
        setGuideState({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .finally(async () => {
      permissionRequest = null;
      if (!guideState) return;
      setGuideState({ requesting: null });
      await refreshPermissions();
    });

  await permissionRequest;
}

function currentAppBundlePath(app) {
  const executable = app.getPath('exe');
  if (process.platform !== 'darwin') return executable;
  const marker = '.app/';
  const index = executable.toLowerCase().indexOf(marker);
  return index === -1 ? executable : executable.slice(0, index + 4);
}

function revealCurrentApp(app) {
  const appPath = currentAppBundlePath(app);
  shell.showItemInFolder(appPath);
}

function positionGuideWindow(win) {
  const mainWindow = tauriHost().getMainWindow();
  const display = mainWindow
    ? screen.getDisplayMatching(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  const workArea = display.workArea;
  win.setPosition(
    Math.round(workArea.x + GUIDE_MARGIN),
    Math.round(workArea.y + workArea.height - GUIDE_HEIGHT - GUIDE_MARGIN),
    false,
  );
}

function createGuideWindow(app) {
  const page = resolveGuidePage();
  const win = new BrowserWindow({
    width: GUIDE_WIDTH,
    height: GUIDE_HEIGHT,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#211f1c' : '#fdfcf9',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  guideWindow = win;
  positionGuideWindow(win);
  win.setAlwaysOnTop(true, 'floating', 1);
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // Unsupported outside macOS.
  }
  registerPrivilegedWindow(win, page, {
    label: 'computer-use-permission-guide',
  });
  win.webContents.on('did-finish-load', sendState);
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });
  win.on('closed', () => {
    guideWindow = null;
    if (!destroyingWindow && guideResolve) {
      settleGuide('cancelled');
    }
  });
  void win.loadFile(page);
  return win;
}

async function showGuide(app, args) {
  if (process.platform !== 'darwin') {
    return {
      status: 'unavailable',
      permissions: normalizePermissions(args?.permissions),
      error: 'Computer Use permission guide is only available on macOS',
    };
  }
  const strings = sanitizeGuideStrings(args?.strings);
  if (guidePromise) {
    if (guideWindow && !guideWindow.isDestroyed()) {
      guideWindow.show();
      guideWindow.focus();
    }
    return guidePromise;
  }

  let permissions;
  try {
    permissions = await readPermissions();
  } catch (error) {
    return {
      status: 'unavailable',
      permissions: normalizePermissions(args?.permissions),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const requirements = normalizeRequirements(args?.requirements);
  if (requiredPermissionsReady(permissions, requirements)) {
    return { status: 'complete', permissions, error: null };
  }

  guideState = {
    strings,
    iconDataUrl: resolveIconDataUrl(app),
    development: !app.isPackaged,
    requestedByTask: args?.requestedByTask === true,
    permissions,
    requirements,
    startedAt: Date.now(),
    requesting: null,
    error: null,
    complete: false,
  };
  guidePromise = new Promise((resolve) => {
    guideResolve = resolve;
  });
  createGuideWindow(app);
  pollTimer = setInterval(() => {
    if (!stopTimedOutPolling()) void refreshPermissions();
  }, POLL_INTERVAL_MS);
  return guidePromise;
}

function installHandlers(app) {
  if (handlersInstalled) return;
  handlersInstalled = true;

  ipcMain.handle(GET_STATE_CHANNEL, (event) => {
    if (!guideWindow || event.sender !== guideWindow.webContents) return null;
    return currentPublicState();
  });
  ipcMain.on(ACTION_CHANNEL, (event, action) => {
    if (!guideWindow || event.sender !== guideWindow.webContents) return;
    if (!action || typeof action !== 'object') return;
    switch (action.type) {
      case 'request':
        void requestPermission(action.permission);
        break;
      case 'retry': {
        if (guideState) guideState.startedAt = Date.now();
        if (!pollTimer) {
          pollTimer = setInterval(() => {
            if (!stopTimedOutPolling()) void refreshPermissions();
          }, POLL_INTERVAL_MS);
        }
        void refreshPermissions().then(() => {
          if (!guideState) return;
          const current = derivePermissionGuideViewState({
            permissions: guideState.permissions,
          }).currentPermission;
          if (current) void requestPermission(current);
        });
        break;
      }
      case 'reveal':
        revealCurrentApp(app);
        break;
      case 'return':
        if (guideState?.permissions?.restartRequired) settleGuide('relaunch-required');
        else if (guideState?.complete) settleGuide('complete');
        else focusMainWindow();
        break;
      case 'cancel':
        settleGuide('cancelled');
        break;
      default:
        break;
    }
  });
}

async function computerUsePermissionGuideDispatch(app, cmd, args) {
  if (!GUIDE_COMMANDS.has(cmd)) return COMPUTER_USE_PERMISSION_GUIDE_MISS;
  installHandlers(app);
  if (cmd === 'computer_use_permission_guide_show') {
    return showGuide(app, args || {});
  }
  settleGuide('cancelled');
  return null;
}

function teardownComputerUsePermissionGuide() {
  settleGuide('unavailable', {
    focusMain: false,
    error: 'Abu is closing',
  });
  if (handlersInstalled) {
    ipcMain.removeHandler(GET_STATE_CHANNEL);
    ipcMain.removeAllListeners(ACTION_CHANNEL);
  }
  handlersInstalled = false;
}

function isComputerUsePermissionGuideVisible() {
  return !!guideWindow && !guideWindow.isDestroyed() && guideWindow.isVisible();
}

module.exports = {
  computerUsePermissionGuideDispatch,
  COMPUTER_USE_PERMISSION_GUIDE_MISS,
  teardownComputerUsePermissionGuide,
  isComputerUsePermissionGuideVisible,
  currentAppBundlePath,
};
