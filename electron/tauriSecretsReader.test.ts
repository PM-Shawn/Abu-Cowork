/**
 * Unit tests for the pure-Node Tauri secrets.bin reader — mirrors the Rust
 * oracle tests in src-tauri/src/secrets.rs (`mod tests`): same fixed test key
 * ([7u8; 32]), same partial-failure expectations, plus the byte-layout
 * assertions the migration depends on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveTauriKey,
  readTauriSecrets,
  encryptTauriEntries,
  writeTauriSecretsFile,
} from './tauriSecretsReader.cjs';

// Mirrors the Rust test suite's fixed_cipher() key: [7u8; KEY_LEN].
const FIXED_KEY = Buffer.alloc(32, 7);
const WRONG_KEY = Buffer.alloc(32, 9);

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tauri-secrets-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const secretsPath = () => path.join(tmpDir, 'secrets.bin');

describe('tauriSecretsReader', () => {
  describe('deriveTauriKey', () => {
    it('is deterministic and 32 bytes', () => {
      const a = deriveTauriKey('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
      const b = deriveTauriKey('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
      expect(a.length).toBe(32);
      expect(a.equals(b)).toBe(true);
    });

    it('derives different keys for different UUIDs (case-sensitive IKM)', () => {
      const upper = deriveTauriKey('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
      const lower = deriveTauriKey('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const other = deriveTauriKey('11111111-2222-3333-4444-555555555555');
      expect(upper.equals(lower)).toBe(false);
      expect(upper.equals(other)).toBe(false);
    });
  });

  describe('packed entry layout', () => {
    it('packs as nonce(12) || ciphertext || tag(16)', () => {
      const entries = encryptTauriEntries(FIXED_KEY, { k: 'hello' });
      const packed = Buffer.from(entries.k, 'base64');
      expect(packed.length).toBe(12 + 'hello'.length + 16);
    });

    it('generates a fresh nonce per encryption (mirrors nonce_is_unique_per_write)', () => {
      const a = encryptTauriEntries(FIXED_KEY, { k: 'v' });
      const b = encryptTauriEntries(FIXED_KEY, { k: 'v' });
      expect(a.k).not.toBe(b.k);
    });
  });

  describe('readTauriSecrets', () => {
    it('round-trips a multi-entry file (mirrors roundtrip_set_get_delete)', () => {
      writeTauriSecretsFile(secretsPath(), FIXED_KEY, {
        'provider:claude': 'sk-ant-test-123',
        'aux:webSearch': 'tvly-test',
      });
      const result = readTauriSecrets(secretsPath(), FIXED_KEY)!;
      expect(result.failed).toEqual([]);
      expect(result.entries.get('provider:claude')).toBe('sk-ant-test-123');
      expect(result.entries.get('aux:webSearch')).toBe('tvly-test');
      expect(result.entries.size).toBe(2);
    });

    it('round-trips an empty-string secret (28-byte packed minimum)', () => {
      writeTauriSecretsFile(secretsPath(), FIXED_KEY, { empty: '' });
      const result = readTauriSecrets(secretsPath(), FIXED_KEY)!;
      expect(result.failed).toEqual([]);
      expect(result.entries.get('empty')).toBe('');
    });

    it('round-trips non-ASCII UTF-8 plaintext', () => {
      writeTauriSecretsFile(secretsPath(), FIXED_KEY, { k: '密钥-🔑-value' });
      const result = readTauriSecrets(secretsPath(), FIXED_KEY)!;
      expect(result.entries.get('k')).toBe('密钥-🔑-value');
    });

    it('reports a tampered entry as failed without losing the rest (mirrors corrupted_entry_yields_failed_key_not_total_failure)', () => {
      const entries = encryptTauriEntries(FIXED_KEY, { good: 'v1', bad: 'v2' });
      const tampered = Buffer.from(entries.bad, 'base64');
      tampered[tampered.length - 1] ^= 0x01; // flip one bit → GCM tag rejects
      entries.bad = tampered.toString('base64');
      fs.writeFileSync(secretsPath(), JSON.stringify({ version: 1, entries }));

      const result = readTauriSecrets(secretsPath(), FIXED_KEY)!;
      expect(result.entries.get('good')).toBe('v1');
      expect(result.entries.has('bad')).toBe(false);
      expect(result.failed).toEqual(['bad']);
    });

    it('marks every entry failed under the wrong key without throwing (mirrors wrong_key_marks_all_entries_failed)', () => {
      writeTauriSecretsFile(secretsPath(), FIXED_KEY, { a: '1', b: '2' });
      const result = readTauriSecrets(secretsPath(), WRONG_KEY)!;
      expect(result.entries.size).toBe(0);
      expect(result.failed.sort()).toEqual(['a', 'b']);
    });

    it('reports truncated entries as failed', () => {
      const entries = {
        short: Buffer.alloc(27).toString('base64'), // < nonce(12) + tag(16)
        ...encryptTauriEntries(FIXED_KEY, { ok: 'v' }),
      };
      fs.writeFileSync(secretsPath(), JSON.stringify({ version: 1, entries }));
      const result = readTauriSecrets(secretsPath(), FIXED_KEY)!;
      expect(result.failed).toEqual(['short']);
      expect(result.entries.get('ok')).toBe('v');
    });

    it('reports non-string entry values as failed', () => {
      fs.writeFileSync(secretsPath(), JSON.stringify({ version: 1, entries: { n: 42 } }));
      const result = readTauriSecrets(secretsPath(), FIXED_KEY)!;
      expect(result.failed).toEqual(['n']);
    });

    it('throws on an unsupported file version (never guesses at unknown layouts)', () => {
      fs.writeFileSync(secretsPath(), JSON.stringify({ version: 2, entries: {} }));
      expect(() => readTauriSecrets(secretsPath(), FIXED_KEY)).toThrow(/unsupported.*version 2/);
    });

    it('throws on unparseable JSON', () => {
      fs.writeFileSync(secretsPath(), 'not json {{{');
      expect(() => readTauriSecrets(secretsPath(), FIXED_KEY)).toThrow(/unparseable/);
    });

    it('returns null for a missing file (mirrors load_missing_file_yields_empty_store)', () => {
      expect(readTauriSecrets(path.join(tmpDir, 'nope.bin'), FIXED_KEY)).toBeNull();
    });

    it('returns an empty result for an empty file', () => {
      fs.writeFileSync(secretsPath(), '');
      const result = readTauriSecrets(secretsPath(), FIXED_KEY)!;
      expect(result.entries.size).toBe(0);
      expect(result.failed).toEqual([]);
    });
  });
});
