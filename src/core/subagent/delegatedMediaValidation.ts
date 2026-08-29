import { decompressSync } from 'fflate';
import { isDelegatedMediaType } from './delegatedUserTurn';

const MAX_PNG_PIXELS = 50_000_000;
const MAX_PNG_INFLATED_BYTES = 64 * 1024 * 1024;
export const MAX_DELEGATED_MEDIA_BYTES = Math.floor(3.75 * 1024 * 1024);

export class DelegatedMediaValidationError extends Error {
  readonly code = 'invalid-media' as const;

  constructor(message = 'Delegated media bytes do not match the declared MIME type.') {
    super(message);
    this.name = 'DelegatedMediaValidationError';
  }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) return '';
  return new TextDecoder().decode(bytes.slice(offset, offset + length));
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + ((bytes[offset + 3] << 24) >>> 0);
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChannels(bitDepth: number, colorType: number): number | null {
  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (!channels) return null;
  const allowedBitDepthsByColorType: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return allowedBitDepthsByColorType[colorType]?.includes(bitDepth) ? channels : null;
}

function pngScanlineBytes(width: number, channels: number, bitDepth: number): number {
  return Math.ceil((width * channels * bitDepth) / 8);
}

function pngExpectedInflatedBytes(width: number, height: number, channels: number, bitDepth: number, interlace: number): number | null {
  if (interlace === 0) return (pngScanlineBytes(width, channels, bitDepth) + 1) * height;
  if (interlace !== 1) return null;
  const adam7Passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const;
  let total = 0;
  for (const [xStart, yStart, xStep, yStep] of adam7Passes) {
    if (xStart >= width || yStart >= height) continue;
    const passWidth = Math.floor((width - xStart + xStep - 1) / xStep);
    const passHeight = Math.floor((height - yStart + yStep - 1) / yStep);
    total += (pngScanlineBytes(passWidth, channels, bitDepth) + 1) * passHeight;
  }
  return total > 0 ? total : null;
}

function pngInflatePlanIsWithinLimits(width: number, height: number, expectedBytes: number | null): expectedBytes is number {
  return expectedBytes !== null
    && width <= Math.floor(MAX_PNG_PIXELS / height)
    && expectedBytes <= MAX_PNG_INFLATED_BYTES;
}

function pngScanlinesAreValid(bytes: Uint8Array, width: number, height: number, channels: number, bitDepth: number, interlace: number): boolean {
  if (interlace === 0) {
    const rowSize = pngScanlineBytes(width, channels, bitDepth);
    const expected = (rowSize + 1) * height;
    if (bytes.byteLength !== expected) return false;
    for (let row = 0; row < height; row++) {
      const filter = bytes[row * (rowSize + 1)];
      if (filter > 4) return false;
    }
    return true;
  }
  if (interlace !== 1) return false;
  const adam7Passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ] as const;
  let offset = 0;
  for (const [xStart, yStart, xStep, yStep] of adam7Passes) {
    if (xStart >= width || yStart >= height) continue;
    const passWidth = Math.floor((width - xStart + xStep - 1) / xStep);
    const passHeight = Math.floor((height - yStart + yStep - 1) / yStep);
    const rowSize = pngScanlineBytes(passWidth, channels, bitDepth);
    for (let row = 0; row < passHeight; row++) {
      if (offset + rowSize + 1 > bytes.byteLength || bytes[offset] > 4) return false;
      offset += rowSize + 1;
    }
  }
  return offset === bytes.byteLength;
}

