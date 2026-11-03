'use strict';

const path = require('node:path');
const { app } = require('electron');

const temporaryDirectory = process.env.ABU_E2E_TEMP_DIRECTORY;
if (typeof temporaryDirectory !== 'string' || !path.isAbsolute(temporaryDirectory)) {
  throw new Error('Electron test startup requires an absolute temporary directory');
}
app.setPath('temp', temporaryDirectory);
