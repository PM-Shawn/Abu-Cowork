/**
 * Unit tests for the one-time Tauri→Electron migration orchestrator.
 * Everything host-specific is injected (fake secret store callbacks, a fixed
 * machine key), so these run in plain Node with temp dirs — no Electron, no
 * ioreg. The safeStorage end of the pipeline is covered by the
 * electron/spike/migrationVerify.cjs harness instead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeTauriSecretsFile, encryptTauriEntries } from './tauriSecretsReader.cjs';
import {
  resolveTauriAppDataDir,
  runTauriMigration,
  SENTINEL_FILENAME,
} from './tauriMigration.cjs';

const FIXED_KEY = Buffer.alloc(32, 7);
const quietLog = { log: () => {}, warn: () => {} };

let root: string;
let tauriDir: string;
let electronDir: string;

/** In-memory stand-in for secretStore.cjs. */
function fakeSecretStore(preExisting: Record<string, string> = {}) {
  const stored = new Map(Object.entries(preExisting));
  return {
    stored,
    secretSet: vi.fn((key: string, value: string) => {
      stored.set(key, value);
    }),
    secretHas: vi.fn((key: string) => stored.has(key)),
  };
}

function runWith(store: ReturnType<typeof fakeSecretStore>, extra: Record<string, unknown> = {}) {
  return runTauriMigration({
    tauriDir,
    electronDir,
    secretSet: store.secretSet,
    secretHas: store.secretHas,
    machineKey: FIXED_KEY,
    log: quietLog,
    ...extra,
  });
}

