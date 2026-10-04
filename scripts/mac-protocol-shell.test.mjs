import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { devBundleId, prepareMacProtocolShell, replaceDevShell } from './mac-protocol-shell.mjs';

class MemoryFileSystem {
  constructor() {
    this.files = new Map();
    this.directories = new Set(['/']);
    this.sequence = 0;
    this.realpathSync = (value) => path.resolve(value);
  }

  existsSync(value) {
    const target = path.resolve(value);
    return this.files.has(target) || this.directories.has(target);
  }

  lstatSync(value) {
    if (!this.existsSync(value)) throw new Error(`ENOENT: ${value}`);
    return { isSymbolicLink: () => false };
  }

  mkdirSync(value) {
    let current = path.resolve(value);
    const ancestors = [];
    while (!this.directories.has(current)) {
      ancestors.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (const directory of ancestors.reverse()) this.directories.add(directory);
  }

  mkdtempSync(prefix) {
    const directory = `${path.resolve(prefix)}fixture-${this.sequence++}`;
    this.mkdirSync(directory);
    return directory;
  }

  readFileSync(value) {
    const target = path.resolve(value);
    if (!this.files.has(target)) throw new Error(`ENOENT: ${value}`);
    return this.files.get(target);
  }

  writeFileSync(value, content) {
    const target = path.resolve(value);
    this.mkdirSync(path.dirname(target));
    this.files.set(target, String(content));
  }

  renameSync(from, to) {
    const source = path.resolve(from);
    const destination = path.resolve(to);
    if (!this.existsSync(source)) throw new Error(`ENOENT: ${from}`);
    if (this.existsSync(destination)) throw new Error(`EEXIST: ${to}`);
    this.mkdirSync(path.dirname(destination));
    const directoryEntries = [...this.directories]
      .filter((entry) => entry === source || entry.startsWith(`${source}${path.sep}`))
      .sort((left, right) => left.length - right.length);
    const fileEntries = [...this.files.entries()]
      .filter(([entry]) => entry === source || entry.startsWith(`${source}${path.sep}`));
    for (const entry of directoryEntries) {
      this.directories.delete(entry);
      this.directories.add(destination + entry.slice(source.length));
    }
    for (const [entry, content] of fileEntries) {
      this.files.delete(entry);
      this.files.set(destination + entry.slice(source.length), content);
    }
  }

  rmSync(value) {
    const target = path.resolve(value);
    for (const entry of [...this.files.keys()]) {
      if (entry === target || entry.startsWith(`${target}${path.sep}`)) this.files.delete(entry);
    }
    for (const entry of [...this.directories]) {
      if (entry === target || entry.startsWith(`${target}${path.sep}`)) this.directories.delete(entry);
    }
  }

  copyTree(sourceValue, destinationValue) {
    const source = path.resolve(sourceValue);
    const destination = path.resolve(destinationValue);
    this.mkdirSync(destination);
    for (const directory of [...this.directories]) {
      if (directory.startsWith(`${source}${path.sep}`)) {
        this.mkdirSync(destination + directory.slice(source.length));
      }
    }
    for (const [entry, content] of [...this.files.entries()]) {
      if (entry.startsWith(`${source}${path.sep}`)) {
        this.writeFileSync(destination + entry.slice(source.length), content);
      }
    }
  }
}

let fixtureSequence = 0;

function fixture() {
  const root = `/virtual/abu-shell-fixture-${fixtureSequence++}`;
  const fileSystem = new MemoryFileSystem();
  const electron = path.join(root, 'node_modules/electron');
  const source = path.join(electron, 'dist/Electron.app/Contents');
  fileSystem.writeFileSync(path.join(source, 'MacOS/Electron'), 'fake executable');
  fileSystem.writeFileSync(
    path.join(source, 'Info.plist'),
    JSON.stringify({ CFBundleIdentifier: 'com.github.Electron' }),
  );
  fileSystem.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ version: '42.0.0' }));
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command.endsWith('/ditto')) fileSystem.copyTree(args[0], args[1]);
    if (command.endsWith('/plutil')) {
      const plistPath = args.at(-1);
      const plist = JSON.parse(fileSystem.readFileSync(plistPath));
      if (args[0] === '-convert') return JSON.stringify(plist);
      plist[args[1]] = args[2] === '-json' ? JSON.parse(args[3]) : args[3];
      fileSystem.writeFileSync(plistPath, JSON.stringify(plist));
    }
    return '';
  };
  return { root, calls, run, fileSystem };
}

test('creates a separate dev-only bundle and leaves the installed Electron intact', () => {
  const { root, calls, run, fileSystem } = fixture();
  const executable = prepareMacProtocolShell(root, run, fileSystem);
  assert.equal(executable, path.join(root, '.dev-shell/Electron.app/Contents/MacOS/Electron'));
  const original = JSON.parse(fileSystem.readFileSync(path.join(root, 'node_modules/electron/dist/Electron.app/Contents/Info.plist')));
  const plist = JSON.parse(fileSystem.readFileSync(path.join(root, '.dev-shell/Electron.app/Contents/Info.plist')));
  assert.equal(original.CFBundleIdentifier, 'com.github.Electron');
  assert.equal(plist.CFBundleIdentifier, devBundleId(root, fileSystem.realpathSync));
  assert.deepEqual(plist.CFBundleURLTypes[0].CFBundleURLSchemes, ['abu-dev']);
  const sign = calls.findIndex((call) => call.args.includes('--sign'));
  const register = calls.findIndex((call) => call.command.endsWith('/lsregister'));
  assert.ok(sign >= 0 && register > sign);
  assert.equal(calls.at(-1).args.at(-3), 'abu-dev');
  assert.equal(calls.at(-1).args.at(-2), plist.CFBundleIdentifier);
});

