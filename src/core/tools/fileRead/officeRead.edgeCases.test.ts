import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { readFile as fsReadFile } from '@tauri-apps/plugin-fs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import type { ToolExecutionContext, ToolResultContent } from '@/types';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { readOfficeManifest } from './officeManifest';
import { readOffice } from './officeRead';
import type { DocumentReadParams } from './readParams';

// Edge cases of read_file's Office reading: files that hold something else, pictures outside the body, the text budget.

/** UTF-8 bytes of the JSON form of a value: how conversation history measures a tool result. */
const jsonUtf8ByteLength = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

const params = (fields: Partial<DocumentReadParams> = {}): DocumentReadParams =>
  ({ pages: null, region: null, rotate: 0, imageIndex: null, ...fields });
const textOf = (result: string | ToolResultContent[]): string =>
  typeof result === 'string' ? result : (result[0] as { text: string }).text;

function contextFor(bytes: Uint8Array, fields: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const files = {
    readFile: vi.fn().mockResolvedValue(bytes),
    stat: vi.fn().mockResolvedValue({ size: bytes.length, isFile: true, isDirectory: false }),
    runProcessor: vi.fn(),
  } as unknown as ToolFileAccess;
  return { files, ...fields };
}

async function readAt(path: string, bytes: Uint8Array, fields: Partial<DocumentReadParams> = {}, context: Partial<ToolExecutionContext> = {}) {
  const ctx = contextFor(bytes, context);
  const outcome = await readOffice(path, params(fields), ctx);
  if (outcome.kind !== 'done') throw new Error(`unexpected ${outcome.kind}`);
  return { text: textOf(outcome.result), ctx };
}

const png = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};
const rels = (entries: Array<[string, string, string]>) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;

describe('files named .xlsx / .docx / .pptx that hold something else (by bytes)', () => {
  const table = '姓名,金额\n张三,100\n李四,"1,200"\n';
  const gbk = (text: string): Uint8Array => {
    // GBK bytes for the few characters used here.
    const map: Record<string, number[]> = { 姓: [0xd0, 0xd5], 名: [0xc3, 0xfb], 金: [0xbd, 0xf0], 额: [0xb6, 0xee], 张: [0xd5, 0xc5], 三: [0xc8, 0xfd] };
    return new Uint8Array([...text].flatMap((c) => map[c] ?? [c.charCodeAt(0)]));
  };

  it('reads an HTML table in GBK that declares its charset, without mangling the Chinese', async () => {
    const html = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=gbk"></head><body><table><tr><td>姓名</td><td>金额</td></tr><tr><td>张三</td><td>100</td></tr></table></body></html>';
    const { text } = await readAt('/d/导出.xlsx', gbk(html));
    expect(text).toContain('this file holds an HTML page, read as a spreadsheet');
    expect(text).toContain('姓名\t金额\n张三\t100');
  });

  it('reads a UTF-16 CSV with a byte-order mark, and a UTF-8 CSV with one', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...table].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]);
    expect((await readAt('/d/a.xlsx', utf16)).text).toContain('李四\t1200');
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(table)]);
    const { text } = await readAt('/d/b.xlsx', bom);
    expect(text).toContain('姓名\t金额');
    expect(text).not.toContain('\ufeff');
  });

  it('reads an Excel 2003 XML workbook and a multi-sheet old workbook with Chinese sheet names', async () => {
    const xml = '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="汇总"><Table><Row><Cell><Data ss:Type="String">项目</Data></Cell><Cell><Data ss:Type="Number">42</Data></Cell></Row></Table></Worksheet></Workbook>';
    const first = (await readAt('/d/a.xlsx', strToU8(xml))).text;
    expect(first).toContain('Excel 2003 XML workbook');
    expect(first).toContain('=== Sheet: 汇总 ===\n项目\t42');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['甲', 1]]), '一月');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['乙', 2]]), '二月');
    const biff = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'biff8' }) as ArrayBuffer);
    const second = (await readAt('/d/b.xlsx', biff)).text;
    expect(second).toMatch(/^\[Excel workbook: 2 sheets\]/);
    expect(second).toContain('=== Sheet: 一月 ===\n甲\t1');
    expect(second).toContain('=== Sheet: 二月 ===\n乙\t2');
  });

  it.each([
    ['PNG bytes named .xlsx', '/d/a.xlsx', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 1, 2, 0xff])],
    ['PDF bytes named .docx', '/d/a.docx', strToU8('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj\n<< >>\nendobj\n\u0000\u0000')],
    ['a plain zip named .docx', '/d/a.docx', zipSync({ 'a.txt': strToU8('hello') })],
    ['a plain zip named .xlsx', '/d/a.xlsx', zipSync({ 'a.txt': strToU8('hello') })],
    ['a plain zip named .pptx', '/d/a.pptx', zipSync({ 'a.txt': strToU8('hello') })],
  ])('says %s is not an Office document, without throwing and without running Python', async (_label, path, bytes) => {
    const { text, ctx } = await readAt(path, bytes);
    expect(text).toMatch(/^Error: /);
    expect(text).not.toMatch(/Excel workbook: \d+ sheet/);
    expect(ctx.files!.runProcessor).not.toHaveBeenCalled();
  });

  it('says a real workbook cut in half is damaged, and an empty file is empty', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(Array.from({ length: 2000 }, (_, i) => [`row ${i}`, i, 'x'.repeat(40)])), 'S');
    const whole = new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
    const { text } = await readAt('/d/cut.xlsx', whole.subarray(0, Math.floor(whole.length / 2)));
    expect(text).toMatch(/^Error: The file could not be opened as an Office document/);
    expect((await readAt('/d/zero.xlsx', new Uint8Array(0))).text).toContain('the file is empty');
  });

  it('a Word 97 file (OLE, not encrypted) named .xlsx does not claim to be an empty workbook', async () => {
    const cfb = XLSX.CFB.utils.cfb_new();
    XLSX.CFB.utils.cfb_add(cfb, '/WordDocument', new Uint8Array(512));
    const bytes = new Uint8Array(XLSX.CFB.write(cfb, { type: 'array' }) as ArrayLike<number>);
    const { text } = await readAt('/d/oops.xlsx', bytes);
    expect(text).not.toMatch(/Excel workbook: 0 sheets?|Sheets: \./);
  });
});

