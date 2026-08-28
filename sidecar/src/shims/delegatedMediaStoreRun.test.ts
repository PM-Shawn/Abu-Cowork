import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { __resetBootstrapForTests } from '../bootstrap';
import {
  __testing,
  persistDelegatedMedia,
  readDelegatedMedia,
} from './delegatedMediaStoreRun';
import { MAX_DELEGATED_MEDIA_BYTES } from '@/core/subagent/delegatedMediaValidation';

function b64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

const PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
const GIF = b64('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==');
const ANIMATED_WEBP = b64('UklGRjoAAABXRUJQQU5NRi4AAAAAAAAAAAAAAAAAAAAAAAAAVlA4IBYAAADQAQCdASoBAAEAAUAmJaQAA3AA/vuU');
const TRUNCATED_VP8L_HEX = '5249464614000000574542505650384c080000002f00000000010203';

function oversizedGifAtUnifiedLimit(): Uint8Array {
  const trailer = GIF[GIF.byteLength - 1];
  const bytes = Array.from(GIF.slice(0, -1));
  const targetBytes = MAX_DELEGATED_MEDIA_BYTES + 1;
  while (bytes.length + 259 < targetBytes) {
    bytes.push(0x21, 0xfe, 255, ...Array.from({ length: 255 }, () => 0x20), 0x00);
  }
  const finalExtensionBytes = targetBytes - bytes.length - 1;
  const finalPayloadBytes = finalExtensionBytes - 3;
  bytes.push(0x21, 0xfe, finalPayloadBytes, ...Array.from({ length: finalPayloadBytes }, () => 0x20), 0x00, trailer);
  return Uint8Array.from(bytes);
}

function oversizedPdfAtUnifiedLimit(): Uint8Array {
  const bytes = new Uint8Array(MAX_DELEGATED_MEDIA_BYTES + 1).fill(0x20);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n'), 0);
  const tail = new TextEncoder().encode('startxref\n0\n%%EOF');
  bytes.set(tail, bytes.byteLength - tail.byteLength);
  return bytes;
}

describe('sidecar delegated-media store shim', () => {
  let previousAppData: string | undefined;
  let previousResource: string | undefined;
  let appDataDir: string;

  beforeEach(async () => {
    previousAppData = process.env.ABU_APP_DATA_DIR;
    previousResource = process.env.ABU_RESOURCE_DIR;
    appDataDir = await mkdtemp(join(tmpdir(), 'abu-sidecar-delegated-media-'));
    process.env.ABU_APP_DATA_DIR = appDataDir;
    process.env.ABU_RESOURCE_DIR = appDataDir;
    __resetBootstrapForTests();
  });

  afterEach(() => {
    if (previousAppData === undefined) delete process.env.ABU_APP_DATA_DIR;
    else process.env.ABU_APP_DATA_DIR = previousAppData;
    if (previousResource === undefined) delete process.env.ABU_RESOURCE_DIR;
    else process.env.ABU_RESOURCE_DIR = previousResource;
    __resetBootstrapForTests();
  });

  it('roundtrips via the sidecar app-data directory without renderer bridge state', async () => {
    const ref = await persistDelegatedMedia('conv_1', {
      mediaType: 'image/png',
      bytes: PNG,
      width: 1,
      height: 1,
    });

    expect(ref).toMatchObject({
      id: expect.stringMatching(/^media_[a-f0-9]{64}$/),
      mediaType: 'image/png',
      bytes: PNG.byteLength,
      width: 1,
      height: 1,
    });
    expect(JSON.stringify(ref)).not.toContain(appDataDir);
    const target = __testing.pathForRefWithPathApi(appDataDir, 'conv_1', ref);
    expect(target).not.toBeNull();
    await expect(stat(target!)).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await stat(target!)).mode & 0o777).toBe(0o600);
    await expect(readDelegatedMedia('conv_1', ref)).resolves.toEqual(PNG);
  });

  it('matches the shared validator for animated WebP and truncated VP8L', async () => {
    const ref = await persistDelegatedMedia('conv_1', {
      mediaType: 'image/webp',
      bytes: ANIMATED_WEBP,
    });
    await expect(readDelegatedMedia('conv_1', ref)).resolves.toEqual(ANIMATED_WEBP);
    await expect(persistDelegatedMedia('conv_1', {
      mediaType: 'image/webp',
      bytes: Uint8Array.from(Buffer.from(TRUNCATED_VP8L_HEX, 'hex')),
    })).rejects.toMatchObject({ code: 'invalid-media' });
  });

  it('keeps an existing immutable file instead of overwriting it during a duplicate persist', async () => {
    const ref = await persistDelegatedMedia('conv_1', { mediaType: 'image/png', bytes: PNG });
    const windowsTarget = __testing.pathForRefWithPathApi('C:\\AbuData', 'conv_1', ref, win32);
    expect(windowsTarget).toContain('\\conversations\\conv_1\\delegated-media\\');
    const target = __testing.pathForRefWithPathApi(appDataDir, 'conv_1', ref);
    expect(target).not.toBeNull();

    await writeFile(target!, new Uint8Array([1, 2, 3]));

    await expect(persistDelegatedMedia('conv_1', { mediaType: 'image/png', bytes: PNG })).rejects.toMatchObject({
      code: 'corrupt-media',
    });
  });

  it('rejects pre-aborted reads and ignores a late result safely at the caller race layer', async () => {
    const controller = new AbortController();
    controller.abort();
    const ref = await persistDelegatedMedia('conv_1', { mediaType: 'image/png', bytes: PNG });

    await expect(readDelegatedMedia('conv_1', ref, controller.signal)).rejects.toMatchObject({
      code: 'corrupt-media',
    });
  });

  it('caps image and PDF delegated media before sidecar disk persistence', async () => {
    await expect(persistDelegatedMedia('conv_1', {
      mediaType: 'image/gif',
      bytes: oversizedGifAtUnifiedLimit(),
    })).rejects.toMatchObject({ code: 'invalid-media', message: expect.stringMatching(/too large/i) });
    await expect(persistDelegatedMedia('conv_1', {
      mediaType: 'application/pdf',
      bytes: oversizedPdfAtUnifiedLimit(),
    })).rejects.toMatchObject({ code: 'invalid-media', message: expect.stringMatching(/too large/i) });

    await expect(stat(join(appDataDir, 'conversations', 'conv_1', 'delegated-media'))).rejects.toThrow();
  });
});
