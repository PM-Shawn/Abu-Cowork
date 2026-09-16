'use strict';

const { decompressSync } = require('fflate');

const MAX_PNG_PIXELS = 50_000_000;
const MAX_PNG_INFLATED_BYTES = 64 * 1024 * 1024;

function ascii(bytes, offset, length) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) return '';
  return bytes.subarray(offset, offset + length).toString('ascii');
}

function readU32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function readU32LE(bytes, offset) {
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

function crc32(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChannels(bitDepth, colorType) {
  const channelsByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const allowedBitDepthsByColorType = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  const channels = channelsByColorType[colorType];
  return channels && allowedBitDepthsByColorType[colorType].includes(bitDepth) ? channels : null;
}

function pngScanlineBytes(width, channels, bitDepth) {
  return Math.ceil((width * channels * bitDepth) / 8);
}

const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function adam7PassSize(width, height, xStart, yStart, xStep, yStep) {
  if (xStart >= width || yStart >= height) return [0, 0];
  return [
    Math.floor((width - xStart + xStep - 1) / xStep),
    Math.floor((height - yStart + yStep - 1) / yStep),
  ];
}

function pngExpectedInflatedBytes(width, height, channels, bitDepth, interlace) {
  if (interlace === 0) return (pngScanlineBytes(width, channels, bitDepth) + 1) * height;
  if (interlace !== 1) return null;
  let total = 0;
  for (const [xStart, yStart, xStep, yStep] of ADAM7_PASSES) {
    const [passWidth, passHeight] = adam7PassSize(width, height, xStart, yStart, xStep, yStep);
    if (passWidth === 0 || passHeight === 0) continue;
    total += (pngScanlineBytes(passWidth, channels, bitDepth) + 1) * passHeight;
  }
  return total > 0 ? total : null;
}

function pngInflatePlanIsWithinLimits(width, height, expectedBytes) {
  return expectedBytes !== null
    && width <= Math.floor(MAX_PNG_PIXELS / height)
    && expectedBytes <= MAX_PNG_INFLATED_BYTES;
}

function pngScanlinesAreValid(bytes, width, height, channels, bitDepth, interlace) {
  if (interlace === 0) {
    const rowSize = pngScanlineBytes(width, channels, bitDepth);
    const expected = (rowSize + 1) * height;
    if (bytes.byteLength !== expected) return false;
    for (let row = 0; row < height; row++) {
      if (bytes[row * (rowSize + 1)] > 4) return false;
    }
    return true;
  }
  if (interlace !== 1) return false;
  let offset = 0;
  for (const [xStart, yStart, xStep, yStep] of ADAM7_PASSES) {
    const [passWidth, passHeight] = adam7PassSize(width, height, xStart, yStart, xStep, yStep);
    if (passWidth === 0 || passHeight === 0) continue;
    const rowSize = pngScanlineBytes(passWidth, channels, bitDepth);
    for (let row = 0; row < passHeight; row++) {
      if (offset + rowSize + 1 > bytes.byteLength || bytes[offset] > 4) return false;
      offset += rowSize + 1;
    }
  }
  return offset === bytes.byteLength;
}

function isCompletePng(bytes) {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let width = 0;
  let height = 0;
  let channels = null;
  let bitDepth = 0;
  let interlace = 0;
  const idatChunks = [];
  while (offset + 12 <= bytes.length) {
    const length = readU32BE(bytes, offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (end > bytes.length || end < offset) return false;
    const storedCrc = readU32BE(bytes, offset + 8 + length);
    if (crc32(bytes, offset + 4, offset + 8 + length) !== storedCrc) return false;
    if (!sawIhdr) {
      if (type !== 'IHDR' || length !== 13) return false;
      sawIhdr = true;
      width = readU32BE(bytes, offset + 8);
      height = readU32BE(bytes, offset + 12);
      bitDepth = bytes[offset + 16];
      channels = pngChannels(bitDepth, bytes[offset + 17]);
      interlace = bytes[offset + 20];
      if (width <= 0 || height <= 0 || channels === null || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || (interlace !== 0 && interlace !== 1)) return false;
    }
    if (type === 'IDAT') {
      sawIdat = true;
      if (length === 0) return false;
      idatChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    if (type === 'IEND') {
      if (!sawIhdr || !sawIdat || length !== 0 || end !== bytes.length || channels === null) return false;
      const expectedBytes = pngExpectedInflatedBytes(width, height, channels, bitDepth, interlace);
      if (!pngInflatePlanIsWithinLimits(width, height, expectedBytes)) return false;
      try {
        // Give fflate a fixed output buffer one byte larger than the PNG's
        // declared scanlines. A malicious DEFLATE stream can otherwise claim a
        // tiny IHDR while expanding far beyond it before the length check runs.
        const inflated = decompressSync(Buffer.concat(idatChunks), {
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

function isSof(marker) {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function isCompleteJpeg(bytes) {
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

function collectGifSubBlocks(bytes, offset) {
  const chunks = [];
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

function skipGifSubBlocks(bytes, offset) {
  return collectGifSubBlocks(bytes, offset)?.nextOffset ?? -1;
}

function gifLzwProducesPixels(minCodeSize, data, expectedPixels) {
  if (expectedPixels <= 0 || data.byteLength <= 0) return false;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let bitOffset = 0;
  let pixels = 0;
  let previous = null;
  const dictionary = new Map();
  const resetDictionary = () => {
    dictionary.clear();
    for (let code = 0; code < clearCode; code++) dictionary.set(code, [code]);
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
    previous = null;
  };
  const readCode = () => {
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
    const entry = dictionary.get(code)
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

function isCompleteGif(bytes) {
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

function looksLikeCompleteWebp(bytes) {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return false;
  if (readU32LE(bytes, 4) !== bytes.length - 8) return false;
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const size = readU32LE(bytes, offset + 4);
    const end = offset + 8 + size;
    if (end > bytes.length || end < offset) return false;
    if (type === 'VP8 ') {
      sawImage = size >= 10
        && bytes[offset + 11] === 0x9d
        && bytes[offset + 12] === 0x01
        && bytes[offset + 13] === 0x2a;
    } else if (type === 'VP8L') {
      if (size <= 6 || bytes[offset + 8] !== 0x2f) return false;
      const bits = readU32LE(bytes, offset + 9);
      const version = bits >>> 29;
      const compressed = bytes.subarray(offset + 13, end);
      sawImage = version === 0 && compressed.length >= 4 && compressed.some((byte) => byte !== 0);
    } else if (type === 'ANMF' && anmfHasImageChunk(bytes, offset + 8, end)) {
      sawImage = true;
    }
    offset = end + (size % 2);
    if (offset > bytes.length) return false;
  }
  return sawImage && offset === bytes.length;
}

function anmfHasImageChunk(bytes, offset, end) {
  let nestedOffset = offset + 16;
  if (nestedOffset > end) return false;
  while (nestedOffset + 8 <= end) {
    const type = ascii(bytes, nestedOffset, 4);
    const size = readU32LE(bytes, nestedOffset + 4);
    const nestedEnd = nestedOffset + 8 + size;
    if (nestedEnd > end || nestedEnd < nestedOffset) return false;
    if (type === 'VP8 ') {
      if (size >= 10
        && bytes[nestedOffset + 11] === 0x9d
        && bytes[nestedOffset + 12] === 0x01
        && bytes[nestedOffset + 13] === 0x2a) {
        return true;
      }
    } else if (type === 'VP8L') {
      if (size > 6 && bytes[nestedOffset + 8] === 0x2f) {
        const bits = readU32LE(bytes, nestedOffset + 9);
        const version = bits >>> 29;
        const compressed = bytes.subarray(nestedOffset + 13, nestedEnd);
        if (version === 0 && compressed.length >= 4 && compressed.some((byte) => byte !== 0)) return true;
      }
    }
    nestedOffset = nestedEnd + (size % 2);
    if (nestedOffset > end) return false;
  }
  return false;
}

function hasPdfSignature(bytes) {
  if (!bytes || bytes.byteLength < 32) return false;
  const header = ascii(bytes, 0, Math.min(bytes.byteLength, 16));
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(header)) return false;
  let end = bytes.byteLength;
  while (end > 0 && [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[end - 1])) end--;
  if (end < 5 || ascii(bytes, end - 5, 5) !== '%%EOF') return false;

  // Stay compatible with classic xref tables, xref streams and compressed
  // page trees: only require one indirect object plus the spec-mandated final
  // startxref marker. Parsing Catalog/Pages here would reject valid modern
  // PDFs; the shared renderer/sidecar gate uses the same shallow signature.
  const headText = ascii(bytes, 0, Math.min(end, 1024 * 1024));
  if (!/\b\d+\s+\d+\s+obj\b/.test(headText)) return false;
  const tailStart = Math.max(0, end - 64 * 1024);
  const tailText = ascii(bytes, tailStart, end - tailStart);
  return /startxref\s+\d+\s+%%EOF$/.test(tailText);
}

function bytesMatchMediaType(bytes, mediaType) {
  if (mediaType === 'image/png') return isCompletePng(bytes);
  if (mediaType === 'image/jpeg') return isCompleteJpeg(bytes);
  if (mediaType === 'image/gif') return isCompleteGif(bytes);
  if (mediaType === 'image/webp') return looksLikeCompleteWebp(bytes);
  if (mediaType === 'application/pdf') return hasPdfSignature(bytes);
  return false;
}

module.exports = {
  bytesMatchMediaType,
  hasPdfSignature,
  isCompleteGif,
  isCompleteJpeg,
  isCompletePng,
  looksLikeCompleteWebp,
};