describe('a plain Office read in the sidecar starts nothing', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it.each([
    ['report.docx', zipSync({
      'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>你好</w:t></w:r></w:p></w:body></w:document>'),
    })],
    ['deck.pptx', zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'),
      'ppt/_rels/presentation.xml.rels': strToU8(rels([['rId2', 'slide', 'slides/slide1.xml']])),
      'ppt/slides/slide1.xml': strToU8('<p:sld><p:sp><p:txBody><a:p><a:r><a:t>标题</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'),
    })],
    ['book.xlsx', new Uint8Array(XLSX.write((() => { const b = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(b, XLSX.utils.aoa_to_sheet([['a', 1]]), 'S'); return b; })(), { type: 'array', bookType: 'xlsx' }) as ArrayBuffer)],
  ])('%s: no command at all, no file processor, and the bytes come from the plain file read', async (name, bytes) => {
    vi.mocked(fsReadFile).mockResolvedValueOnce(bytes);
    const outcome = await readOffice(`/Users/me/${name}`, params(), {});
    expect(outcome.kind).toBe('done');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('pictures: the body, headers, masters and videos', () => {
  const view = (w: number, h: number) => ({ size: [w, h], region: [0, 0, 1, 1], rotate: 0, rulers: [[0, 1], [0, 1]], img: { data: 'JPEG', w: 1400, h: 700 } });

  function docxWithHeaderFooter(): Uint8Array {
    return zipSync({
      'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Body</w:t></w:r><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:body></w:document>'),
      'word/_rels/document.xml.rels': strToU8(rels([['rId1', 'image', 'media/body.png'], ['rId7', 'header', 'header1.xml'], ['rId8', 'footer', 'footer1.xml']])),
      'word/header1.xml': strToU8('<w:hdr><w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:hdr>'),
      'word/_rels/header1.xml.rels': strToU8(rels([['rId1', 'image', 'media/head.png']])),
      'word/footer1.xml': strToU8('<w:ftr><w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:ftr>'),
      'word/_rels/footer1.xml.rels': strToU8(rels([['rId1', 'image', 'media/foot.png']])),
      'word/media/body.png': png(640, 480),
      'word/media/head.png': png(100, 20),
      'word/media/foot.png': png(100, 20),
    });
  }

  it('attaches only the body picture of a document that also has a header and a footer logo, and lists the others apart', async () => {
    const ctx = contextFor(docxWithHeaderFooter());
    vi.mocked(ctx.files!.runProcessor).mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true, views: [view(640, 480)] }), stderr: '' });
    const outcome = await readOffice('/d/a.docx', params(), ctx);
    if (outcome.kind !== 'done') throw new Error('x');
    const options = JSON.parse(vi.mocked(ctx.files!.runProcessor).mock.calls[0][2][3] as string);
    expect(options.parts).toEqual(['word/media/body.png']);
    const text = textOf(outcome.result);
    expect(text).toMatch(/Pictures: \[Image 1\] PNG 640×480/);
    expect(text).toMatch(/Pictures outside the text \(headers, footers, layouts and masters, or not used\): \[Image 2\] PNG 100×20[^;]*, (page )?(header|footer)/);
    expect(text).toContain('Attached below, in this order: Image 1. The other pictures are not attached.');
  });

  it('a slide with a picture, a layout logo and a video: attaches the slide picture only, and image_index on the video says it is a video', async () => {
    const bytes = zipSync({
      'ppt/presentation.xml': strToU8('<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'),
      'ppt/_rels/presentation.xml.rels': strToU8(rels([['rId2', 'slide', 'slides/slide1.xml']])),
      'ppt/slides/slide1.xml': strToU8('<p:sld><p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic><p:pic><p:nvPicPr><p:nvPr><a:videoFile r:link="rId3"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId4"/></p:blipFill></p:pic></p:sld>'),
      'ppt/slides/_rels/slide1.xml.rels': strToU8(rels([['rId1', 'image', '../media/pic.png'], ['rId3', 'video', '../media/clip.mp4'], ['rId4', 'image', '../media/poster.png'], ['rId9', 'slideLayout', '../slideLayouts/slideLayout1.xml']])),
      'ppt/slideLayouts/slideLayout1.xml': strToU8('<p:sldLayout/>'),
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(rels([['rId1', 'image', '../media/logo.png']])),
      'ppt/slideMasters/slideMaster1.xml': strToU8('<p:sldMaster/>'),
      'ppt/media/pic.png': png(800, 600),
      'ppt/media/poster.png': png(320, 180),
      'ppt/media/logo.png': png(50, 50),
      'ppt/media/clip.mp4': new Uint8Array(2048),
    });
    const manifest = readOfficeManifest(unzipSync(bytes))!;
    const video = manifest.pictures.find((p) => p.part.endsWith('clip.mp4'));
    expect(video?.media).toBe('video');
    const ctx = contextFor(bytes);
    vi.mocked(ctx.files!.runProcessor).mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true, views: [view(800, 600), view(320, 180)] }), stderr: '' });
    const outcome = await readOffice('/d/a.pptx', params(), ctx);
    if (outcome.kind !== 'done') throw new Error('x');
    const parts = JSON.parse(vi.mocked(ctx.files!.runProcessor).mock.calls[0][2][3] as string).parts as string[];
    expect(parts).not.toContain('ppt/media/clip.mp4');
    expect(parts).not.toContain('ppt/media/logo.png');
    expect(parts).toContain('ppt/media/pic.png');
    expect(textOf(outcome.result)).toMatch(/Videos and sounds, listed only: .*MP4 video/);
    const shown = await readOffice('/d/a.pptx', params({ imageIndex: video!.index }), contextFor(bytes));
    expect(shown).toEqual({ kind: 'done', result: expect.stringMatching(/^Error: Image \d+ is a video \(MP4\), which cannot be shown/) });
  });
});

