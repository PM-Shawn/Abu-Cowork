'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  OPEN_REFUSED_RUNS_BY_DEFAULT,
  createOpener,
  resolveOpenTarget,
} = require('./openPathPolicy.cjs');

const POSIX = process.platform !== 'win32';

function workspace(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'abu-open-policy-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(dir, name, mode = 0o644) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'sample\n', { mode });
  return file;
}

/** A shell that records what reaches it and opens nothing. */
function recordingShell(openPathResult = '') {
  const calls = [];
  return {
    calls,
    openPath: async (target) => { calls.push({ openPath: target }); return openPathResult; },
    openExternal: async (url) => { calls.push({ openExternal: url }); },
  };
}

/** A file system that answers for paths of another platform. */
function fakeFs(realPaths, stats = {}) {
  return {
    realpath: async (p) => realPaths[p] ?? p,
    stat: async (p) => stats[p] ?? { isFile: () => true, mode: 0o644 },
  };
}

test('a document opens, and the shell gets its real path', async (t) => {
  const dir = workspace(t);
  const file = writeFile(dir, 'report.pdf');
  const shell = recordingShell();
  assert.equal(await createOpener({ shell }).openPath(file), null);
  assert.deepEqual(shell.calls, [{ openPath: file }]);
});

test('a folder opens', async (t) => {
  const dir = workspace(t);
  const shell = recordingShell();
  await createOpener({ shell }).openPath(dir);
  assert.deepEqual(shell.calls, [{ openPath: dir }]);
});

for (const name of ['setup.command', 'build.tool', 'Tool.app', 'setup.exe', 'run.bat', 'run.cmd', 'job.vbs', 'job.js', 'Report.lnk', 'app.jar', 'job.py', 'job.sh', 'SETUP.EXE', 'setup.exe. ', 'report.pdf.command']) {
  test(`refuses ${JSON.stringify(name)} and the shell is never asked`, async (t) => {
    const dir = workspace(t);
    const file = writeFile(dir, POSIX ? name : name.replace(/[. ]+$/, ''));
    const shell = recordingShell();
    await assert.rejects(createOpener({ shell }).openPath(file), { message: OPEN_REFUSED_RUNS_BY_DEFAULT });
    assert.deepEqual(shell.calls, []);
  });
}

test('refuses a folder the system starts as an application', async (t) => {
  const dir = workspace(t);
  const bundle = path.join(dir, 'Tool.app');
  fs.mkdirSync(bundle);
  assert.deepEqual(await resolveOpenTarget(bundle), { refused: OPEN_REFUSED_RUNS_BY_DEFAULT });
  assert.deepEqual(await resolveOpenTarget(`${bundle}${path.sep}`), { refused: OPEN_REFUSED_RUNS_BY_DEFAULT });
});

test('refuses a document name that links to a file the system runs', { skip: !POSIX }, async (t) => {
  const dir = workspace(t);
  const target = writeFile(dir, 'setup.command');
  const link = path.join(dir, 'report.pdf');
  fs.symlinkSync(target, link);
  const shell = recordingShell();
  await assert.rejects(createOpener({ shell }).openPath(link), { message: OPEN_REFUSED_RUNS_BY_DEFAULT });
  assert.deepEqual(shell.calls, []);
});

test('refuses a run-by-default name that links to a document', { skip: !POSIX }, async (t) => {
  const dir = workspace(t);
  const target = writeFile(dir, 'notes.txt');
  const link = path.join(dir, 'notes.command');
  fs.symlinkSync(target, link);
  assert.deepEqual(await resolveOpenTarget(link), { refused: OPEN_REFUSED_RUNS_BY_DEFAULT });
});

test('a link to a document opens the document it points to', { skip: !POSIX }, async (t) => {
  const dir = workspace(t);
  const target = writeFile(dir, 'notes.txt');
  const link = path.join(dir, 'latest.txt');
  fs.symlinkSync(target, link);
  assert.deepEqual(await resolveOpenTarget(link), { path: target });
});

test('refuses an executable file with no extension, by itself or behind a link', { skip: !POSIX }, async (t) => {
  const dir = workspace(t);
  const program = writeFile(dir, 'deploy', 0o755);
  const link = path.join(dir, 'readme.txt');
  fs.symlinkSync(program, link);
  assert.deepEqual(await resolveOpenTarget(program), { refused: OPEN_REFUSED_RUNS_BY_DEFAULT });
  assert.deepEqual(await resolveOpenTarget(link), { refused: OPEN_REFUSED_RUNS_BY_DEFAULT });
});

test('a file with no extension that is not executable opens', { skip: !POSIX }, async (t) => {
  const dir = workspace(t);
  const license = writeFile(dir, 'LICENSE');
  const dotfile = writeFile(dir, '.gitignore');
  assert.deepEqual(await resolveOpenTarget(license), { path: license });
  assert.deepEqual(await resolveOpenTarget(dotfile), { path: dotfile });
});

test('an executable document opens: the extension decides, not the mode', { skip: !POSIX }, async (t) => {
  const dir = workspace(t);
  const file = writeFile(dir, 'notes.txt', 0o755);
  assert.deepEqual(await resolveOpenTarget(file), { path: file });
});

