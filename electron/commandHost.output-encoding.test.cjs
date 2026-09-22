'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  codePageEncodingLabel,
  decodeCommandOutput,
  makeCappedCollector,
} = require('./commandHost.cjs');

// 「错误：系统找不到指定的路径。」as a Chinese Windows console writes it under
// code page 936. None of these bytes form a valid UTF-8 sequence.
const GBK_ERROR_LINE = Buffer.from([
  0xb4, 0xed, 0xce, 0xf3, 0xa3, 0xba, 0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd,
  0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xc2, 0xb7, 0xbe, 0xb6, 0xa1, 0xa3,
]);

test('UTF-8 output is decoded as UTF-8', () => {
  const buf = Buffer.from('错误：系统找不到指定的路径。', 'utf8');

  assert.equal(decodeCommandOutput(buf, 'gbk'), '错误：系统找不到指定的路径。');
});

test('output in the console code page is decoded with that code page', () => {
  assert.equal(decodeCommandOutput(GBK_ERROR_LINE, 'gbk'), '错误：系统找不到指定的路径。');
});

test('output in an unknown code page keeps the previous UTF-8 reading', () => {
  const decoded = decodeCommandOutput(GBK_ERROR_LINE, null);

  assert.ok(decoded.includes('�'), '无法确定代码页时维持原来的 UTF-8 解码');
});

test('a character split across two data events survives', () => {
  const collector = makeCappedCollector();
  const whole = Buffer.from('路径', 'utf8');

  collector.push(whole.subarray(0, 2));
  collector.push(whole.subarray(2));

  assert.equal(collector.value, '路径');
});

test('an empty stream decodes to an empty string', () => {
  assert.equal(makeCappedCollector().value, '');
  assert.equal(decodeCommandOutput(Buffer.alloc(0), 'gbk'), '');
});

test('output past the cap is truncated once and marked', () => {
  const collector = makeCappedCollector();

  collector.push(Buffer.alloc(2_000_000, 0x61));
  collector.push(Buffer.from('dropped', 'utf8'));

  const value = collector.value;
  assert.ok(value.endsWith('\n[truncated: output too large]'));
  assert.ok(!value.includes('dropped'));
  assert.equal(value.length, 2_000_000 + '\n[truncated: output too large]'.length);
});

test('code pages map to the encodings the decoder understands', () => {
  assert.equal(codePageEncodingLabel(936), 'gbk');
  assert.equal(codePageEncodingLabel(932), 'shift_jis');
  assert.equal(codePageEncodingLabel(950), 'big5');
  assert.equal(codePageEncodingLabel(65001), null);
  assert.equal(codePageEncodingLabel(0), null);
});