function isCompletePng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return false;
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let width = 0;
  let height = 0;
  let channels: number | null = null;
  let bitDepth = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = readU32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.byteLength || end < offset) return false;
    const storedCrc = readU32BE(bytes, offset + 8 + length);
    if (crc32(bytes, offset + 4, offset + 8 + length) !== storedCrc) return false;
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) return false;
      sawIhdr = true;
      width = readU32BE(bytes, offset + 8);
      height = readU32BE(bytes, offset + 12);
      bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      const compression = bytes[offset + 18];
      const filter = bytes[offset + 19];
      interlace = bytes[offset + 20];
      channels = pngChannels(bitDepth, colorType);
      if (width <= 0 || height <= 0 || channels === null || compression !== 0 || filter !== 0 || (interlace !== 0 && interlace !== 1)) return false;
    }
    if (type === 'IDAT') {
      sawIdat = true;
      if (length === 0) return false;
      idatChunks.push(bytes.slice(offset + 8, offset + 8 + length));
    }
    if (type === 'IEND') {
      if (!sawIhdr || !sawIdat || length !== 0 || end !== bytes.byteLength || channels === null) return false;
      const expectedBytes = pngExpectedInflatedBytes(width, height, channels, bitDepth, interlace);
      if (!pngInflatePlanIsWithinLimits(width, height, expectedBytes)) return false;
      try {
        const totalIdatBytes = idatChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const idat = new Uint8Array(totalIdatBytes);
        let cursor = 0;
        for (const chunk of idatChunks) {
          idat.set(chunk, cursor);
          cursor += chunk.byteLength;
        }
        // Bound actual allocation as well as the IHDR-derived expectation.
        // fflate truncates to `out`; the extra byte makes over-expansion
        // observable through the exact-length check below.
        const inflated = decompressSync(idat, {
          out: new Uint8Array(expectedBytes + 1),
        });
        return inflated.byteLength === expectedBytes
          && pngScanlinesAreValid(inflated, width, height, channels, bitDepth, interlace);
      } catch {
        return false;
      }
    }
    offset = end;
  }
  return false;
}

function isSof(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function isCompleteJpeg(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawSof = false;
  let sawSos = false;
  let inScan = false;
  let entropyBytes = 0;
  while (offset < bytes.byteLength) {
    if (!inScan) {
      if (bytes[offset++] !== 0xff) return false;
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.byteLength) return false;
      const marker = bytes[offset++];
      if (marker === 0xd9) return sawSof && sawSos && offset === bytes.byteLength;
      if (marker === 0xd8 || marker === 0x00) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.byteLength) return false;
      const length = (bytes[offset] << 8) + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.byteLength) return false;
      if (isSof(marker)) {
        if (length < 8) return false;
        const precision = bytes[offset + 2];
        const height = (bytes[offset + 3] << 8) + bytes[offset + 4];
        const width = (bytes[offset + 5] << 8) + bytes[offset + 6];
        const components = bytes[offset + 7];
        if (precision <= 0 || width <= 0 || height <= 0 || components <= 0 || components > 4 || length !== 8 + 3 * components) return false;
        sawSof = true;
      }
      if (marker === 0xda) {
        if (!sawSof || length < 6) return false;
        const components = bytes[offset + 2];
        if (components <= 0 || components > 4 || length !== 6 + 2 * components) return false;
      }
      offset += length;
      if (marker === 0xda) { sawSos = true; inScan = true; }
    } else {
      if (bytes[offset++] !== 0xff) {
        entropyBytes++;
        continue;
      }
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.byteLength) return false;
      const marker = bytes[offset];
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) { offset++; continue; }
      if (marker === 0xd9) return sawSof && sawSos && entropyBytes > 0 && offset + 1 === bytes.byteLength;
      offset--;
      inScan = false;
    }
  }
  return false;
}

function collectGifSubBlocks(bytes: Uint8Array, offset: number): { data: Uint8Array; nextOffset: number } | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (offset < bytes.byteLength) {
    const size = bytes[offset++];
    if (size === 0) {
      const data = new Uint8Array(total);
      let cursor = 0;
      for (const chunk of chunks) {
        data.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
      return { data, nextOffset: offset };
    }
    if (offset + size > bytes.byteLength) return null;
    chunks.push(bytes.slice(offset, offset + size));
    total += size;
    offset += size;
  }
  return null;
}

function skipGifSubBlocks(bytes: Uint8Array, offset: number): number {
  return collectGifSubBlocks(bytes, offset)?.nextOffset ?? -1;
}

