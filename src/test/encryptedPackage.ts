import * as XLSX from 'xlsx';

const ENCRYPTION_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption">'
  + '<keyData saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES"'
  + ' cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512" saltValue="AAAAAAAAAAAAAAAAAAAAAA=="/>'
  + '</encryption>';

/**
 * The container Word, Excel and PowerPoint write for a document saved with a password: a
 * compound file with an agile `EncryptionInfo` stream beside an `EncryptedPackage` stream.
 */
export function encryptedPackageBytes(): Uint8Array<ArrayBuffer> {
  const container = XLSX.CFB.utils.cfb_new();
  const xml = new TextEncoder().encode(ENCRYPTION_XML);
  const info = new Uint8Array(8 + xml.length);
  info.set([4, 0, 4, 0, 0x40, 0, 0, 0]);
  info.set(xml, 8);
  XLSX.CFB.utils.cfb_add(container, '/EncryptionInfo', info);
  XLSX.CFB.utils.cfb_add(container, '/EncryptedPackage', new Uint8Array(4096).fill(7));
  return new Uint8Array(XLSX.CFB.write(container, { type: 'array' }) as Uint8Array);
}
