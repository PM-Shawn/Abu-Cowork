'use strict';

const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip');

async function prepareInstallerTools(projectDir) {
  if (process.platform !== 'win32') throw new Error('Windows installers must be built on Windows.');
  const executable = await getPath7za();
  const distribution = path.dirname(path.dirname(executable));
  const destination = path.join(projectDir, '.agent', 'installer-tools');
  await fs.mkdir(destination, { recursive: true });
  await fs.copyFile(executable, path.join(destination, '7za.exe'));
  await fs.copyFile(path.join(distribution, 'LICENSE.txt'), path.join(destination, '7zip-LICENSE.txt'));
  await fs.copyFile(path.join(distribution, 'COPYING'), path.join(destination, '7zip-COPYING'));
}

async function writeInstallerManifest(appOutDir) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(appOutDir, full).split(path.sep).join('/');
      if (relative === 'resources/abu-install-manifest.json') continue;
      if (entry.isSymbolicLink()) throw new Error(`Linked Windows package entry: ${relative}`);
      if (entry.isDirectory()) await visit(full);
      else {
        const { size } = await fs.stat(full);
        // Resource editing and Authenticode signing follow afterPack and change these sizes.
        files.push({ path: relative, size, signed: /\.(exe|dll|node)$/i.test(entry.name) });
      }
    }
  }
  await visit(appOutDir);
  const manifestPath = path.join(appOutDir, 'resources', 'abu-install-manifest.json');
  const contents = JSON.stringify({ schema: 1, files });
  if (!existsSync(manifestPath) || await fs.readFile(manifestPath, 'utf8') !== contents) {
    await fs.writeFile(manifestPath, contents);
  }
}

module.exports = { prepareInstallerTools, writeInstallerManifest };
if (require.main === module) {
  prepareInstallerTools(path.resolve(__dirname, '..')).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
