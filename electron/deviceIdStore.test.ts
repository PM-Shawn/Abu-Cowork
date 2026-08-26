// @vitest-environment node

/**
 * Unit tests for the file-backed analytics device_id.
 *
 * Everything runs against temp dirs in plain Node — no Electron. The preload
 * wiring (electron/preload.cjs) and the real relaunch behavior are covered by
 * tests/e2e/device-id.spec.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEVICE_ID_FILENAME,
  RECORD_VERSION,
  MAX_DEVICE_ID_CHARS,
  isValidDeviceId,
  generateDeviceId,
  deviceIdFilePath,
  readDeviceIdFile,
  writeDeviceIdFile,
  resolveDeviceId,
} from './deviceIdStore.cjs';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-device-id-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function readRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(deviceIdFilePath(dir), 'utf8'));
}

describe('deviceIdStore', () => {
  describe('isValidDeviceId', () => {
    it('accepts the uuid shape both generators produce', () => {
      expect(isValidDeviceId(generateDeviceId())).toBe(true);
      // The renderer's own generateId() output (src/utils/deviceId.ts).
      expect(isValidDeviceId('0a10c361-8387-48eb-8c8c-3b1f328f2bdd')).toBe(true);
    });

    it('stays lenient about legacy shapes so no existing id is ever discarded', () => {
      // The whole migration path hinges on this: a stricter validator would
      // reject a legitimate stored id, mint a replacement, and reset the user
      // to "new" — the exact artifact this module exists to prevent.
      expect(isValidDeviceId('legacy-id-123')).toBe(true);
      expect(isValidDeviceId('x')).toBe(true);
      expect(isValidDeviceId('a'.repeat(MAX_DEVICE_ID_CHARS))).toBe(true);
    });

    it('rejects non-strings, empties, oversize values and control characters', () => {
      expect(isValidDeviceId('')).toBe(false);
      expect(isValidDeviceId(null)).toBe(false);
      expect(isValidDeviceId(undefined)).toBe(false);
      expect(isValidDeviceId(42)).toBe(false);
      expect(isValidDeviceId({ id: 'x' })).toBe(false);
      expect(isValidDeviceId('a'.repeat(MAX_DEVICE_ID_CHARS + 1))).toBe(false);
      expect(isValidDeviceId(`a${String.fromCharCode(0)}b`)).toBe(false);
      expect(isValidDeviceId(`a${String.fromCharCode(10)}b`)).toBe(false);
      expect(isValidDeviceId(`a${String.fromCharCode(0x7f)}b`)).toBe(false);
    });
  });

  describe('generateDeviceId', () => {
    it('mints distinct uuid-v4 values', () => {
      const a = generateDeviceId();
      const b = generateDeviceId();
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('resolveDeviceId', () => {
    it('mints and persists on a genuinely first launch', () => {
      const result = resolveDeviceId({ dir });
      expect(result.source).toBe('generated');
      expect(result.persisted).toBe(true);
      expect(isValidDeviceId(result.id)).toBe(true);
      expect(readRaw()).toMatchObject({
        version: RECORD_VERSION,
        deviceId: result.id,
        source: 'generated',
      });
    });

    it('creates the app data dir when it does not exist yet', () => {
      const nested = path.join(dir, 'not', 'created', 'yet');
      const result = resolveDeviceId({ dir: nested });
      expect(result.persisted).toBe(true);
      expect(fs.existsSync(path.join(nested, DEVICE_ID_FILENAME))).toBe(true);
    });

    it('returns the same id across repeated resolves — the core guarantee', () => {
      const first = resolveDeviceId({ dir });
      const second = resolveDeviceId({ dir });
      expect(second.id).toBe(first.id);
      expect(second.source).toBe('file');
    });

    it('survives a wiped localStorage (the reinstall / clear-cache case)', () => {
      const first = resolveDeviceId({ dir, localStorageId: 'seeded-value' });
      // Renderer storage gone: nothing at all comes back from localStorage.
      const afterWipe = resolveDeviceId({ dir, localStorageId: null });
      expect(afterWipe.id).toBe(first.id);
      expect(afterWipe.source).toBe('file');
    });

    it('MIGRATION: adopts an existing localStorage id instead of minting', () => {
      // The upgrade path for every current user. A new id here would show up
      // in the console as the entire install base churning at once.
      const existing = '11111111-2222-4333-8444-555555555555';
      const result = resolveDeviceId({ dir, localStorageId: existing });
      expect(result.id).toBe(existing);
      expect(result.source).toBe('local-storage');
      expect(result.persisted).toBe(true);
      expect(readRaw()).toMatchObject({ deviceId: existing, source: 'local-storage' });
      // And it stays put on the next launch.
      expect(resolveDeviceId({ dir, localStorageId: existing }).id).toBe(existing);
    });

    it('lets the file win when the two disagree, so the caller can write back', () => {
      const fileId = resolveDeviceId({ dir }).id;
      const result = resolveDeviceId({ dir, localStorageId: 'a-different-id' });
      expect(result.id).toBe(fileId);
      expect(result.source).toBe('file');
    });

    it('ignores an invalid localStorage value and mints instead', () => {
      const result = resolveDeviceId({ dir, localStorageId: '' });
      expect(result.source).toBe('generated');
      expect(isValidDeviceId(result.id)).toBe(true);
    });

    it('falls back to the localStorage id when the file is corrupt', () => {
      fs.writeFileSync(deviceIdFilePath(dir), '{ not json', 'utf8');
      const result = resolveDeviceId({ dir, localStorageId: 'still-mine' });
      expect(result.id).toBe('still-mine');
      expect(result.source).toBe('local-storage');
      expect(readRaw().deviceId).toBe('still-mine');
    });

    it('rejects a record written by a future/foreign schema version', () => {
      fs.writeFileSync(
        deviceIdFilePath(dir),
        JSON.stringify({ version: RECORD_VERSION + 1, deviceId: 'from-the-future' }),
        'utf8'
      );
      expect(readDeviceIdFile(dir)).toBeNull();
      expect(resolveDeviceId({ dir, localStorageId: 'mine' }).id).toBe('mine');
    });

    it('rejects a record whose stored id fails validation', () => {
      fs.writeFileSync(
        deviceIdFilePath(dir),
        JSON.stringify({ version: RECORD_VERSION, deviceId: '' }),
        'utf8'
      );
      expect(readDeviceIdFile(dir)).toBeNull();
    });

    it('degrades to localStorage without throwing when the dir is unwritable', () => {
      // A file where the directory should be makes both mkdir and write fail.
      const blocked = path.join(dir, 'blocked');
      fs.writeFileSync(blocked, 'not a directory', 'utf8');
      const result = resolveDeviceId({ dir: blocked, localStorageId: 'keep-me' });
      expect(result.id).toBe('keep-me');
      expect(result.persisted).toBe(false);
    });

    it('still returns a usable id when there is nothing to fall back to', () => {
      const blocked = path.join(dir, 'blocked');
      fs.writeFileSync(blocked, 'not a directory', 'utf8');
      const result = resolveDeviceId({ dir: blocked });
      expect(isValidDeviceId(result.id)).toBe(true);
      expect(result.persisted).toBe(false);
    });
  });

  describe('writeDeviceIdFile', () => {
    it('leaves no staging file behind on success', () => {
      expect(writeDeviceIdFile(dir, 'abc', 'generated')).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([DEVICE_ID_FILENAME]);
    });

    it('overwrites an existing record in place', () => {
      writeDeviceIdFile(dir, 'first', 'generated');
      writeDeviceIdFile(dir, 'second', 'local-storage');
      expect(readDeviceIdFile(dir)).toBe('second');
      expect(fs.readdirSync(dir)).toEqual([DEVICE_ID_FILENAME]);
    });

    it('reports failure rather than throwing', () => {
      const blocked = path.join(dir, 'blocked');
      fs.writeFileSync(blocked, 'not a directory', 'utf8');
      expect(writeDeviceIdFile(blocked, 'abc', 'generated')).toBe(false);
    });
  });
});
