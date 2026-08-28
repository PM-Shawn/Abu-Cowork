/**
 * Sidecar delegated-media store.
 *
 * The renderer implementation reaches Electron through a narrow preload IPC
 * seam. A sidecar-run loop cannot call that browser bridge, so it writes the
 * same opaque, content-addressed refs directly into the app-data directory
 * passed at sidecar spawn. This module intentionally avoids
 * @tauri-apps/plugin-fs; sidecar storage is plain Node fs under
 * ABU_APP_DATA_DIR.
 */

import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { getBootstrap } from '../bootstrap';
import { isMediaRef, isOpaqueMediaId, type MediaRef } from '@/core/subagent/delegatedUserTurn';
import { hasDelegatedMediaSignature, validateDelegatedMediaInput } from '@/core/subagent/delegatedMediaValidation';

export interface DelegatedMediaInput {
  bytes: Uint8Array;
  mediaType: string;
  width?: number;
  height?: number;
}

export class DelegatedMediaStoreError extends Error {
  readonly code: 'invalid-media' | 'corrupt-media' | 'persist-failed';

  constructor(
    code: 'invalid-media' | 'corrupt-media' | 'persist-failed',
    message: string,
  ) {
    super(message);
    this.name = 'DelegatedMediaStoreError';
    this.code = code;
  }
}

function extension(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    default: return 'bin';
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type PathApi = Readonly<{
  resolve: (...paths: string[]) => string;
  sep: string;
}>;

function rootDir(conversationId: string, appDataDir = getBootstrap().appDataDir, pathApi: PathApi = { resolve, sep }): string {
  if (!isOpaqueMediaId(conversationId)) {
    throw new DelegatedMediaStoreError('persist-failed', 'Delegated media conversation id is invalid.');
  }
  return pathApi.resolve(appDataDir, 'conversations', conversationId, 'delegated-media');
}

function pathForRefWithPathApi(appDataDir: string, conversationId: string, ref: MediaRef, pathApi: PathApi = { resolve, sep }): string | null {
  if (!isMediaRef(ref)) return null;
  const root = rootDir(conversationId, appDataDir, pathApi);
  const fullPath = pathApi.resolve(root, `${ref.id}.${extension(ref.mediaType)}`);
  const rootPrefix = root.endsWith(pathApi.sep) ? root : `${root}${pathApi.sep}`;
  return fullPath === root || !fullPath.startsWith(rootPrefix) ? null : fullPath;
}

function pathForRef(conversationId: string, ref: MediaRef): string | null {
  return pathForRefWithPathApi(getBootstrap().appDataDir, conversationId, ref);
}

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DelegatedMediaStoreError('corrupt-media', 'Delegated media read was aborted.');
  }
}

export async function persistDelegatedMedia(
  conversationId: string,
  input: DelegatedMediaInput,
  signal?: AbortSignal,
): Promise<MediaRef> {
  throwIfSignalAborted(signal);
  try {
    await validateDelegatedMediaInput(input);
  } catch (error) {
    const message = error instanceof Error && /too large/i.test(error.message)
      ? error.message
      : 'Delegated media bytes do not match the declared MIME type.';
    throw new DelegatedMediaStoreError('invalid-media', message);
  }
  throwIfSignalAborted(signal);

  const sha256 = sha256Hex(input.bytes);
  const ref: MediaRef = Object.freeze({
    id: `media_${sha256}`,
    sha256,
    mediaType: input.mediaType,
    bytes: input.bytes.byteLength,
    ...(input.width === undefined ? {} : { width: input.width }),
    ...(input.height === undefined ? {} : { height: input.height }),
  });
  const targetPath = pathForRef(conversationId, ref);
  if (!targetPath) {
    throw new DelegatedMediaStoreError('persist-failed', 'Delegated media path is invalid.');
  }

  throwIfSignalAborted(signal);
  await mkdir(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    throwIfSignalAborted(signal);
    await writeFile(tmpPath, input.bytes, { flag: 'wx', mode: 0o600 });
    throwIfSignalAborted(signal);
    try {
      await link(tmpPath, targetPath);
      await rm(tmpPath, { force: true });
    } catch (error: unknown) {
      await rm(tmpPath, { force: true });
      if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EEXIST') {
        const existing = await readDelegatedMedia(conversationId, ref);
        if (existing) return ref;
        throw new DelegatedMediaStoreError('corrupt-media', 'Delegated media snapshot failed integrity verification.');
      }
      throw error;
    }
    return ref;
  } catch (error) {
    if (error instanceof DelegatedMediaStoreError) throw error;
    throw new DelegatedMediaStoreError('persist-failed', 'Could not persist delegated media.');
  }
}

export async function readDelegatedMedia(
  conversationId: string,
  ref: MediaRef,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (!isMediaRef(ref)) return null;
  throwIfSignalAborted(signal);
  const targetPath = pathForRef(conversationId, ref);
  if (!targetPath) return null;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(targetPath, 'r');
    throwIfSignalAborted(signal);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== ref.bytes) return null;
    const bytes = new Uint8Array(ref.bytes);
    let offset = 0;
    while (offset < ref.bytes) {
      const { bytesRead } = await handle.read(bytes, offset, ref.bytes - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
      throwIfSignalAborted(signal);
    }
    if (sha256Hex(bytes) !== ref.sha256) return null;
    if (!(await hasDelegatedMediaSignature(bytes, ref.mediaType))) return null;
    return bytes;
  } catch (error) {
    if (error instanceof DelegatedMediaStoreError) throw error;
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export const __testing = {
  pathForRefWithPathApi,
};
