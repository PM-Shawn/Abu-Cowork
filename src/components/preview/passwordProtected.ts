/** Why a preview shows a sentence in place of the file. */
export type PreviewFailure = 'unreadable' | 'password';

/** The parts of the compound-file reader bundled with SheetJS that the check uses. */
interface CompoundFileReader {
  read(data: Uint8Array, options: { type: 'array' }): unknown;
  find(container: unknown, path: string): unknown;
}

const COMPOUND_FILE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Whether the bytes are an Office document saved with a password. Word, Excel and PowerPoint
 * wrap such a document in a compound file that holds an `EncryptedPackage` stream
 * ([MS-OFFCRYPTO] 2.3.4.4). Rejects for a compound file that cannot be read.
 */
export async function isPasswordProtectedOfficeFile(data: Uint8Array): Promise<boolean> {
  if (!COMPOUND_FILE_SIGNATURE.every((byte, index) => data[index] === byte)) return false;
  const { CFB } = await import('xlsx');
  const reader = CFB as CompoundFileReader;
  return reader.find(reader.read(data, { type: 'array' }), '/EncryptedPackage') !== null;
}

/** Whether pdf.js failed to open a document because it was given no password for it. */
export function isPdfPasswordError(error: Error): boolean {
  return error.name === 'PasswordException';
}
