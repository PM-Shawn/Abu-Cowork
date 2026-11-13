import { describe, it, expect } from 'vitest';
import type { Message } from '../../types';
import { formatNote, judgeImage, notPictureNote, oversizeNote, oversizeBytesNote } from './imageAcceptance';
import { normalizeMessages, type PreparedToolCall } from './messageNormalizer';

const NOT_BASE64 = 'data that is not valid Base64';
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

function png(w: number, h: number): string {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b64(b);
}

/** A JPEG header with a JFIF segment, then the frame header holding the size. */
function jpeg(w: number, h: number): string {
  const b = new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0, 0, 0, 0, 0, 0,
  ]);
  return b64(b);
}

function bmp(w: number, h: number): string {
  const b = new Uint8Array(32);
  b.set([0x42, 0x4d]);
  new DataView(b.buffer).setInt32(18, w, true);
  new DataView(b.buffer).setInt32(22, h, true);
  return b64(b);
}

describe('judgeImage', () => {
  it('sends a picture the route takes, under its own type', () => {
    expect(judgeImage('image/png', png(1600, 667), 2000)).toEqual({ kind: 'send', mediaType: 'image/png' });
    expect(judgeImage('image/jpeg', jpeg(2000, 1500), 2000)).toEqual({ kind: 'send', mediaType: 'image/jpeg' });
  });

  it('leaves out a picture larger than the route takes on either side, saying its size and the limit', () => {
    expect(judgeImage('image/png', png(10032, 4178), 4096))
      .toEqual({ kind: 'leave-out', note: oversizeNote(10032, 4178, 4096), size: { w: 10032, h: 4178 } });
    expect(judgeImage('image/jpeg', jpeg(1000, 9000), 2000))
      .toEqual({ kind: 'leave-out', note: oversizeNote(1000, 9000, 2000), size: { w: 1000, h: 9000 } });
    expect(oversizeNote(10032, 4178, 4096)).toContain('10032×4178 px');
    expect(oversizeNote(10032, 4178, 4096)).toContain('at most 4096 px');
  });

  it('judges the bytes, not the label: a JPEG labelled PNG goes as JPEG, a BMP labelled PNG stays out', () => {
    expect(judgeImage('image/png', jpeg(800, 600), 2000)).toEqual({ kind: 'send', mediaType: 'image/jpeg' });
    expect(judgeImage('image/png', bmp(800, 600), 2000)).toEqual({ kind: 'leave-out', note: formatNote('image/bmp'), format: 'BMP' });
    expect(formatNote('image/bmp')).toMatch(/^\[A picture in BMP format was left out/);
  });

  it('leaves out a format no route takes when the bytes cannot say otherwise', () => {
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(judgeImage('image/svg+xml', svg, 2000)).toEqual({ kind: 'leave-out', note: formatNote('image/svg+xml'), format: 'SVG' });
    expect(formatNote('image/svg+xml')).toContain('in SVG format');
    expect(judgeImage('image/tiff', 'AAAA', 2000).kind).toBe('leave-out');
  });

  it('keeps data in no format it knows that could still be a picture when its label is one every route takes: the provider decides', () => {
    // Binary bytes in no known format (an unknown or damaged picture).
    expect(judgeImage('image/png', b64(Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00])), 2000))
      .toEqual({ kind: 'send', mediaType: 'image/png' });
    expect(judgeImage('image/jpg', b64(Uint8Array.from([0x01, 0x02, 0x03, 0xfe, 0x9a, 0x00])), 2000)).toEqual({ kind: 'send', mediaType: 'image/jpeg' });
    // A PNG cut off before its size: sent as it is.
    expect(judgeImage('image/png', png(5000, 5000).slice(0, 20), 2000)).toEqual({ kind: 'send', mediaType: 'image/png' });
    // A few bytes say nothing about being text.
    expect(judgeImage('image/png', 'AQID', 2000)).toEqual({ kind: 'send', mediaType: 'image/png' });
    expect(judgeImage('image/jpeg', btoa('P17'), 2000)).toEqual({ kind: 'send', mediaType: 'image/jpeg' });
  });

  it('leaves out data that is not valid Base64, whatever its label says: it cannot be a picture the provider accepts', () => {
    const note = notPictureNote(NOT_BASE64);
    for (const data of ['!!!invalid!!!', 'BASE64PNG', 'not base64 at all!']) {
      expect(judgeImage('image/png', data, 3000, 5 * 1024 * 1024)).toEqual({ kind: 'leave-out', note, notPicture: NOT_BASE64 });
      expect(judgeImage('image/jpg', data, 2000)).toEqual({ kind: 'leave-out', note, notPicture: NOT_BASE64 });
    }
  });

  const text = (value: string) => b64(new TextEncoder().encode(value));

  it.each([
    ['the PDF a page was rendered from', 'image/jpeg', text('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj'), 'a PDF document'],
    ['a Word file', 'image/png', b64(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00, 0x00, 0x00, 0x21, 0x00])), 'a ZIP archive, such as a Word, Excel or PowerPoint file'],
    ['an old Excel file', 'image/png', b64(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])), 'an old-format Office document'],
    ['an HTML error page', 'image/png', text('<!DOCTYPE html><html><head><title>404'), 'text'],
    ['a JSON error', 'image/webp', text('{"error":"not found","code":404}'), 'text'],
    ['Chinese text', 'image/jpeg', text('图片加载失败，请稍后重试。'), 'text'],
    ['SVG markup', 'image/png', text('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'text'],
    ['no data', 'image/png', '', 'no data'],
  ])('leaves out %s under a picture label, with a note saying what it is', (_name, label, data, what) => {
    expect(judgeImage(label, data, 2000)).toEqual({ kind: 'leave-out', note: notPictureNote(what), notPicture: what });
  });

  it('says what a left-out non-picture was and how to look at it', () => {
    expect(notPictureNote('a PDF document')).toBe(
      '[A picture was left out of this request: what it holds is not a picture (a PDF document). '
        + 'If it came from a file, read that file to see what it holds.]',
    );
  });

  it('leaves out a picture in a format no route takes whatever its label says', () => {
    const tiff = b64(Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x10, 0x00]));
    const tiffBigEndian = b64(Uint8Array.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]));
    const iso = (brand: string) => b64(Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]));
    expect(judgeImage('image/jpeg', tiff, 2000)).toEqual({ kind: 'leave-out', note: formatNote('image/tiff'), format: 'TIFF' });
    expect(judgeImage('image/png', tiffBigEndian, 2000)).toMatchObject({ kind: 'leave-out', format: 'TIFF' });
    expect(judgeImage('image/jpeg', iso('heic'), 2000)).toEqual({ kind: 'leave-out', note: formatNote('image/heic'), format: 'HEIC' });
    expect(judgeImage('image/jpeg', iso('mif1'), 2000)).toMatchObject({ kind: 'leave-out', format: 'HEIF' });
    expect(judgeImage('image/png', iso('avif'), 2000)).toMatchObject({ kind: 'leave-out', format: 'AVIF' });
    // An MP4 is an ISO box file too, but no picture: it is judged by its label.
    expect(judgeImage('image/png', iso('isom'), 2000)).toEqual({ kind: 'send', mediaType: 'image/png' });
  });

  it('still sends a real picture whose label is wrong, and still judges a text label by the label', () => {
    expect(judgeImage('image/webp', png(800, 600), 2000)).toEqual({ kind: 'send', mediaType: 'image/png' });
    const svg = text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect(judgeImage('image/svg+xml', svg, 2000)).toMatchObject({ kind: 'leave-out', format: 'SVG' });
  });
});

