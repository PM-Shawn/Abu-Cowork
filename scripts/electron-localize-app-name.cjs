/**
 * electron-builder afterPack step — write localized display names into the
 * macOS bundle so Spotlight / Finder / Launchpad match the Chinese name
 * ("阿布") as well as "Abu".
 *
 * macOS resolves an app's localized name from
 * Contents/Resources/<locale>.lproj/InfoPlist.strings, gated by
 * LSHasLocalizedDisplayName in Info.plist (set via mac.extendInfo in
 * electron-builder.yml). Electron ships empty zh_CN.lproj / zh_TW.lproj
 * directories but no InfoPlist.strings, so without this step the bundle has
 * no Chinese name anywhere and Spotlight cannot match "阿布".
 *
 * Ordering: must run inside afterPack, BEFORE the outer app signature —
 * the signature seals Contents/Resources, so writing afterwards would
 * invalidate it. UTF-8 .strings files are valid on modern macOS (verified
 * against shipped third-party apps; plutil parses them).
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

/** Localized names keyed by .lproj directory name (Electron's naming). */
const LOCALIZED_APP_NAMES = {
  zh_CN: '阿布',
  zh_TW: '阿布',
};

/**
 * Localized NSMicrophoneUsageDescription (voice input). macOS shows it in the
 * microphone consent prompt; the English default lives in electron-builder.yml
 * `mac.extendInfo`.
 */
const LOCALIZED_MICROPHONE_USAGE = {
  zh_CN: '阿布使用麦克风把你的语音转写成消息草稿，音频只在本机处理。',
  zh_TW: '阿布使用麥克風把你的語音轉寫成訊息草稿，音訊只在本機處理。',
};

/** Escape a value for a .strings double-quoted literal. */
function stringsEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderInfoPlistStrings(localizedName, microphoneUsage) {
  const escaped = stringsEscape(localizedName);
  const lines = `CFBundleDisplayName = "${escaped}";\nCFBundleName = "${escaped}";\n`;
  return microphoneUsage
    ? `${lines}NSMicrophoneUsageDescription = "${stringsEscape(microphoneUsage)}";\n`
    : lines;
}

/**
 * Write InfoPlist.strings for each configured locale.
 * @param {string} resourcesDir absolute path to <App>.app/Contents/Resources
 * @returns {string[]} lproj directory names that were written
 */
function writeLocalizedAppNames(resourcesDir) {
  const written = [];
  for (const [lproj, localizedName] of Object.entries(LOCALIZED_APP_NAMES)) {
    const lprojDir = path.join(resourcesDir, `${lproj}.lproj`);
    fs.mkdirSync(lprojDir, { recursive: true });
    fs.writeFileSync(
      path.join(lprojDir, 'InfoPlist.strings'),
      renderInfoPlistStrings(localizedName, LOCALIZED_MICROPHONE_USAGE[lproj]),
    );
    written.push(lproj);
  }
  return written;
}

/** afterPack entry — no-op on non-mac platforms. */
function localizeMacAppName(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const resourcesDir = path.join(context.appOutDir, appName, 'Contents', 'Resources');
  const written = writeLocalizedAppNames(resourcesDir);
  console.log(`[localize-app-name] wrote InfoPlist.strings for ${written.join(', ')}`);
}

module.exports = {
  LOCALIZED_APP_NAMES,
  LOCALIZED_MICROPHONE_USAGE,
  renderInfoPlistStrings,
  writeLocalizedAppNames,
  localizeMacAppName,
};
