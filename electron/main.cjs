/**
 * Electron main process — Phase 2 dev shell.
 *
 * Loads the real Abu frontend (built with a relative base into
 * dist-electron-spike/, falling back to the slice-1 placeholder if that build
 * is absent) behind the production Tauri-IPC bridge (preload.cjs + tauriHost.cjs,
 * which now includes the generic mcp_* process bridge). Launch with
 * `npm run electron:dev`.
 *
 * Sidecar ownership (mcp 收敛): main does NOT spawn/supervise the agent sidecar
 * itself — the FRONTEND's own sidecarManager drives it via mcp_spawn/mcp_write/
 * mcp_kill (routed to electron/mcpBridge.cjs), exactly as it did on Tauri. This
 * avoids two supervisors fighting over one sidecar. The standalone
 * SidecarSupervisor (electron/sidecarSupervisor.cjs) + `npm run electron:test`
 * remain as a tested component but are no longer auto-started here.
 * No-orphan on quit is handled by mcpBridge's process 'exit' guard.
 *
 * Security posture: contextIsolation on, nodeIntegration off, sandbox ON.
 * A sandboxed preload can still require('electron') for ipcRenderer/contextBridge
 * (only Node built-ins like fs/path/os are withheld), and preload.cjs uses
 * nothing else — so the OS renderer sandbox stays on. This matters: Abu renders
 * AI-generated inline-HTML widgets and loaded web pages, so a renderer-side RCE
 * must stay confined by the OS sandbox.
 */
'use strict';

