import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { encryptedPackageBytes } from '@/test/encryptedPackage';
import { isPasswordProtectedOfficeFile } from './passwordProtected';

function workbookBytes(bookType: XLSX.BookType): Uint8Array<ArrayBuffer> {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Name'], ['Ada']]), 'Sheet1');
  return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType }) as ArrayBuffer);
}

describe('isPasswordProtectedOfficeFile', () => {
  it('knows the container of a document saved with a password, which the workbook reader refuses', async () => {
    const bytes = encryptedPackageBytes();
    expect(await isPasswordProtectedOfficeFile(bytes)).toBe(true);
    expect(() => XLSX.read(bytes, { type: 'array' })).toThrow();
  });

  it('reads a view into a larger buffer as the bytes of the view', async () => {
    const bytes = encryptedPackageBytes();
    const padded = new Uint8Array(bytes.length + 6);
    padded.set(bytes, 3);
    expect(await isPasswordProtectedOfficeFile(new Uint8Array(padded.buffer, 3, bytes.length))).toBe(true);
  });

  it('leaves a zip-based workbook alone', async () => {
    expect(await isPasswordProtectedOfficeFile(workbookBytes('xlsx'))).toBe(false);
  });

  it('leaves a compound file with no encrypted package alone', async () => {
    expect(await isPasswordProtectedOfficeFile(workbookBytes('xls'))).toBe(false);
  });

  it('leaves text and empty bytes alone', async () => {
    expect(await isPasswordProtectedOfficeFile(new TextEncoder().encode('Name,City\nAda,London\n'))).toBe(false);
    expect(await isPasswordProtectedOfficeFile(new Uint8Array())).toBe(false);
  });

  it('rejects for a compound file that is cut short, so the caller reports it as unreadable', async () => {
    const cut = encryptedPackageBytes().slice(0, 100);
    await expect(isPasswordProtectedOfficeFile(cut)).rejects.toThrow();
  });
});
