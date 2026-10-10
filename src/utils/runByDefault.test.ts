import { describe, expect, it } from 'vitest';
import { RUN_BY_DEFAULT_EXTENSIONS, isRunByDefault } from './runByDefault';

describe('isRunByDefault', () => {
  it.each(['/Applications/Tool.app', '/Applications/Tool.app/', '/w/setup.command', '/w/build.tool', '/w/Profile.terminal', '/w/Installer.pkg', '/w/Disk.dmg'])(
    'a macOS file the system starts or installs: %s',
    (path) => {
      expect(isRunByDefault(path)).toBe(true);
    },
  );

  it.each(['C:\\w\\setup.exe', 'C:\\w\\run.bat', 'C:\\w\\run.cmd', 'C:\\w\\setup.msi', 'C:\\w\\Report.lnk', 'C:\\w\\Site.url', 'C:\\w\\job.vbs', 'C:\\w\\page.hta'])(
    'a Windows file the system starts or installs: %s',
    (path) => {
      expect(isRunByDefault(path)).toBe(true);
    },
  );

  it.each(['C:\\w\\job.js', 'C:\\w\\job.py', 'C:\\w\\job.pyw', 'C:\\w\\job.sh', 'C:\\w\\job.rb', 'C:\\w\\job.pl', '/w/app.jar'])(
    'a script or archive its runtime starts on open: %s',
    (path) => {
      expect(isRunByDefault(path)).toBe(true);
    },
  );

  it.each(['/w/SETUP.EXE', '/w/Run.Bat', '/w/Build.COMMAND', '/w/Tool.App', '/w/app.JAR'])(
    'reads the extension in any letter case: %s',
    (path) => {
      expect(isRunByDefault(path)).toBe(true);
    },
  );

  it.each(['/w/report.pdf.exe', '/w/setup.exe.', '/w/setup.exe ', '/w/setup.exe. .'])(
    'reads the extension the system reads: %s',
    (path) => {
      expect(isRunByDefault(path)).toBe(true);
    },
  );

  // An executable file needs no extension, and nothing in a name tells one from a plain file.
  it.each(['/w/build', '/w/my.dir/Makefile', '/w/.profile', 'C:\\w\\tool'])('a name with no extension: %s', (path) => {
    expect(isRunByDefault(path)).toBe(true);
  });

  it.each([
    '/w/report.pdf',
    '/w/report.docx',
    '/w/notes.md',
    '/w/page.html',
    '/w/data.csv',
    '/w/chart.png',
    '/w/main.ts',
    '/w/module.mjs',
    '/w/setup.ps1',
    '/w/build.zsh',
    '/w/setup.exe.txt',
    '/w/Tool.app/Contents/Info.plist',
    'C:\\w\\报告.doc',
  ])('a file another application shows: %s', (path) => {
    expect(isRunByDefault(path)).toBe(false);
  });

  it('holds every extension in lower case, so the lookup is one comparison', () => {
    for (const extension of RUN_BY_DEFAULT_EXTENSIONS) {
      expect(extension).toBe(extension.toLowerCase());
    }
  });
});
