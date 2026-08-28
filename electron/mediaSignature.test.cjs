'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function b64(value) {
  return Buffer.from(value, 'base64');
}

const HUGE_EXPECTED_PNG = b64('iVBORw0KGgoAAAANSUhEUgABhqAAAYagCAYAAACoUgvIAAAACUlEQVR4nGMAAAABAAFe/335AAAAAElFTkSuQmCC');
const VALID_ONE_PIXEL_PNG = b64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=');
const TRUNCATED_VP8L_HEX = '5249464614000000574542505650384c080000002f00000000010203';
const ANIMATED_WEBP = b64('UklGRjoAAABXRUJQQU5NRi4AAAAAAAAAAAAAAAAAAAAAAAAAVlA4IBYAAADQAQCdASoBAAEAAUAmJaQAA3AA/vuU');

test('rejects huge-dimension PNG before invoking zlib decompression', () => {
  const fflatePath = require.resolve('fflate');
  const mediaSignaturePath = require.resolve('./mediaSignature.cjs');
  const originalFflate = require(fflatePath);
  let decompressCalls = 0;
  delete require.cache[mediaSignaturePath];
  require.cache[fflatePath].exports = {
    ...originalFflate,
    decompressSync: () => {
      decompressCalls += 1;
      return new Uint8Array([0]);
    },
  };
  try {
    const { bytesMatchMediaType } = require('./mediaSignature.cjs');
    assert.equal(bytesMatchMediaType(HUGE_EXPECTED_PNG, 'image/png'), false);
    assert.equal(decompressCalls, 0);
  } finally {
    delete require.cache[mediaSignaturePath];
    require.cache[fflatePath].exports = originalFflate;
  }
});

test('bounds zlib output to one byte beyond the PNG-declared scanline size', () => {
  const fflatePath = require.resolve('fflate');
  const mediaSignaturePath = require.resolve('./mediaSignature.cjs');
  const originalFflate = require(fflatePath);
  let outputLimit = null;
  delete require.cache[mediaSignaturePath];
  require.cache[fflatePath].exports = {
    ...originalFflate,
    decompressSync: (_bytes, options) => {
      outputLimit = options?.out?.byteLength ?? null;
      return new Uint8Array(3);
    },
  };
  try {
    const { bytesMatchMediaType } = require('./mediaSignature.cjs');
    assert.equal(bytesMatchMediaType(VALID_ONE_PIXEL_PNG, 'image/png'), true);
    assert.equal(outputLimit, 4);
  } finally {
    delete require.cache[mediaSignaturePath];
    require.cache[fflatePath].exports = originalFflate;
  }
});

test('rejects the reviewer exact truncated VP8L WebP sample', () => {
  const { bytesMatchMediaType } = require('./mediaSignature.cjs');
  assert.equal(bytesMatchMediaType(Buffer.from(TRUNCATED_VP8L_HEX, 'hex'), 'image/webp'), false);
});

test('accepts legal animated WebP consistently with the shared validator boundary', () => {
  const { bytesMatchMediaType } = require('./mediaSignature.cjs');
  assert.equal(bytesMatchMediaType(ANIMATED_WEBP, 'image/webp'), true);
});
