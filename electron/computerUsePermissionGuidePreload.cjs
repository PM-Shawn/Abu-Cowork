'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const GET_STATE_CHANNEL = 'computer-use-permission-guide:get-state';
const STATE_CHANNEL = 'computer-use-permission-guide:state';
const ACTION_CHANNEL = 'computer-use-permission-guide:action';

contextBridge.exposeInMainWorld('__ABU_PERMISSION_GUIDE__', {
  getState: () => ipcRenderer.invoke(GET_STATE_CHANNEL),
  onState: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on(STATE_CHANNEL, (_event, state) => callback(state));
  },
  sendAction: (action) => {
    if (!action || typeof action !== 'object') return;
    ipcRenderer.send(ACTION_CHANNEL, action);
  },
});
