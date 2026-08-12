'use strict';

/**
 * Wire cleanup that must happen when the renderer document is replaced.
 *
 * `did-start-loading` is intentionally not used here: Electron also emits it
 * when a child frame starts loading (for example an HTML widget iframe using
 * `srcdoc`). Clearing renderer-owned resources for that event disconnects the
 * still-live top-level renderer from its event subscriptions.
 *
 * @param {import('electron').WebContents} webContents
 * @param {(details: { reason: string }) => void} cleanup
 * @returns {() => void} removes the lifecycle listener
 */
function wireRendererResourceCleanup(webContents, cleanup) {
  const onNavigation = (_event, _url, isSameDocument, isMainFrame) => {
    if (isMainFrame !== true || isSameDocument === true) return;
    cleanup({ reason: 'main_frame_document_navigation' });
  };

  webContents.on('did-start-navigation', onNavigation);
  return () => webContents.removeListener('did-start-navigation', onNavigation);
}

module.exports = { wireRendererResourceCleanup };