function gifLzwProducesPixels(minCodeSize: number, data: Uint8Array, expectedPixels: number): boolean {
  if (expectedPixels <= 0 || data.byteLength <= 0) return false;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let bitOffset = 0;
  let pixels = 0;
  let previous: number[] | null = null;
  const dictionary = new Map<number, number[]>();
  const resetDictionary = () => {
    dictionary.clear();
    for (let code = 0; code < clearCode; code++) dictionary.set(code, [code]);
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
    previous = null;
  };
  const readCode = (): number | null => {
    if (bitOffset + codeSize > data.byteLength * 8) return null;
    let code = 0;
    for (let bit = 0; bit < codeSize; bit++) {
      const absoluteBit = bitOffset + bit;
      code |= ((data[absoluteBit >> 3] >> (absoluteBit & 7)) & 1) << bit;
    }
    bitOffset += codeSize;
    return code;
  };
  resetDictionary();
  while (true) {
    const code = readCode();
    if (code === null) return false;
    if (code === clearCode) {
      resetDictionary();
      continue;
    }
    if (code === endCode) return pixels >= expectedPixels;
    const entry: number[] | null = dictionary.get(code)
      ?? (code === nextCode && previous ? [...previous, previous[0]] : null);
    if (!entry || entry.length === 0) return false;
    pixels += entry.length;
    if (previous && nextCode < 4096) {
      dictionary.set(nextCode, [...previous, entry[0]]);
      nextCode++;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    previous = entry;
  }
}

function isCompleteGif(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 14 || !['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) return false;
  let offset = 13;
  let sawImage = false;
  if ((bytes[10] & 0x80) !== 0) {
    const size = 3 * (1 << ((bytes[10] & 0x07) + 1));
    if (offset + size > bytes.byteLength) return false;
    offset += size;
  }
  while (offset < bytes.byteLength) {
    const block = bytes[offset++];
    if (block === 0x3b) return sawImage && offset === bytes.byteLength;
    if (block === 0x2c) {
      sawImage = true;
      if (offset + 9 > bytes.byteLength) return false;
      const width = bytes[offset + 4] + (bytes[offset + 5] << 8);
      const height = bytes[offset + 6] + (bytes[offset + 7] << 8);
      if (width <= 0 || height <= 0) return false;
      const packed = bytes[offset + 8];
      offset += 9;
      if ((packed & 0x80) !== 0) {
        const size = 3 * (1 << ((packed & 0x07) + 1));
        if (offset + size > bytes.byteLength) return false;
        offset += size;
      }
      if (offset >= bytes.byteLength) return false;
      const lzwMinCodeSize = bytes[offset++];
      if (lzwMinCodeSize < 2 || lzwMinCodeSize > 8) return false;
      const imageData = collectGifSubBlocks(bytes, offset);
      if (!imageData || !gifLzwProducesPixels(lzwMinCodeSize, imageData.data, width * height)) return false;
      offset = imageData.nextOffset;
    } else if (block === 0x21) {
      if (offset >= bytes.byteLength) return false;
      offset++;
      offset = skipGifSubBlocks(bytes, offset);
    } else return false;
    if (offset < 0) return false;
  }
  return false;
}

function hasValidVp8Chunk(bytes: Uint8Array, offset: number, end: number): boolean {
  if (end - offset < 10) return false;
  const frameTag = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  const keyFrame = (frameTag & 1) === 0;
  const version = (frameTag >> 1) & 0x07;
  const firstPartitionLength = frameTag >> 5;
  if (!keyFrame || version > 3 || firstPartitionLength <= 0 || firstPartitionLength > end - offset - 3) return false;
  return bytes[offset + 3] === 0x9d
    && bytes[offset + 4] === 0x01
    && bytes[offset + 5] === 0x2a
    && ((bytes[offset + 6] | (bytes[offset + 7] << 8)) & 0x3fff) > 0
    && ((bytes[offset + 8] | (bytes[offset + 9] << 8)) & 0x3fff) > 0;
}

function hasValidVp8lChunk(bytes: Uint8Array, offset: number, end: number): boolean {
  if (end - offset <= 6 || bytes[offset] !== 0x2f) return false;
  const bits = readU32LE(bytes, offset + 1);
  const version = bits >>> 29;
  if (version !== 0) return false;
  const compressedStream = bytes.slice(offset + 5, end);
  return compressedStream.byteLength >= 4 && compressedStream.some((byte) => byte !== 0);
}

function isValidWebpImageChunk(bytes: Uint8Array, type: string, offset: number, end: number): boolean {
  if (type === 'VP8 ') return hasValidVp8Chunk(bytes, offset, end);
  if (type === 'VP8L') return hasValidVp8lChunk(bytes, offset, end);
  return false;
}

function anmfHasImageChunk(bytes: Uint8Array, offset: number, end: number): boolean {
  let nestedOffset = offset + 16;
  if (nestedOffset > end) return false;
  while (nestedOffset + 8 <= end) {
    const type = ascii(bytes, nestedOffset, 4);
    const size = readU32LE(bytes, nestedOffset + 4);
    const nestedEnd = nestedOffset + 8 + size;
    if (nestedEnd > end || nestedEnd < nestedOffset) return false;
    if (isValidWebpImageChunk(bytes, type, nestedOffset + 8, nestedEnd)) return true;
    nestedOffset = nestedEnd + (size % 2);
    if (nestedOffset > end) return false;
  }
  return false;
}

function isCompleteWebp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return false;
  if (readU32LE(bytes, 4) !== bytes.byteLength - 8) return false;
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, 4);
    const size = readU32LE(bytes, offset + 4);
    const end = offset + 8 + size;
    if (end > bytes.byteLength || end < offset) return false;
    if (isValidWebpImageChunk(bytes, type, offset + 8, end)) sawImage = true;
    if (type === 'ANMF' && anmfHasImageChunk(bytes, offset + 8, end)) sawImage = true;
    offset = end + (size % 2);
    if (offset > bytes.byteLength) return false;
  }
  return sawImage && offset === bytes.byteLength;
}

