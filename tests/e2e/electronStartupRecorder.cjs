'use strict';

const { app } = require('electron');

globalThis.__abuStartupTemporaryDirectories = [];
app.on('browser-window-created', () => {
  globalThis.__abuStartupTemporaryDirectories.push(app.getPath('temp'));
});
