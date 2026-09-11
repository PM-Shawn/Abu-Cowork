import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronHost = vi.hoisted(() => ({
  hasElectronDelegatedMediaStore: vi.fn(),
  persistElectronDelegatedMedia: vi.fn(),
  readElectronDelegatedMedia: vi.fn(),
}));

vi.mock('@/utils/electronHost', () => electronHost);

import { persistDelegatedMedia, readDelegatedMedia } from './delegatedMediaStore';

function b64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

const VALID_PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
const VALID_REF = Object.freeze({
  id: 'media_431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
  sha256: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460',
  mediaType: 'image/png',
  bytes: VALID_PNG.byteLength,
});

describe('delegated media renderer store boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed outside the Electron delegated-media bridge', async () => {
    electronHost.hasElectronDelegatedMediaStore.mockReturnValue(false);

    await expect(persistDelegatedMedia('conv-1', {
      mediaType: 'image/png',
      bytes: VALID_PNG,
    })).rejects.toMatchObject({ code: 'persist-failed' });
    await expect(readDelegatedMedia('conv-1', VALID_REF)).resolves.toBeNull();

    expect(electronHost.persistElectronDelegatedMedia).not.toHaveBeenCalled();
    expect(electronHost.readElectronDelegatedMedia).not.toHaveBeenCalled();
  });

  it('persists through the Electron bridge only after validating bytes and metadata', async () => {
    electronHost.hasElectronDelegatedMediaStore.mockReturnValue(true);
    electronHost.persistElectronDelegatedMedia.mockResolvedValue(VALID_REF);

    await expect(persistDelegatedMedia('conv-1', {
      mediaType: 'image/png',
      bytes: VALID_PNG,
      width: 1,
      height: 1,
    })).resolves.toEqual(VALID_REF);

    expect(electronHost.persistElectronDelegatedMedia).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      mediaType: 'image/png',
      bytes: VALID_PNG,
      width: 1,
      height: 1,
    });
  });

  it('rejects invalid media before reaching the bridge', async () => {
    electronHost.hasElectronDelegatedMediaStore.mockReturnValue(true);

    await expect(persistDelegatedMedia('conv-1', {
      mediaType: 'image/png',
      bytes: b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNlAAAADAAGjm0zfwAAAABJRU5ErkJggg=='),
    })).rejects.toMatchObject({ code: 'invalid-media' });

    expect(electronHost.persistElectronDelegatedMedia).not.toHaveBeenCalled();
  });

  it('rejects an unsupported BMP MIME before reaching the Electron bridge', async () => {
    electronHost.hasElectronDelegatedMediaStore.mockReturnValue(true);

    await expect(persistDelegatedMedia('conv-1', {
      mediaType: 'image/bmp',
      bytes: VALID_PNG,
    })).rejects.toMatchObject({ code: 'invalid-media' });

    expect(electronHost.persistElectronDelegatedMedia).not.toHaveBeenCalled();
  });

  it('passes abortable reads through the Electron bridge', async () => {
    const signal = new AbortController().signal;
    electronHost.hasElectronDelegatedMediaStore.mockReturnValue(true);
    electronHost.readElectronDelegatedMedia.mockResolvedValue(VALID_PNG);

    await expect(readDelegatedMedia('conv-1', VALID_REF, signal)).resolves.toEqual(VALID_PNG);

    expect(electronHost.readElectronDelegatedMedia).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      ref: VALID_REF,
    }, signal);
  });
});