test('reuses a valid signature but restores the handler on every launch', () => {
  const { root, calls, run, fileSystem } = fixture();
  prepareMacProtocolShell(root, run, fileSystem);
  calls.length = 0;
  prepareMacProtocolShell(root, run, fileSystem);
  assert.equal(calls.filter((call) => call.command.endsWith('/ditto')).length, 0);
  assert.equal(calls.filter((call) => call.args.includes('--sign')).length, 0);
  assert.equal(calls.filter((call) => call.command.endsWith('/lsregister')).length, 1);
  assert.equal(calls.filter((call) => call.command.endsWith('/xcrun')).length, 1);
});

test('rebuilds when the locked Electron version changes', () => {
  const { root, calls, run, fileSystem } = fixture();
  prepareMacProtocolShell(root, run, fileSystem);
  fileSystem.writeFileSync(path.join(root, 'node_modules/electron/package.json'), JSON.stringify({ version: '42.1.0' }));
  calls.length = 0;
  prepareMacProtocolShell(root, run, fileSystem);
  assert.equal(calls.filter((call) => call.args.includes('--sign')).length, 1);
});

test('refuses to report success if LaunchServices registration fails', () => {
  const { root, run, fileSystem } = fixture();
  assert.throws(() => prepareMacProtocolShell(root, (command, args, options) => {
    if (command.endsWith('/xcrun')) throw new Error('LaunchServices refused');
    return run(command, args, options);
  }, fileSystem), /LaunchServices refused/);
});

test('repairs a shell whose existing signature no longer verifies', () => {
  const { root, calls, run, fileSystem } = fixture();
  prepareMacProtocolShell(root, run, fileSystem);
  calls.length = 0;
  prepareMacProtocolShell(root, (command, args, options) => {
    if (command.endsWith('/codesign') && args.includes('--verify')
        && args.at(-1) === path.join(root, '.dev-shell/Electron.app')) {
      throw new Error('Invalid existing signature');
    }
    return run(command, args, options);
  }, fileSystem);
  assert.equal(calls.filter((call) => call.args.includes('--sign')).length, 1);
});

test('a failed rebuild preserves the previous shell and identity marker', () => {
  const { root, run, fileSystem } = fixture();
  const executable = prepareMacProtocolShell(root, run, fileSystem);
  const marker = path.join(root, '.dev-shell/identity.json');
  const previousIdentity = fileSystem.readFileSync(marker);
  fileSystem.writeFileSync(path.join(root, 'node_modules/electron/package.json'), JSON.stringify({ version: '42.1.0' }));
  assert.throws(() => prepareMacProtocolShell(root, (command, args, options) => {
    if (command.endsWith('/codesign') && args.includes('--sign')) throw new Error('Signing failed');
    return run(command, args, options);
  }, fileSystem), /Signing failed/);
  assert.equal(fileSystem.readFileSync(executable), 'fake executable');
  assert.equal(fileSystem.readFileSync(marker), previousIdentity);
});

test('different checkouts have stable distinct identities', () => {
  const first = fixture();
  const second = fixture();
  assert.equal(
    devBundleId(first.root, first.fileSystem.realpathSync),
    devBundleId(first.root, first.fileSystem.realpathSync),
  );
  assert.notEqual(
    devBundleId(first.root, first.fileSystem.realpathSync),
    devBundleId(second.root, second.fileSystem.realpathSync),
  );
});

test('restores the previous shell if the install rename fails', () => {
  const { root, run, fileSystem } = fixture();
  const executable = prepareMacProtocolShell(root, run, fileSystem);
  const app = path.join(root, '.dev-shell/Electron.app');
  const staged = path.join(root, '.dev-shell/build-test/Electron.app');
  fileSystem.mkdirSync(staged);
  const failingFileSystem = {
    ...fileSystem,
    existsSync: fileSystem.existsSync.bind(fileSystem),
    renameSync(from, to) {
      if (from === staged) throw new Error('Install rename failed');
      fileSystem.renameSync(from, to);
    },
    rmSync: fileSystem.rmSync.bind(fileSystem),
  };
  assert.throws(() => replaceDevShell(app, staged, failingFileSystem), /Install rename failed/);
  assert.equal(fileSystem.readFileSync(executable), 'fake executable');
  assert.equal(fileSystem.existsSync(path.join(root, '.dev-shell/build-test/previous.app')), false);
});

test('retains the backup path if both install and rollback fail', () => {
  const { root, run, fileSystem } = fixture();
  prepareMacProtocolShell(root, run, fileSystem);
  const app = path.join(root, '.dev-shell/Electron.app');
  const staged = path.join(root, '.dev-shell/build-test/Electron.app');
  const backup = path.join(root, '.dev-shell/build-test/previous.app');
  fileSystem.mkdirSync(staged);
  const failingFileSystem = {
    ...fileSystem,
    existsSync: fileSystem.existsSync.bind(fileSystem),
    renameSync(from, to) {
      if (from !== app) throw new Error('Rename unavailable');
      fileSystem.renameSync(from, to);
    },
    rmSync: fileSystem.rmSync.bind(fileSystem),
  };
  assert.throws(() => replaceDevShell(app, staged, failingFileSystem), /previous shell retained/);
  assert.equal(fileSystem.readFileSync(path.join(backup, 'Contents/MacOS/Electron')), 'fake executable');
});
