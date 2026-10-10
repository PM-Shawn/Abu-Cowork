import { describe, expect, it } from 'vitest';
import { RUN_BY_DEFAULT_EXTENSIONS, isRunByDefault } from './runByDefault';

describe('isRunByDefault', () => {
  it.each([
    '/Applications/Tool.app',
    '/Applications/Tool.app/',
    '/w/setup.command',
    '/w/build.tool',
    '/w/Resize.workflow',
    '/w/Import.action',
    '/w/Tidy.scpt',
    '/w/Tidy.scptd',
    '/w/tidy.applescript',
    '/w/Profile.terminal',
    '/w/Shortcut.fileloc',
    '/w/Shortcut.inetloc',
    '/w/Panel.prefPane',
    '/w/Installer.pkg',
    '/w/Installer.mpkg',
    '/w/Disk.dmg',
  ])('a macOS file the system starts or installs: %s', (path) => {
    expect(isRunByDefault(path)).toBe(true);
  });

  it.each([
    'C:\\w\\setup.exe',
    'C:\\w\\tool.com',
    'C:\\w\\run.bat',
    'C:\\w\\run.cmd',
    'C:\\w\\setup.msi',
    'C:\\w\\patch.msp',
    'C:\\w\\update.msu',
    'C:\\w\\saver.scr',
    'C:\\w\\old.pif',
    'C:\\w\\Report.lnk',
    'C:\\w\\Site.url',
    'C:\\w\\view.scf',
    'C:\\w\\keys.reg',
    'C:\\w\\job.vbs',
    'C:\\w\\job.vbe',
    'C:\\w\\job.jse',
    'C:\\w\\job.wsf',
    'C:\\w\\job.wsh',
    'C:\\w\\page.hta',
    'C:\\w\\panel.cpl',
    'C:\\w\\console.msc',
    'C:\\w\\manual.chm',
    'C:\\w\\manual.hlp',
    'C:\\w\\fix.diagcab',
    'C:\\w\\link.settingcontent-ms',
    'C:\\w\\app.msix',
    'C:\\w\\app.msixbundle',
    'C:\\w\\app.appx',
    'C:\\w\\app.appxbundle',
    'C:\\w\\app.appinstaller',
    'C:\\w\\app.application',
    'C:\\w\\app.appref-ms',
    'C:\\w\\clock.gadget',
    'C:\\w\\disk.iso',
    'C:\\w\\disk.img',
    'C:\\w\\disk.vhd',
    'C:\\w\\disk.vhdx',
  ])('a Windows file the system starts or installs: %s', (path) => {
    expect(isRunByDefault(path)).toBe(true);
  });

  it.each(['/w/app.jar', '/w/app.jnlp', '/w/Tool.AppImage', '/w/tool.desktop', '/w/setup.run', '/w/tool.deb', '/w/tool.rpm'])(
    'a file a runtime or a Linux desktop starts or installs: %s',
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
    '/w/report.doc',
    '/w/letter.rtf',
    '/w/notes.pages',
    '/w/budget.numbers',
    '/w/talk.key',
    '/w/draft.odt',
    '/w/archive.zip',
    '/w/sound.mp3',
    '/w/setup.exe.txt',
    '/w/Tool.app/Contents/Info.plist',
    'C:\\w\\报告.doc',
  ])('a document another application shows: %s', (path) => {
    expect(isRunByDefault(path)).toBe(false);
  });

  it('holds every extension in lower case, so the lookup is one comparison', () => {
    for (const extension of RUN_BY_DEFAULT_EXTENSIONS) {
      expect(extension).toBe(extension.toLowerCase());
    }
  });
});
