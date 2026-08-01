import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

declare const __ABU_CHROME_BRIDGE_VERSION__: string;

function readPackageVersion(): string {
  const filename = fileURLToPath(import.meta.url);
  const directory = dirname(filename);
  const pkg = JSON.parse(
    readFileSync(resolve(directory, '../package.json'), 'utf-8'),
  ) as { version: string };
  return pkg.version;
}

export const PKG_VERSION: string =
  typeof __ABU_CHROME_BRIDGE_VERSION__ === 'string'
    ? __ABU_CHROME_BRIDGE_VERSION__
    : readPackageVersion();
