'use strict';

async function loadAutomationUrl(contents, url, signal) {
  if (signal?.aborted) throw new Error('Browser navigation cancelled');
  let ownsLoad = true;
  let starts = 0;
  // Redirects have their own did-redirect-navigation event. A second main
  // navigation belongs to someone else, even if it requests the same URL.
  const started = (_event, target, _inPlace, isMainFrame) => {
    if (!isMainFrame || _inPlace) return;
    starts++;
    if (starts > 1 || target !== url) ownsLoad = false;
  };
  const cancel = () => {
    if (ownsLoad && !contents.isDestroyed()) contents.stop();
  };
  contents.on('did-start-navigation', started);
  signal?.addEventListener('abort', cancel, {once:true});
  try { return await contents.loadURL(url); }
  finally {
    signal?.removeEventListener('abort', cancel);
    contents.removeListener('did-start-navigation', started);
  }
}
module.exports = {loadAutomationUrl};