const { app, BrowserWindow, dialog, Menu, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {
  registerTauriHost,
  wireWindowEvents,
  getMainWindow,
  getMigrationStartupBlock,
  getMigrationBackupPath,
  isMigrationStartupPending,
  emitEvent,
} = require('./tauriHost.cjs');
const {
  abuAppDataDir,
  sidecarBundleExists,
  sidecarPathFor,
} = require('./appEnv.cjs');
const { initDeepLink, handleSecondInstanceArgv } = require('./deepLinkHost.cjs');
const { registerPrivilegedWindow } = require('./securityBoundary.cjs');
const { isTauriTransitionBuild } = require('./releaseMetadata.cjs');
const { hideLegacyTauriUninstallEntry } = require('./legacyWindowsInstall.cjs');
const {
  WINDOW_DRAG_REGION_CSS,
  configureApplicationMenu,
  mainWindowPlatformOptions,
} = require('./windowChrome.cjs');
const {
  hasValidSentinel,
  estimateMigrationSpace,
  inspectLegacyElectronSymlinkRepairs,
  resolveTauriAppDataDir,
  SENTINEL_FILENAME,
  sourceInventory,
  backupElectronChromiumState,
} = require('./tauriMigration.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_INDEX = path.join(REPO_ROOT, 'dist-electron-spike', 'index.html');
const PLACEHOLDER_INDEX = path.join(__dirname, 'renderer', 'index.html');
const MIGRATION_INDEX = path.join(__dirname, 'migration-renderer', 'index.html');

// E2E launches can redirect the app-data parent before Electron initializes
// any path-backed service. Packaged builds require a second explicit flag so a
// stray ABU_E2E_APP_DATA_ROOT in a user's environment cannot redirect normal
// app data. Both controls remain main-process-only.
const E2E_APP_DATA_ROOT_ENV = 'ABU_E2E_APP_DATA_ROOT';
const PACKAGED_E2E_ENV = 'ABU_PACKAGED_E2E';
const E2E_AUTO_CONFIRM_TRANSITION_ENV = 'ABU_E2E_AUTO_CONFIRM_TRANSITION';
const allowE2EAppDataRedirect =
  !app.isPackaged || process.env[PACKAGED_E2E_ENV] === '1';
let e2eTauriStorageRoot = null;
if (allowE2EAppDataRedirect && Object.hasOwn(process.env, E2E_APP_DATA_ROOT_ENV)) {
  const appDataRoot = process.env[E2E_APP_DATA_ROOT_ENV];
  if (typeof appDataRoot !== 'string' || !path.isAbsolute(appDataRoot)) {
    throw new Error(`${E2E_APP_DATA_ROOT_ENV} must be an absolute path when set`);
  }
  app.setPath('appData', appDataRoot);
  // Electron's Chromium profile is separate from Abu's sidecar app-data tree.
  // Redirect both so installed/packaged migration tests cannot read or back up
  // a developer's real Local Storage, cookies, or other persistent state.
  app.setPath('userData', path.join(appDataRoot, 'Abu-e2e-user-data'));
  // Offline diagnostic export is part of the real-Electron E2E journey.
  // Keep its Downloads write inside the launch-specific temp root so the
  // test never leaves artifacts in a developer's real ~/Downloads folder.
  app.setPath('downloads', path.join(appDataRoot, 'Downloads'));
  e2eTauriStorageRoot = path.join(appDataRoot, 'tauri-webview-user-data');
}

// Keep local Electron development isolated while giving packaged builds the
// exact product identity used by Safe Storage and the user-data directory.
app.setName(app.isPackaged ? 'Abu' : 'abu-electron-dev');

function log(level, msg, extra) {
  const line = `[electron:${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

function isAutoConfirmedTransition() {
  return (
    process.env.CI === 'true' &&
    process.env[PACKAGED_E2E_ENV] === '1' &&
    process.env[E2E_AUTO_CONFIRM_TRANSITION_ENV] === '1'
  );
}

function showTransitionSuccess(appInstance, win) {
  if (isAutoConfirmedTransition()) return;
  const isZh = appInstance.getLocale().toLowerCase().startsWith('zh');
  const backupPath = getMigrationBackupPath();
  void dialog.showMessageBox(win, {
    type: 'info',
    title: isZh ? '升级完成' : 'Upgrade complete',
    message: isZh
      ? '旧版阿布数据已安全迁移'
      : 'Your legacy Abu data was migrated safely',
    detail: isZh
      ? [
          '聊天、设置、密钥和扩展配置已完成校验。',
          '旧版数据仍保留，可继续作为回退副本。',
          backupPath ? `Electron 迁移备份：${backupPath}` : '',
        ].filter(Boolean).join('\n')
      : [
          'Chats, settings, secrets, and extension configuration were verified.',
          'Legacy data remains in place as a rollback copy.',
          backupPath ? `Electron migration backup: ${backupPath}` : '',
        ].filter(Boolean).join('\n'),
    buttons: [isZh ? '进入阿布' : 'Continue to Abu'],
    defaultId: 0,
    noLink: true,
  });
}

function createWindow(transitionWindow = null) {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    minWidth: 900,
    // macOS overlays the traffic lights. Windows uses Window Controls Overlay:
    // the OS still owns caption buttons/Snap, while Abu renders the icon/menu
    // in the same row and keeps business controls in the row below.
    ...mainWindowPlatformOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  configureApplicationMenu(win, Menu, {
    platform: process.platform,
    isZh: app.getLocale().toLowerCase().startsWith('zh'),
    version: app.getVersion(),
    onAbout: () => {
      void dialog.showMessageBox(win, {
        type: 'info',
        title: 'Abu',
        message: 'Abu',
        detail: `v${app.getVersion()}`,
        buttons: ['OK'],
        noLink: true,
      });
    },
  });
  win.once('ready-to-show', () => {
    if (
      !getMigrationStartupBlock() &&
      !isMigrationStartupPending() &&
      !win.isDestroyed()
    ) {
      if (transitionWindow && !transitionWindow.isDestroyed()) {
        transitionWindow.destroy();
      }
      // Installed Apps must converge only after the migration gate has passed.
      // This marks the recognized pre-0.34 Tauri uninstall entry as a hidden
      // rollback component; it never removes old binaries or user data.
      if (process.platform === 'win32' && isTauriTransitionBuild(app)) {
        const legacyInstall = hideLegacyTauriUninstallEntry();
        log(
          legacyInstall.reason === 'registry-write-failed' ? 'warn' : 'info',
          'legacy Tauri install convergence',
          legacyInstall,
        );
      }
      win.show();
      if (transitionWindow) {
        showTransitionSuccess(app, win);
      }
    }
  });

  // Tauri drag regions use the [data-tauri-drag] attribute; under Electron a
  // window is dragged via CSS `-webkit-app-region`. Map them so the top bar
  // moves the window (interactive children stay clickable via no-drag).
  win.webContents.on('did-finish-load', () => {
    // Only the drag region's OWN empty space moves the window; EVERY descendant
    // is no-drag so it stays clickable. Tauri's data-tauri-drag-region behaves
    // this way (interactive children keep working) — the previous version only
    // excluded button/input/a, so the workspace TABS (plain divs) inherited the
    // drag region and showed the window-move cursor / were hard to click.
    void win.webContents.insertCSS(WINDOW_DRAG_REGION_CSS);
  });
  const hasFrontend = fs.existsSync(FRONTEND_INDEX);
  if (!hasFrontend) {
    log('warn', 'built frontend missing, loading placeholder', {
      expected: FRONTEND_INDEX,
      hint: 'npm run build:electron:renderer',
    });
  }

  // Wire window lifecycle → Tauri event/close contract (focus/blur, preventable
  // close with the isQuitting + has-listener guards, reload subscription purge).
  // Shared with the boot-verify harness so both exercise identical wiring.
  wireWindowEvents(win);

  const trustedPage = hasFrontend ? FRONTEND_INDEX : PLACEHOLDER_INDEX;
  registerPrivilegedWindow(win, trustedPage, { label: 'main' });
  void win.loadFile(trustedPage);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${Math.max(0.1, bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function inspectTransition(appInstance) {
  if (!isTauriTransitionBuild(appInstance)) return null;
  const tauriDir = resolveTauriAppDataDir(
    appInstance.getPath('appData'),
    appInstance.isPackaged
  );
  if (!fs.existsSync(tauriDir)) return null;
  const inventory = sourceInventory(tauriDir);
  const sentinelPath = path.join(abuAppDataDir(appInstance), SENTINEL_FILENAME);
  if (hasValidSentinel(sentinelPath, inventory.fingerprint)) return null;
  const files = Object.values(inventory.dirs)
    .reduce((total, item) => total + Number(item.files || 0), 0);
  const bytes = Object.values(inventory.dirs)
    .reduce((total, item) => total + Number(item.bytes || 0), 0);
  const electronDir = abuAppDataDir(appInstance);
  const legacySymlinkRepairs = inspectLegacyElectronSymlinkRepairs(
    tauriDir,
    electronDir
  );
  const space = estimateMigrationSpace(
    electronDir,
    inventory,
    appInstance.getPath('userData'),
    legacySymlinkRepairs
  );
  return {
    inventory,
    files,
    bytes,
    space,
    legacySymlinkRepairs: legacySymlinkRepairs.length,
  };
}

async function confirmTransition(appInstance, inspection) {
  const isZh = appInstance.getLocale().toLowerCase().startsWith('zh');
  if (!inspection.space.enough) {
    await dialog.showMessageBox({
      type: 'warning',
      title: isZh ? '升级空间不足' : 'Not enough space to upgrade',
      message: isZh
        ? '阿布尚未修改任何旧版数据'
        : 'Abu has not changed any legacy data',
      detail: isZh
        ? `安全迁移需要约 ${formatBytes(inspection.space.requiredBytes)}，当前可用约 ${formatBytes(inspection.space.availableBytes)}。请释放空间后重新打开阿布。`
        : `Safe migration needs about ${formatBytes(inspection.space.requiredBytes)}; about ${formatBytes(inspection.space.availableBytes)} is available. Free some space and reopen Abu.`,
      buttons: [isZh ? '退出' : 'Quit'],
      noLink: true,
    });
    return false;
  }
  // The installed Windows smoke has no interactive desktop driver. Allow it
  // to exercise the real installer/migration path only when all three explicit
  // CI harness markers are present. Normal packaged launches always retain the
  // user confirmation above/below, even if one stray variable is inherited.
  if (isAutoConfirmedTransition()) {
    return true;
  }
  const result = await dialog.showMessageBox({
    type: 'info',
    title: isZh ? '安全升级阿布' : 'Safely upgrade Abu',
    message: isZh
      ? '检测到旧版阿布数据，升级前将先备份并校验'
      : 'Legacy Abu data was found and will be backed up and verified first',
    detail: isZh
      ? [
          `检测到 ${inspection.files} 个数据文件（约 ${formatBytes(inspection.bytes)}）。`,
          '旧版数据不会被修改或删除；如发现 Electron 测试数据，将先备份再合并。',
          '升级过程中请保持阿布运行。',
        ].join('\n')
      : [
          `${inspection.files} data files were found (about ${formatBytes(inspection.bytes)}).`,
          'Legacy data will not be changed or deleted. Existing Electron test data is backed up before merging.',
          'Keep Abu open while the upgrade completes.',
        ].join('\n'),
    buttons: isZh ? ['开始安全升级', '退出'] : ['Start safe upgrade', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return result.response === 0;
}

async function createTransitionWindow(appInstance, inspection) {
  const isZh = appInstance.getLocale().toLowerCase().startsWith('zh');
  const win = new BrowserWindow({
    show: false,
    width: 560,
    height: 390,
    resizable: false,
    maximizable: false,
    minimizable: false,
    backgroundColor: '#faf8f3',
    title: isZh ? '阿布安全升级' : 'Abu safe upgrade',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `abu-transition-${process.pid}`,
    },
  });
  registerPrivilegedWindow(win, MIGRATION_INDEX, { label: 'transition' });
  await win.loadFile(MIGRATION_INDEX, {
    query: {
      locale: isZh ? 'zh-CN' : 'en-US',
      files: String(inspection.files),
      size: formatBytes(inspection.bytes),
    },
  });
  win.show();
  return win;
}

// Single-instance lock (Tauri had tauri_plugin_single_instance; this is its
// Electron equivalent). Without it, every launch — dock re-click, `open`,
// deep-link, `npm run electron:dev` — spawns a SEPARATE app + sidecar, and N
// instances then fight over the one data dir (dropped/swallowed messages, DB
// contention). With it, a second launch just focuses the existing window and
// exits, so there is always exactly one instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Deep-link wiring (abu://enroll → enterprise-bind pre-fill). MUST be set up
  // before app 'ready' so the early open-url listener is in place when the OS
  // delivers a launching URL, and the cold-start argv is parsed. See
  // electron/deepLinkHost.cjs for the competitor-grounded design.
  initDeepLink(app, { emitEvent, getMainWindow });

  app.on('second-instance', (_event, commandLine) => {
    const existing = getMainWindow() || BrowserWindow.getAllWindows()[0];
    if (existing && !getMigrationStartupBlock() && !isMigrationStartupPending()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    }
    // Win/Linux running-app deep link: the OS launched a second instance whose
    // argv carries the URL; forward it to the deep-link host to emit/queue.
    handleSecondInstanceArgv(commandLine);
  });

  app.whenReady().then(async () => {
    let transitionInspection = null;
    let transitionWindow = null;
    try {
      transitionInspection = inspectTransition(app);
    } catch (error) {
      const isZh = app.getLocale().toLowerCase().startsWith('zh');
      await dialog.showMessageBox({
        type: 'error',
        title: isZh ? '无法检查旧版数据' : 'Could not inspect legacy data',
        message: isZh
          ? '为避免数据风险，阿布已停止启动。'
          : 'Abu stopped before startup to protect your data.',
        detail: error instanceof Error ? error.message : String(error),
        buttons: [isZh ? '退出' : 'Quit'],
        noLink: true,
      });
      app.quit();
      return;
    }
    if (transitionInspection) {
      if (!(await confirmTransition(app, transitionInspection))) {
        app.quit();
        return;
      }
      transitionWindow = await createTransitionWindow(app, transitionInspection);
      await new Promise((resolve) => setImmediate(resolve));
    }
    registerTauriHost(app, {
      transitionInventory: transitionInspection?.inventory,
      tauriStorageRoot: e2eTauriStorageRoot,
    });
    if (transitionInspection) {
      try {
        backupElectronChromiumState(app.getPath('userData'), getMigrationBackupPath());
      } catch (error) {
        if (transitionWindow && !transitionWindow.isDestroyed()) {
          transitionWindow.destroy();
        }
        const isZh = app.getLocale().toLowerCase().startsWith('zh');
        await dialog.showMessageBox({
          type: 'error',
          title: isZh ? '升级备份未完成' : 'Upgrade backup incomplete',
          message: isZh
            ? '阿布没有删除旧版数据，请重新启动后重试。'
            : 'Abu did not delete legacy data. Restart to retry.',
          detail: error instanceof Error ? error.message : String(error),
          buttons: [isZh ? '退出' : 'Quit'],
          noLink: true,
        });
        app.quit();
        return;
      }
    }
    const migrationBlock = getMigrationStartupBlock();
    if (migrationBlock) {
      const isZh = app.getLocale().toLowerCase().startsWith('zh');
      void dialog
        .showMessageBox({
          type: 'error',
          title: isZh ? '升级数据迁移未完成' : 'Update migration incomplete',
          message: isZh
            ? 'Abu 没有写入或删除旧版数据。请重新启动后再试。'
            : 'Abu did not write to or delete the old app data. Restart the app to retry.',
          detail: isZh
            ? `为避免新框架先写入空数据，本次启动已停止。\n错误：${migrationBlock}`
            : `This launch was stopped before the new framework could write empty state.\nReason: ${migrationBlock}`,
          buttons: [isZh ? '退出' : 'Quit'],
          defaultId: 0,
          noLink: true,
        })
        .finally(() => app.quit());
      return;
    }
    // Preflight: the frontend spawns the sidecar via mcp_spawn, so a missing
    // bundle would surface only as an opaque child ENOENT — warn clearly here.
    if (!sidecarBundleExists(app)) {
      log('warn', 'sidecar bundle missing — the frontend will fail to start it; run `npm run build:sidecar`', {
        path: sidecarPathFor(app),
      });
    }
    createWindow(transitionWindow);
    app.on('activate', () => {
      // Dock-icon click / reactivation. Target the tracked MAIN window
      // specifically — NOT BrowserWindow.getAllWindows()[0], which since the GUI
      // families landed may be the pet / overlay (small, transparent) window, so
      // showing that left the main UI hidden. window_hide (closeAction 'minimize')
      // hides rather than destroys the main window, so it's still there to show.
      const mainWin = getMainWindow();
      if (mainWin && !getMigrationStartupBlock() && !isMigrationStartupPending()) {
        mainWin.show();
        mainWin.focus();
      } else if (!mainWin) {
        createWindow();
      }
      // TODO(slice E): Windows/Linux minimize-to-tray restore needs a tray
      // (no dock/activate equivalent there) — out of scope for slice D.
    });
  });

  app.on('window-all-closed', () => {
    // macOS convention keeps the app alive; here we quit so the frontend-driven
    // sidecar (killed by mcpBridge's exit guard) is torn down — dev ergonomics.
    app.quit();
  });
} // end single-instance-lock else
