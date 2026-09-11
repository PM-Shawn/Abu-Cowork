import {
  hasElectronDelegatedMediaStore,
  persistElectronDelegatedMedia,
  readElectronDelegatedMedia,
} from '@/utils/electronHost';
import { isMediaRef, type MediaRef } from './delegatedUserTurn';
import { validateDelegatedMediaInput } from './delegatedMediaValidation';

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

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DelegatedMediaStoreError('corrupt-media', 'Delegated media read was aborted.');
  }
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(new DelegatedMediaStoreError('corrupt-media', message));
  }
  void promise.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DelegatedMediaStoreError('corrupt-media', message));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
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
  if (!hasElectronDelegatedMediaStore()) {
    throw new DelegatedMediaStoreError('persist-failed', 'Delegated media store is unavailable in this runtime.');
  }
  return await abortable(
    persistElectronDelegatedMedia({ conversationId, ...input }),
    signal,
    'Delegated media persist was aborted.',
  );
}

export async function readDelegatedMedia(
  conversationId: string,
  ref: MediaRef,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  if (!isMediaRef(ref)) return null;
  throwIfSignalAborted(signal);
  if (!hasElectronDelegatedMediaStore()) return null;
  const bytes = await readElectronDelegatedMedia({ conversationId, ref }, signal);
  throwIfSignalAborted(signal);
  return bytes;
}
