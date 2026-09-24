import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStdinLineSplitter } from './stdinLineSplitter';

function collect(): { lines: string[]; splitter: ReturnType<typeof createStdinLineSplitter> } {
  const lines: string[] = [];
  const splitter = createStdinLineSplitter((line) => lines.push(line));
  return { lines, splitter };
}

describe('createStdinLineSplitter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps U+2028 and U+2029 inside the line they belong to', () => {
    const { lines, splitter } = collect();
    const payload = JSON.stringify({ text: 'a b c' });

    splitter.push(Buffer.from(`${payload}\n`, 'utf8'));

    expect(lines).toEqual([payload]);
    expect(JSON.parse(lines[0])).toEqual({ text: 'a b c' });
  });

  it('emits every line of a chunk that carries several', () => {
    const { lines, splitter } = collect();

    splitter.push(Buffer.from('one\ntwo\nthree\n', 'utf8'));

    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('joins one line that arrives across many chunks', () => {
    const { lines, splitter } = collect();

    for (const part of ['{"a":', '1,"b":', '"xyz"}']) splitter.push(Buffer.from(part, 'utf8'));
    expect(lines).toEqual([]);
    splitter.push(Buffer.from('\n', 'utf8'));

    expect(lines).toEqual(['{"a":1,"b":"xyz"}']);
  });

  it('decodes a four-byte character split across a chunk boundary', () => {
    const { lines, splitter } = collect();
    const encoded = Buffer.from('\u{1f600}\n', 'utf8');

    splitter.push(encoded.subarray(0, 2));
    splitter.push(encoded.subarray(2));

    expect(lines).toEqual(['\u{1f600}']);
  });

  it('drops the carriage return of a CRLF line ending', () => {
    const { lines, splitter } = collect();

    splitter.push(Buffer.from('first\r\nsecond\r\n', 'utf8'));

    expect(lines).toEqual(['first', 'second']);
  });

  it('emits empty lines as empty strings', () => {
    const { lines, splitter } = collect();

    splitter.push(Buffer.from('\n\nvalue\n\n', 'utf8'));

    expect(lines).toEqual(['', '', 'value', '']);
  });

  it('emits the last line when the stream ends without a terminator', () => {
    const { lines, splitter } = collect();

    splitter.push(Buffer.from('done\nunterminated', 'utf8'));
    splitter.end();

    expect(lines).toEqual(['done', 'unterminated']);
  });

  it('adds nothing on end when the last byte was a terminator', () => {
    const { lines, splitter } = collect();

    splitter.push(Buffer.from('done\n', 'utf8'));
    splitter.end();

    expect(lines).toEqual(['done']);
  });

  it('concatenates a 32 MiB line once, whatever the chunk size', () => {
    const { lines, splitter } = collect();
    const concatSpy = vi.spyOn(Buffer, 'concat');
    const chunkBytes = 64 * 1024;
    const chunkCount = 512;
    const chunk = Buffer.alloc(chunkBytes, 0x61);

    for (let i = 0; i < chunkCount; i++) splitter.push(chunk);
    splitter.push(Buffer.from('\n', 'utf8'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(chunkBytes * chunkCount);
    expect(concatSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a chunk that is not a Buffer', () => {
    const { splitter } = collect();

    expect(() => (splitter as { push: (chunk: unknown) => void }).push('text')).toThrow(/Buffer/);
  });
});