describe('normalizeMessages with a route limit', () => {
  const TS = 1;
  const tool = (data: string, mediaType = 'image/png') => ({
    id: 't1', name: 'mcp__shot__capture', input: {},
    result: 'Captured.',
    resultContent: [
      { type: 'text' as const, text: 'Captured.' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: mediaType, data } },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: png(640, 480) } },
    ],
  });
  const withTool = (data: string, mediaType?: string): Message[] => [
    { id: 'u', role: 'user', content: 'go', timestamp: TS },
    { id: 'a', role: 'assistant', content: '', timestamp: TS, toolCallsForContext: [tool(data, mediaType)] } as Message,
  ];
  const callOf = (messages: Message[], max?: number): PreparedToolCall => {
    const turns = normalizeMessages(messages, { supportsVision: true, ...(max === undefined ? {} : { maxImageDimension: max }) });
    const assistant = turns.find((t) => t.kind === 'assistant');
    if (assistant?.kind !== 'assistant') throw new Error('no assistant turn');
    return assistant.toolCalls[0];
  };

  it('leaves out the oversized tool picture with its note in the result, from any tool, and keeps the rest', () => {
    const call = callOf(withTool(png(10032, 4178)), 4096);
    expect(call.resultImages.map((i) => i.data)).toEqual([png(640, 480)]);
    expect(call.result).toBe(`Captured.\n\n${oversizeNote(10032, 4178, 4096)}`);
  });

  it('leaves out PDF bytes refilled into a page render, keeping the other pictures of the call', () => {
    const pdf = b64(new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>'));
    const call = callOf(withTool(pdf, 'image/jpeg'), 2000);
    expect(call.resultImages.map((i) => i.data)).toEqual([png(640, 480)]);
    expect(call.result).toBe(`Captured.\n\n${notPictureNote('a PDF document')}`);
  });

  it('replaces a user attachment that holds no picture with its note', () => {
    const messages: Message[] = [{
      id: 'u', role: 'user', timestamp: TS,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: btoa('<html><body>expired</body></html>') } },
        { type: 'text', text: '这张图是什么' },
      ],
    } as Message];
    const [turn] = normalizeMessages(messages, { supportsVision: true, maxImageDimension: 2000 });
    expect(turn.kind === 'user' && turn.content).toEqual([
      { type: 'text', text: notPictureNote('text') },
      { type: 'text', text: '这张图是什么' },
    ]);
  });

  it('leaves out a history tool picture whose data is not Base64, with the note in the result, keeping the other pictures', () => {
    const call = callOf(withTool('!!!invalid!!!'), 3000);
    expect(call.resultImages.map((i) => i.data)).toEqual([png(640, 480)]);
    expect(call.result).toBe(`Captured.\n\n${notPictureNote(NOT_BASE64)}`);
  });

  it('replaces a user attachment whose data is not Base64 with its note', () => {
    const messages: Message[] = [{
      id: 'u', role: 'user', timestamp: TS,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '!!!invalid!!!' } },
        { type: 'text', text: 'what is this' },
      ],
    } as Message];
    const [turn] = normalizeMessages(messages, { supportsVision: true, maxImageDimension: 3000, maxImageBytes: 5 * 1024 * 1024 });
    expect(turn.kind === 'user' && turn.content).toEqual([
      { type: 'text', text: notPictureNote(NOT_BASE64) },
      { type: 'text', text: 'what is this' },
    ]);
  });

  it('sends a relabelled picture under the type of its bytes', () => {
    const call = callOf(withTool(jpeg(800, 600), 'image/png'), 2000);
    expect(call.resultImages[0]).toMatchObject({ mediaType: 'image/jpeg', data: jpeg(800, 600) });
    expect(call.result).toBe('Captured.');
  });

  it('changes nothing without a route limit, or for a model that cannot see', () => {
    expect(callOf(withTool(png(10032, 4178))).resultImages).toHaveLength(2);
    const turns = normalizeMessages(withTool(png(10032, 4178)), { supportsVision: false, maxImageDimension: 2000 });
    const assistant = turns.find((t) => t.kind === 'assistant');
    expect(assistant?.kind === 'assistant' && assistant.toolCalls[0].result).not.toContain('was left out');
  });

  it('replaces an oversized attachment in a user message with its note, keeping the text', () => {
    const messages: Message[] = [{
      id: 'u', role: 'user', timestamp: TS,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png(9000, 3000) }, filePath: '/d/大图.png' },
        { type: 'text', text: '看看这张图' },
      ],
    } as Message];
    const [turn] = normalizeMessages(messages, { supportsVision: true, maxImageDimension: 2000 });
    expect(turn.kind === 'user' && turn.content).toEqual([
      { type: 'text', text: oversizeNote(9000, 3000, 2000) },
      { type: 'text', text: '看看这张图' },
    ]);
  });

  it('builds the same request from the same history (prompt cache)', () => {
    const messages = withTool(png(10032, 4178));
    expect(normalizeMessages(messages, { supportsVision: true, maxImageDimension: 2000 }))
      .toEqual(normalizeMessages(messages, { supportsVision: true, maxImageDimension: 2000 }));
  });
});

