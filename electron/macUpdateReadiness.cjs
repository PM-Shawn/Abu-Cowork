'use strict';

/** The native event includes extraction, signature verification and staging. */
function createMacUpdateReadiness(nativeUpdater, timeoutMs = 120000) {
  let ready = false;
  let version = null;
  let handoffVersion = null;
  nativeUpdater.on('update-downloaded', () => { ready = true; });
  nativeUpdater.on('error', () => { ready = false; });

  async function download(updater, nextVersion, onHandoff = () => {}) {
    if (version !== nextVersion) ready = false;
    version = nextVersion;
    let resolveReady, rejectReady, timer;
    let active = true;
    let handoffReported = false;
    const prepared = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const onReady = () => resolveReady();
    const onError = error => rejectReady(error);
    const onDownloaded = () => {
      handoffVersion = nextVersion;
      if (!handoffReported) { handoffReported = true; onHandoff(); }
      if (!active || ready || timer) return;
      timer = setTimeout(() => rejectReady(new Error('ABU_UPDATE_PREPARATION_TIMEOUT')), timeoutMs);
    };
    nativeUpdater.once('update-downloaded', onReady);
    nativeUpdater.once('error', onError);
    updater.once('error', onError);
    updater.once('update-downloaded', onDownloaded);
    if (handoffVersion === nextVersion) onDownloaded();
    try {
      await Promise.all([
        prepared,
        updater.downloadUpdate().then(() => {
          if (!active) return;
          if (ready) resolveReady();
          else onDownloaded();
        }),
      ]);
    } finally {
      active = false;
      clearTimeout(timer);
      nativeUpdater.removeListener('update-downloaded', onReady);
      nativeUpdater.removeListener('error', onError);
      updater.removeListener('error', onError);
      updater.removeListener('update-downloaded', onDownloaded);
    }
  }

  return { download };
}

module.exports = { createMacUpdateReadiness };
