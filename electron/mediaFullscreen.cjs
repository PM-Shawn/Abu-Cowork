'use strict';

const windows = new WeakMap();

function trackMediaFullscreen(window) {
  if (windows.has(window)) return;
  const state = { entered: window.isFullScreen(), owned: false, phase: 'idle', waiting: new Set() };
  windows.set(window, state);
  const complete = () => {
    state.phase = 'idle';
    for (const waiter of state.waiting) waiter.resolve();
    state.waiting.clear();
  };
  window.on('enter-html-full-screen', () => {
    state.owned = !state.entered;
    if (state.owned) state.phase = 'entering';
  });
  window.on('enter-full-screen', () => { state.entered = true; complete(); });
  window.on('leave-html-full-screen', () => {
    if (state.owned) state.phase = 'leaving';
    state.owned = false;
  });
  window.on('leave-full-screen', () => { state.entered = false; complete(); });
  window.once('closed', () => {
    for (const waiter of state.waiting) waiter.reject(new Error('Video window is unavailable'));
    state.waiting.clear();
  });
}

function waitForMediaFullscreen(window) {
  if (!window || window.isDestroyed()) throw new Error('Video window is unavailable');
  const state = windows.get(window);
  if (!state) throw new Error('Video window is not registered');
  if (process.platform !== 'darwin' || state.phase === 'idle') return Promise.resolve();
  return new Promise((resolve, reject) => { state.waiting.add({ resolve, reject }); });
}

module.exports = { trackMediaFullscreen, waitForMediaFullscreen };