describe('the text budget against what history keeps', () => {
  const docxOf = (text: string) => zipSync({
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map((line) => `<w:p><w:r><w:t xml:space="preserve">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`),
  });

  it('cuts 150,000 Chinese characters under 200 KB of UTF-8, marked, and the result stays under the 256 KB history keeps', async () => {
    const { text } = await readAt('/d/长.docx', docxOf('合'.repeat(150_000)));
    expect(text).toContain('[... the text is cut here');
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(256 * 1024);
    expect(jsonUtf8ByteLength(text)).toBeLessThanOrEqual(256 * 1024);
  });

  // The budget must count what conversation history counts, not raw UTF-8 bytes (READ_TEXT_BYTE_BUDGET = 200,000):
  // history measures the JSON form of the result (durableToolResultContent.ts boundResult),
  // where every quote, backslash, tab and newline takes two bytes. Text that is full of quotes (JSON or
  // code pasted into a document, a CSV with quoted fields) reaches the cut at 200,000 raw bytes and is
  // then 300 KB or more as JSON, so it is cut again after the conversation is reopened, with the omission
  // note and without the read's own "how to read on" note.
  it('keeps quote-heavy text under the history budget as JSON, not only as raw bytes', async () => {
    const line = '{"id":"a","name":"b","ok":true}';
    const { text } = await readAt('/d/data.docx', docxOf(Array.from({ length: 12_000 }, () => line).join('\n')));
    expect(jsonUtf8ByteLength(text)).toBeLessThanOrEqual(256 * 1024);
  });
});

describe('the renderer cannot start: what the user\'s folders look like in the answer', () => {
  const bytes = zipSync({
    'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:body></w:document>'),
    'word/_rels/document.xml.rels': strToU8(rels([['rId1', 'image', 'media/a.png']])),
    'word/media/a.png': png(10, 10),
  });

  it.each([
    ['a missing library with a path', new Error("ModuleNotFoundError: No module named 'PIL' (sys.path: /home/lisi/.local/lib/python3.12)")],
  ])('%s', async (_label, error) => {
    vi.mocked(invoke).mockReset();
    vi.mocked(fsReadFile).mockResolvedValueOnce(bytes);
    vi.mocked(invoke).mockRejectedValueOnce(error);
    const outcome = await readOffice('/Users/zhang san/报告.docx', params(), {});
    const text = outcome.kind === 'done' ? textOf(outcome.result) : '';
    expect(text).toContain('could not be attached');
    for (const secret of ['zhang', 'san', '张', 'lisi']) expect(text, secret).not.toContain(secret);
  });
});