test('reads a Windows path the way Windows reads it', async () => {
  const options = { platform: 'win32', fs: fakeFs({}) };
  for (const refused of [
    'C:\\w\\setup.exe',
    'C:\\w\\SETUP.EXE',
    'C:\\w\\setup.exe.',
    'C:\\w\\setup.exe ',
    'C:\\w\\report.pdf.exe',
    'C:\\w\\report.txt:setup.exe',
    'C:\\w\\setup.exe:report.txt',
    'C:\\w\\report.txt:setup.exe:$DATA',
    'C:\\w\\.exe',
    'C:\\w\\.bat',
    'C:\\w\\.lnk.',
    'C:/w/Report.lnk',
    '\\\\server\\share\\run.bat',
  ]) {
    assert.deepEqual(await resolveOpenTarget(refused, options), { refused: OPEN_REFUSED_RUNS_BY_DEFAULT }, refused);
  }
  for (const opened of ['C:\\w\\report.pdf', 'C:\\w\\exe', 'C:\\w\\setup.exe\\report.pdf', 'C:\\w\\LICENSE', 'C:\\w\\.gitignore']) {
    assert.deepEqual(await resolveOpenTarget(opened, options), { path: opened }, opened);
  }
});

test('refuses a Windows path whose resolved target the system runs', async () => {
  const options = { platform: 'win32', fs: fakeFs({ 'C:\\w\\report.pdf': 'C:\\tools\\setup.exe' }) };
  assert.deepEqual(await resolveOpenTarget('C:\\w\\report.pdf', options), { refused: OPEN_REFUSED_RUNS_BY_DEFAULT });
});

test('Windows opens an extensionless file whatever its mode says', async () => {
  const stats = { 'C:\\w\\LICENSE': { isFile: () => true, mode: 0o777 } };
  assert.deepEqual(
    await resolveOpenTarget('C:\\w\\LICENSE', { platform: 'win32', fs: fakeFs({}, stats) }),
    { path: 'C:\\w\\LICENSE' },
  );
});

test('a path that does not exist fails, and the shell is never asked', async (t) => {
  const dir = workspace(t);
  const shell = recordingShell();
  await assert.rejects(createOpener({ shell }).openPath(path.join(dir, 'gone.pdf')), { code: 'ENOENT' });
  assert.deepEqual(shell.calls, []);
});

test('a missing path is rejected before the file system is read', async () => {
  for (const value of [undefined, null, '', 42, {}]) {
    await assert.rejects(resolveOpenTarget(value), TypeError);
  }
});

test('the shell\'s own failure text is thrown', async (t) => {
  const dir = workspace(t);
  const file = writeFile(dir, 'report.pdf');
  await assert.rejects(createOpener({ shell: recordingShell('No application is set') }).openPath(file), { message: 'No application is set' });
});

test('a file: URL is judged as the local path it names', async (t) => {
  const dir = workspace(t);
  const script = writeFile(dir, 'setup.command');
  const document = writeFile(dir, 'report.pdf');
  const shell = recordingShell();
  const opener = createOpener({ shell });
  await assert.rejects(opener.openUrl(pathToFileURL(script).href), { message: OPEN_REFUSED_RUNS_BY_DEFAULT });
  await assert.rejects(opener.openUrl(pathToFileURL(script).href.replace(/^file:/, 'FILE:')), { message: OPEN_REFUSED_RUNS_BY_DEFAULT });
  assert.deepEqual(shell.calls, []);
  await opener.openUrl(pathToFileURL(document).href);
  assert.deepEqual(shell.calls, [{ openPath: document }]);
});

test('a string with no scheme handed over as a URL is judged as a local path', async (t) => {
  const dir = workspace(t);
  const script = writeFile(dir, 'setup.command');
  const document = writeFile(dir, 'report.pdf');
  const shell = recordingShell();
  await assert.rejects(createOpener({ shell }).openUrl(script), { message: OPEN_REFUSED_RUNS_BY_DEFAULT });
  await createOpener({ shell }).openUrl(document);
  assert.deepEqual(shell.calls, [{ openPath: document }]);
});

test('a Windows drive path handed over as a URL is judged as a local path', async () => {
  const shell = recordingShell();
  const opener = createOpener({ shell, platform: 'win32', fs: fakeFs({}) });
  await assert.rejects(opener.openUrl('C:\\w\\setup.exe'), { message: OPEN_REFUSED_RUNS_BY_DEFAULT });
  await opener.openUrl('C:\\w\\report.pdf');
  assert.deepEqual(shell.calls, [{ openPath: 'C:\\w\\report.pdf' }]);
});

test('any other URL goes to the shell unchanged', async () => {
  const shell = recordingShell();
  const opener = createOpener({ shell });
  for (const url of ['https://example.com/setup.exe', 'mailto:someone@example.com', 'x-apple.systempreferences:com.apple.preference.security', 'chrome://extensions']) {
    await opener.openUrl(url);
  }
  assert.deepEqual(shell.calls.map((call) => call.openExternal), ['https://example.com/setup.exe', 'mailto:someone@example.com', 'x-apple.systempreferences:com.apple.preference.security', 'chrome://extensions']);
});