function isCompletePdf(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 32) return false;
  const header = ascii(bytes, 0, Math.min(bytes.byteLength, 16));
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(header)) return false;
  let end = bytes.byteLength;
  while (end > 0 && [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[end - 1])) end--;
  if (end < 5 || ascii(bytes, end - 5, 5) !== '%%EOF') return false;

  const headText = ascii(bytes, 0, Math.min(end, 1024 * 1024));
  if (!/\b\d+\s+\d+\s+obj\b/.test(headText)) return false;
  const tailStart = Math.max(0, end - 64 * 1024);
  const tailText = ascii(bytes, tailStart, end - tailStart);
  return /startxref\s+\d+\s+%%EOF$/.test(tailText);
}

export async function hasDelegatedMediaSignature(bytes: Uint8Array, mediaType: string): Promise<boolean> {
  switch (mediaType) {
    case 'image/png': return isCompletePng(bytes);
    case 'image/jpeg': return isCompleteJpeg(bytes);
    case 'image/gif': return isCompleteGif(bytes);
    case 'image/webp': return isCompleteWebp(bytes);
    case 'application/pdf': return isCompletePdf(bytes);
    default: return false;
  }
}

export interface DelegatedMediaValidationInput {
  bytes: Uint8Array;
  mediaType: string;
  width?: number;
  height?: number;
}

export async function validateDelegatedMediaInput(input: DelegatedMediaValidationInput): Promise<void> {
  if (!input || !(input.bytes instanceof Uint8Array) || !isDelegatedMediaType(input.mediaType)) {
    throw new DelegatedMediaValidationError('Delegated media must use supported MIME bytes.');
  }
  if (input.bytes.byteLength > MAX_DELEGATED_MEDIA_BYTES) {
    throw new DelegatedMediaValidationError('Delegated media bytes are too large.');
  }
  if (!(await hasDelegatedMediaSignature(input.bytes, input.mediaType))) {
    throw new DelegatedMediaValidationError();
  }
  for (const dimension of [input.width, input.height]) {
    if (dimension !== undefined && (!Number.isSafeInteger(dimension) || dimension <= 0)) {
      throw new DelegatedMediaValidationError('Delegated media dimensions must be positive integers.');
    }
  }
}
