import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LOCALIZED_APP_NAMES,
  renderInfoPlistStrings,
  writeLocalizedAppNames,
  localizeMacAppName,
} from './electron-localize-app-name.cjs';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-localize-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { force: true, recursive: true });
  }
});

describe('electron-localize-app-name', () => {
  describe('renderInfoPlistStrings', () => {
    it('emits CFBundleDisplayName and CFBundleName entries', () => {
      expect(renderInfoPlistStrings('阿布')).toBe(
        'CFBundleDisplayName = "阿布";\nCFBundleName = "阿布";\n',
      );
    });

    it('escapes quotes and backslashes for the .strings literal', () => {
      expect(renderInfoPlistStrings('A"b\\c')).toBe(
        'CFBundleDisplayName = "A\\"b\\\\c";\nCFBundleName = "A\\"b\\\\c";\n',
      );
    });
  });

  describe('writeLocalizedAppNames', () => {
    it('writes InfoPlist.strings for every configured locale', () => {
      const resourcesDir = makeTempDir();
      const written = writeLocalizedAppNames(resourcesDir);
      expect(written.sort()).toEqual(Object.keys(LOCALIZED_APP_NAMES).sort());
      for (const [lproj, name] of Object.entries(LOCALIZED_APP_NAMES)) {
        const content = fs.readFileSync(
          path.join(resourcesDir, `${lproj}.lproj`, 'InfoPlist.strings'),
          'utf8',
        );
        expect(content).toContain(`CFBundleDisplayName = "${name}";`);
        expect(content).toContain(`CFBundleName = "${name}";`);
      }
    });

    it('covers Simplified and Traditional Chinese with 阿布', () => {
      expect(LOCALIZED_APP_NAMES).toMatchObject({ zh_CN: '阿布', zh_TW: '阿布' });
    });
  });

  describe('localizeMacAppName', () => {
    it('writes into <App>.app/Contents/Resources on darwin', () => {
      const appOutDir = makeTempDir();
      const resourcesDir = path.join(appOutDir, 'Abu.app', 'Contents', 'Resources');
      fs.mkdirSync(resourcesDir, { recursive: true });
      localizeMacAppName({
        electronPlatformName: 'darwin',
        appOutDir,
        packager: { appInfo: { productFilename: 'Abu' } },
      });
      expect(
        fs.existsSync(path.join(resourcesDir, 'zh_CN.lproj', 'InfoPlist.strings')),
      ).toBe(true);
    });

    it('is a no-op on non-darwin platforms', () => {
      const appOutDir = makeTempDir();
      localizeMacAppName({
        electronPlatformName: 'win32',
        appOutDir,
        packager: { appInfo: { productFilename: 'Abu' } },
      });
      expect(fs.readdirSync(appOutDir)).toEqual([]);
    });
  });

  describe('packaging contract', () => {
    const repoRoot = path.resolve(__dirname, '..');

    it('electron-builder.yml enables LSHasLocalizedDisplayName', () => {
      const yml = fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
      expect(yml).toMatch(/LSHasLocalizedDisplayName:\s*true/);
    });

    it('the afterPack hook wires localization before nested signing', () => {
      const hook = fs.readFileSync(
        path.join(repoRoot, 'scripts', 'electron-sign-nested.cjs'),
        'utf8',
      );
      const localizeCall = hook.lastIndexOf('localizeMacAppName(context)');
      const signCall = hook.lastIndexOf('signNestedMacBinaries(context)');
      expect(localizeCall).toBeGreaterThan(-1);
      expect(signCall).toBeGreaterThan(-1);
      expect(localizeCall).toBeLessThan(signCall);
    });
  });
});