/** Recursively list relative file paths under a dir (sorted). */
function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function seedTauriDir() {
  fs.mkdirSync(path.join(tauriDir, 'conversations', 'conv1'), { recursive: true });
  fs.writeFileSync(path.join(tauriDir, 'conversations', 'index.json'), '{"version":1}');
  fs.writeFileSync(path.join(tauriDir, 'conversations', 'conv1', 'messages.jsonl'), '{"role":"user"}\n');
  fs.mkdirSync(path.join(tauriDir, 'sessions', 'conv1', 'results'), { recursive: true });
  fs.writeFileSync(path.join(tauriDir, 'sessions', 'conv1', 'results', 'tc1.txt'), 'result');
  fs.mkdirSync(path.join(tauriDir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(tauriDir, 'backups', 'b1.json'), '{}');
  // Present at the source but deliberately NOT part of the migration set:
  fs.writeFileSync(path.join(tauriDir, 'catalog.sqlite'), 'sqlite');
  fs.mkdirSync(path.join(tauriDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(tauriDir, 'logs', 'app.log'), 'log');
  writeTauriSecretsFile(path.join(tauriDir, 'secrets.bin'), FIXED_KEY, {
    'provider:claude': 'sk-ant-123',
    'aux:webSearch': 'tvly-456',
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-migration-test-'));
  tauriDir = path.join(root, 'com.abu.app');
  electronDir = path.join(root, 'com.abu.app.electron');
  fs.mkdirSync(tauriDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('resolveTauriAppDataDir', () => {
  it('maps packaged → com.abu.app and dev → com.abu.app.dev', () => {
    expect(resolveTauriAppDataDir('/appdata', true)).toBe(path.join('/appdata', 'com.abu.app'));
    expect(resolveTauriAppDataDir('/appdata', false)).toBe(path.join('/appdata', 'com.abu.app.dev'));
  });
});

describe('runTauriMigration', () => {
  it('migrates secrets and copies the data dirs on a fresh run', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    const summary = runWith(store);

    expect('skipped' in summary).toBe(false);
    if ('skipped' in summary) return;
    expect(summary.secrets.migrated.sort()).toEqual(['aux:webSearch', 'provider:claude']);
    expect(store.stored.get('provider:claude')).toBe('sk-ant-123');
    expect(store.stored.get('aux:webSearch')).toBe('tvly-456');
    expect(summary.dirs).toEqual({ conversations: 'copied', sessions: 'copied', backups: 'copied' });

    // Copied file-by-file, and only the whitelisted dirs.
    expect(listFiles(path.join(electronDir, 'conversations'))).toEqual([
      path.join('conv1', 'messages.jsonl'),
      'index.json',
    ]);
    expect(listFiles(path.join(electronDir, 'sessions'))).toEqual([
      path.join('conv1', 'results', 'tc1.txt'),
    ]);
    expect(fs.existsSync(path.join(electronDir, 'catalog.sqlite'))).toBe(false);
    expect(fs.existsSync(path.join(electronDir, 'logs'))).toBe(false);
    expect(fs.existsSync(path.join(electronDir, 'secrets.bin'))).toBe(false);

    // Sentinel written; Tauri source untouched.
    expect(summary.sentinelWritten).toBe(true);
    expect(fs.existsSync(path.join(electronDir, SENTINEL_FILENAME))).toBe(true);
    expect(fs.existsSync(path.join(tauriDir, 'secrets.bin'))).toBe(true);
  });

  it('is idempotent: the second run is a sentinel-gated no-op', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    runWith(store);
    const callsAfterFirst = store.secretSet.mock.calls.length;

    const second = runWith(store);
    expect(second).toEqual({ skipped: 'already-migrated' });
    expect(store.secretSet.mock.calls.length).toBe(callsAfterFirst);
  });

  it('never clobbers existing Electron data (dirs or secret keys)', () => {
    seedTauriDir();
    // Electron side already has its own conversations + one of the two keys.
    fs.mkdirSync(path.join(electronDir, 'conversations'), { recursive: true });
    fs.writeFileSync(path.join(electronDir, 'conversations', 'own.json'), 'electron-data');
    const store = fakeSecretStore({ 'provider:claude': 'already-set' });

    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.dirs.conversations).toBe('skipped-existing');
    expect(summary.dirs.sessions).toBe('copied');
    expect(fs.readFileSync(path.join(electronDir, 'conversations', 'own.json'), 'utf8')).toBe('electron-data');
    expect(fs.existsSync(path.join(electronDir, 'conversations', 'index.json'))).toBe(false);

    expect(summary.secrets.skippedExisting).toEqual(['provider:claude']);
    expect(store.stored.get('provider:claude')).toBe('already-set');
    expect(summary.secrets.migrated).toEqual(['aux:webSearch']);
  });

  it('dryRun computes the full summary with zero writes', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    const summary = runWith(store, { dryRun: true });
    if ('skipped' in summary) throw new Error('unexpected skip');

    expect(summary.dryRun).toBe(true);
    expect(summary.secrets.migrated.sort()).toEqual(['aux:webSearch', 'provider:claude']);
    expect(summary.dirs).toEqual({ conversations: 'copied', sessions: 'copied', backups: 'copied' });
    expect(summary.sentinelWritten).toBe(false);

    expect(store.secretSet).not.toHaveBeenCalled();
    expect(fs.existsSync(electronDir)).toBe(false); // not even the dir, let alone a sentinel
  });

  it('records nothingToMigrate (and still writes the sentinel) when the Tauri dir is absent', () => {
    fs.rmSync(tauriDir, { recursive: true, force: true });
    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');

    expect(summary.nothingToMigrate).toBe(true);
    expect(summary.sentinelWritten).toBe(true);
    expect(fs.existsSync(path.join(electronDir, SENTINEL_FILENAME))).toBe(true);
    expect(store.secretSet).not.toHaveBeenCalled();
  });

  it('a secretSet failure for one key does not abort the others', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    store.secretSet.mockImplementation((key: string, value: string) => {
      if (key === 'provider:claude') throw new Error('safeStorage unavailable');
      store.stored.set(key, value);
    });

    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.setFailed).toEqual(['provider:claude']);
    expect(summary.secrets.migrated).toEqual(['aux:webSearch']);
    expect(store.stored.get('aux:webSearch')).toBe('tvly-456');
  });

  it('an undecryptable entry is reported and the rest still migrate', () => {
    seedTauriDir();
    const entries = encryptTauriEntries(FIXED_KEY, { good: 'v1', bad: 'v2' });
    const tampered = Buffer.from(entries.bad, 'base64');
    tampered[tampered.length - 1] ^= 0x01;
    entries.bad = tampered.toString('base64');
    fs.writeFileSync(path.join(tauriDir, 'secrets.bin'), JSON.stringify({ version: 1, entries }));

    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.decryptFailed).toEqual(['bad']);
    expect(summary.secrets.migrated).toEqual(['good']);
  });

  it('an unreadable secrets file is recorded without blocking the data-dir copy', () => {
    seedTauriDir();
    fs.writeFileSync(path.join(tauriDir, 'secrets.bin'), JSON.stringify({ version: 99, entries: {} }));

    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.readError).toMatch(/unsupported.*version 99/);
    expect(summary.secrets.migrated).toEqual([]);
    expect(summary.dirs.conversations).toBe('copied');
  });

  it('skips secrets with a reason on non-darwin platforms but still copies dirs', () => {
    seedTauriDir();
    const store = fakeSecretStore();
    // process.platform is a plain data property — vi.spyOn(…, 'get') can't
    // intercept it, so swap the value directly and restore in finally.
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const summary = runWith(store);
      if ('skipped' in summary) throw new Error('unexpected skip');
      expect(summary.secrets.skippedReason).toMatch(/keyring/);
      expect(store.secretSet).not.toHaveBeenCalled();
      expect(summary.dirs.conversations).toBe('copied');
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
  });

  it('reports skippedReason when there is no secrets.bin at the source', () => {
    seedTauriDir();
    fs.rmSync(path.join(tauriDir, 'secrets.bin'));
    const store = fakeSecretStore();
    const summary = runWith(store);
    if ('skipped' in summary) throw new Error('unexpected skip');
    expect(summary.secrets.skippedReason).toMatch(/no secrets\.bin/);
    expect(summary.dirs.conversations).toBe('copied');
  });
});