describe('judgeImage per-image byte ceiling', () => {
  const big = (chars: number) => png(800, 600) + 'A'.repeat(chars);

  it('leaves out a picture whose base64 is over the ceiling, with a note that gives its size', () => {
    const data = big(6000);
    const verdict = judgeImage('image/png', data, 8000, 5000);
    expect(verdict).toMatchObject({ kind: 'leave-out', bytes: data.length });
    expect(verdict.kind === 'leave-out' && verdict.note).toBe(oversizeBytesNote(data.length, 5000));
  });

  it('sends one at or under the ceiling, and any size when no ceiling is given', () => {
    expect(judgeImage('image/png', big(100), 8000, 5000)).toEqual({ kind: 'send', mediaType: 'image/png' });
    expect(judgeImage('image/png', big(100000), 8000)).toEqual({ kind: 'send', mediaType: 'image/png' });
  });

  it('is applied by the normalizer to tool and user pictures', () => {
    const data = big(6000);
    const messages: Message[] = [{
      id: 'u', role: 'user', timestamp: 1,
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: 'see' }],
    } as Message];
    const [turn] = normalizeMessages(messages, { supportsVision: true, maxImageDimension: 8000, maxImageBytes: 5000 });
    expect(turn.kind === 'user' && turn.content[0]).toEqual({ type: 'text', text: oversizeBytesNote(data.length, 5000) });
  });
});
