import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { strToU8, unzipSync, zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import type { ToolExecutionContext, ToolResultContent } from '@/types';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { pictureSize, readOfficeManifest } from './officeManifest';
import { readOffice } from './officeRead';
import type { DocumentReadParams } from './readParams';

// ── Fixtures: small Office files built in memory ─────────────────────────────

/** A PNG header that declares its size; enough for the manifest, not for a renderer. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

/** A JPEG start with an APP0 segment and a baseline frame header. */
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 0, 0, 0]);
}

const rels = (entries: Array<[string, string, string]>) =>
  `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;

const chartXml = (title: string, cached: boolean) => `<c:chartSpace><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title>
<c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>
<c:ser><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>
<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f>${cached ? '<c:strCache><c:pt idx="0"><c:v>North</c:v></c:pt><c:pt idx="1"><c:v>South</c:v></c:pt></c:strCache>' : ''}</c:strRef></c:cat>
<c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f>${cached ? '<c:numCache><c:pt idx="0"><c:v>12.5</c:v></c:pt><c:pt idx="1"><c:v>7</c:v></c:pt></c:numCache>' : ''}</c:numRef></c:val></c:ser>
</c:barChart></c:plotArea></c:chart></c:chartSpace>`;

function docx(pictures: 'many' | 'two'): Uint8Array {
  const body = pictures === 'many'
    ? `<w:body><w:p><w:r><w:t>Intro &amp; summary</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Figure: </w:t></w:r><w:r><w:drawing><a:blip r:embed="rId1"><a:extLst><a:ext><asvg:svgBlip r:embed="rId4"/></a:ext></a:extLst></a:blip></w:drawing></w:r></w:p>
<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><a:blip r:embed="rId2"/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:imagedata r:id="rId2"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
<w:p><w:r><w:t>Tab</w:t><w:tab/><w:t>bed</w:t><w:br/><w:t>next line</w:t></w:r></w:p>
<w:p><w:r><w:drawing><c:chart r:id="rId3"/></w:drawing></w:r></w:p>
<w:p><w:r><w:pict><v:imagedata r:id="rId5"/></w:pict></w:r></w:p></w:body>`
    : '<w:body><w:p><w:r><w:t>Two pictures</w:t></w:r><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r><w:r><w:drawing><a:blip r:embed="rId2"/></w:drawing></w:r></w:p></w:body>';
  const entries: Record<string, Uint8Array> = {
    'word/document.xml': strToU8(`<w:document>${body}</w:document>`),
    'word/_rels/document.xml.rels': strToU8(rels([
      ['rId1', 'image', 'media/image1.png'], ['rId2', 'image', 'media/image2.jpeg'], ['rId3', 'chart', 'charts/chart1.xml'],
      ['rId4', 'image', 'media/image3.svg'], ['rId5', 'image', 'media/image5.emf'], ['rId9', 'hyperlink', 'https://example.com" TargetMode="External'],
    ])),
    'word/header1.xml': strToU8('<w:hdr><w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p></w:hdr>'),
    'word/_rels/header1.xml.rels': strToU8(rels([['rId1', 'image', 'media/logo.png']])),
    'word/media/image1.png': png(970, 788),
    'word/media/image2.jpeg': jpeg(1431, 205),
    'word/media/image3.svg': strToU8('<svg/>'),
    'word/media/image5.emf': new Uint8Array(100),
    'word/media/logo.png': png(120, 40),
    'word/media/orphan.png': png(10, 10),
    'word/charts/chart1.xml': strToU8(chartXml('Sales', true)),
    'word/embeddings/Microsoft_Excel_Worksheet.xlsx': new Uint8Array(10),
  };
  if (pictures === 'two') {
    for (const part of ['word/media/image3.svg', 'word/media/image5.emf', 'word/media/logo.png', 'word/media/orphan.png', 'word/header1.xml', 'word/_rels/header1.xml.rels']) {
      delete entries[part];
    }
  }
  return zipSync(entries);
}

function xlsx(rows: number): Uint8Array {
  const workbook = XLSX.utils.book_new();
  const data: unknown[][] = [['Region', 'Revenue', '', '']];
  for (let i = 0; i < rows; i++) data.push([`R${i}`, i, '', '']);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), 'Data');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['x']]), 'Old');
  const entries = unzipSync(new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
  const decoder = new TextDecoder();
  const book = decoder.decode(entries['xl/workbook.xml']).replace('name="Old" sheetId="2"', 'name="Old" sheetId="2" state="hidden"');
  return zipSync({
    ...entries,
    'xl/workbook.xml': strToU8(book),
    'xl/worksheets/_rels/sheet1.xml.rels': strToU8(rels([['rIdD', 'drawing', '../drawings/drawing1.xml']])),
    'xl/drawings/drawing1.xml': strToU8(`<xdr:wsDr>
<xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>3</xdr:row></xdr:from><xdr:pic><xdr:blipFill><a:blip r:embed="rIdP"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor>
<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:row>1</xdr:row></xdr:from><xdr:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rIdC"/></a:graphicData></a:graphic></xdr:graphicFrame></xdr:twoCellAnchor>
</xdr:wsDr>`),
    'xl/drawings/_rels/drawing1.xml.rels': strToU8(rels([['rIdP', 'image', '../media/image1.png'], ['rIdC', 'chart', '../charts/chart1.xml']])),
    'xl/media/image1.png': png(590, 200),
    'xl/charts/chart1.xml': strToU8(chartXml('Revenue by region', true)),
  });
}

function pptx(): Uint8Array {
  return zipSync({
    'ppt/presentation.xml': strToU8('<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>'),
    'ppt/_rels/presentation.xml.rels': strToU8(rels([['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml']])),
    'ppt/slides/slide1.xml': strToU8('<p:sld><p:sp><p:txBody><a:p><a:r><a:t>Quarterly review</a:t></a:r></a:p><a:p><a:r><a:t>Line one</a:t></a:r><a:br><a:rPr/></a:br><a:r><a:t>line two</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic></p:sld>'),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(rels([['rId1', 'image', '../media/image1.png'], ['rId9', 'slideLayout', '../slideLayouts/slideLayout1.xml']])),
    'ppt/slides/slide2.xml': strToU8('<p:sld><p:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame><p:sp><p:txBody><a:p><a:r><a:t>Chart slide</a:t></a:r></a:p></p:txBody></p:sp></p:sld>'),
    'ppt/slides/_rels/slide2.xml.rels': strToU8(rels([['rId2', 'chart', '../charts/chart1.xml']])),
    'ppt/slideLayouts/slideLayout1.xml': strToU8('<p:sldLayout/>'),
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': strToU8(rels([['rId1', 'image', '../media/image2.png']])),
    'ppt/media/image1.png': png(800, 600),
    'ppt/media/image2.png': png(100, 30),
    'ppt/charts/chart1.xml': strToU8(chartXml('Mix', true)),
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function contextFor(bytes: Uint8Array, fields: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  const files = {
    readFile: vi.fn().mockResolvedValue(bytes),
    stat: vi.fn().mockResolvedValue({ size: bytes.length, isFile: true, isDirectory: false }),
    runProcessor: vi.fn(),
  } as unknown as ToolFileAccess;
  return { files, ...fields };
}

const params = (fields: Partial<DocumentReadParams> = {}): DocumentReadParams =>
  ({ pages: null, region: null, rotate: 0, imageIndex: null, ...fields });

const textOf = (result: string | ToolResultContent[]): string =>
  typeof result === 'string' ? result : (result[0] as { text: string }).text;

async function read(bytes: Uint8Array, fields: Partial<DocumentReadParams> = {}, context: Partial<ToolExecutionContext> = {}) {
  const ctx = contextFor(bytes, context);
  const outcome = await readOffice('/d/file', params(fields), ctx);
  if (outcome.kind !== 'done') throw new Error(`unexpected ${outcome.kind}`);
  return { result: outcome.result, runProcessor: vi.mocked(ctx.files!.runProcessor) };
}

const view = (w: number, h: number) => ({ size: [w, h], region: [0, 0, 1, 1], rotate: 0, rulers: [[0, 1], [0, 1]], img: { data: 'JPEG', w: 1400, h: 700 } });
const probeAnswer = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

// ── Tests ───────────────────────────────────────────────────────────────────

describe('pictureSize', () => {
  it('reads PNG and JPEG headers', () => {
    expect(pictureSize(png(970, 788))).toEqual({ width: 970, height: 788 });
    expect(pictureSize(jpeg(1431, 205))).toEqual({ width: 1431, height: 205 });
    expect(pictureSize(new Uint8Array(40))).toBeNull();
  });
});

describe('readOfficeManifest', () => {
  it('numbers a Word document\'s pictures in reading order, once each, then those used elsewhere', () => {
    const manifest = readOfficeManifest(unzipSync(docx('many')))!;
    expect(manifest.kind).toBe('docx');
    expect(manifest.pictures.map((p) => [p.index, p.part, p.where, p.renderable])).toEqual([
      [1, 'word/media/image1.png', ['in the text'], true],
      [2, 'word/media/image2.jpeg', ['in the text'], true],
      [3, 'word/media/image5.emf', ['in the text'], false],
      [4, 'word/media/logo.png', ['page header'], true],
      [5, 'word/media/orphan.png', ['not used in the document'], true],
    ]);
    expect(manifest.text).toBe('Intro & summary\nFigure: [Image 1]\n[Image 2]\nTab\tbed\nnext line\n[Chart 1]\n[Image 3]');
    expect(manifest.charts).toEqual([expect.objectContaining({ index: 1, type: 'barChart (vertical, clustered)', title: 'Sales', where: 'in the text' })]);
    expect(manifest.embeddedObjects).toEqual(['Microsoft_Excel_Worksheet.xlsx']);
  });

  it('reads the anchors of a workbook\'s pictures and charts', () => {
    const manifest = readOfficeManifest(unzipSync(xlsx(3)))!;
    expect(manifest.sheets).toEqual([
      { name: 'Data', hidden: false, chartsheet: false },
      { name: 'Old', hidden: true, chartsheet: false },
    ]);
    expect(manifest.pictures.map((p) => [p.index, p.where])).toEqual([[1, ["sheet 'Data' at B4"]]]);
    expect(manifest.charts[0]).toMatchObject({
      where: "sheet 'Data' at E2", title: 'Revenue by region',
      series: [{ name: 'Revenue', categories: 'Sheet1!$A$2:$A$3', values: 'Sheet1!$B$2:$B$3', cachedValues: ['12.5', '7'] }],
    });
  });

  it('reads slides in presentation order with their text, pictures and charts', () => {
    const manifest = readOfficeManifest(unzipSync(pptx()))!;
    expect(manifest.slides).toEqual([
      { lines: ['Quarterly review', 'Line one\nline two'], pictures: [1], charts: [] },
      { lines: ['Chart slide'], pictures: [], charts: [1] },
    ]);
    expect(manifest.pictures.map((p) => [p.index, p.where])).toEqual([[1, ['slide 1']], [2, ['slide layout']]]);
  });
});

describe('readOffice', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('lists a Word document\'s pictures, those outside its text apart, and attaches the two its text places', async () => {
    const ctx = contextFor(docx('many'));
    vi.mocked(ctx.files!.runProcessor).mockResolvedValue(probeAnswer({ ok: true, views: [view(970, 788), view(1431, 205)] }));
    const outcome = await readOffice('/d/report.docx', params(), ctx);
    if (outcome.kind !== 'done' || typeof outcome.result === 'string') throw new Error('expected pictures');
    const text = textOf(outcome.result);
    expect(text).toMatch(/^\[Word document\. \[Image N\] and \[Chart N\] in the text mark where each picture and chart sits\.\]/);
    expect(text).toContain('Pictures: [Image 1] PNG 970×788 (1 KB); [Image 2] JPEG 1431×205 (1 KB); [Image 3] EMF (1 KB) (EMF vector picture, cannot be shown).');
    expect(text).toContain('Pictures outside the text (headers, footers, layouts and masters, or not used): [Image 4] PNG 120×40 (1 KB), page header; [Image 5] PNG 10×10 (1 KB), not used in the document.');
    // The page header's logo is not attached: the text holds two pictures that can be drawn.
    expect(JSON.parse(vi.mocked(ctx.files!.runProcessor).mock.calls[0][2][3] as string).parts).toEqual(['word/media/image1.png', 'word/media/image2.jpeg']);
    expect(text).toContain('Attached below, in this order: Image 1, Image 2. The other pictures are not attached. Rulers');
    expect(text).not.toContain('..');
    expect(text).toContain('Chart 1: barChart (vertical, clustered) "Sales", in the text; series "Revenue": categories Sheet1!$A$2:$A$3, values Sheet1!$B$2:$B$3, cached categories [North, South], cached values [12.5, 7].');
    expect(text).toContain('Embedded objects, not read: Microsoft_Excel_Worksheet.xlsx.');
    expect(text).toContain('\n\nIntro & summary\nFigure: [Image 1]');
  });

  it('attaches none when the text holds more than two pictures, and says how to look at one', async () => {
    const entries = unzipSync(docx('many'));
    entries['word/document.xml'] = strToU8(new TextDecoder().decode(entries['word/document.xml']).replace('</w:body>', '<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p></w:body>'));
    entries['word/_rels/document.xml.rels'] = strToU8(new TextDecoder().decode(entries['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/logo.png"/></Relationships>'));
    const { result, runProcessor } = await read(zipSync(entries));
    const text = textOf(result);
    expect(text).toContain('Pictures: [Image 1] PNG 970×788 (1 KB); [Image 2] JPEG 1431×205 (1 KB); [Image 3] EMF (1 KB) (EMF vector picture, cannot be shown); [Image 4] PNG 120×40 (1 KB).');
    expect(text).toContain('Not attached (more than 2 pictures). To look at one, call read_file with image_index=N; add region=');
    expect(text).toMatch(/call with rotate alone first\.$/m);
    expect(runProcessor).not.toHaveBeenCalled();
  });

  it('does not attach a picture that only a header or a slide layout holds', async () => {
    const entries = unzipSync(docx('many'));
    entries['word/document.xml'] = strToU8('<w:document><w:body><w:p><w:r><w:t>Text only</w:t></w:r></w:p></w:body></w:document>');
    const { result, runProcessor } = await read(zipSync(entries));
    const text = textOf(result);
    expect(text).not.toContain('Pictures: ');
    expect(text).toContain('Pictures outside the text (headers, footers, layouts and masters, or not used): [Image 1] PNG 970×788 (1 KB), linked but not placed;');
    expect(text).toContain('Pictures outside the text are not attached. To look at one, call read_file with image_index=N;');
    expect(runProcessor).not.toHaveBeenCalled();
  });

  it('attaches the pictures of a document with two, each after its label', async () => {
    const ctx = contextFor(docx('two'));
    vi.mocked(ctx.files!.runProcessor).mockResolvedValue(probeAnswer({ ok: true, views: [view(970, 788), view(1431, 205)] }));
    const outcome = await readOffice('/d/report.docx', params(), ctx);
    if (outcome.kind !== 'done' || typeof outcome.result === 'string') throw new Error('expected pictures');
    const [, , options] = vi.mocked(ctx.files!.runProcessor).mock.calls[0];
    expect(options[2]).toBe('office-image');
    expect(JSON.parse(options[3] as string)).toMatchObject({ parts: ['word/media/image1.png', 'word/media/image2.jpeg'], side: 1400 });
    expect(textOf(outcome.result)).toContain('Attached below, in this order: Image 1, Image 2.');
    expect(outcome.result.slice(1).map((block) => (block.type === 'text' ? block.text : 'IMAGE'))).toEqual([
      '[Image 1 of report.docx, whole picture, 1400×700 px]', 'IMAGE',
      '[Image 2 of report.docx, whole picture, 1400×700 px]', 'IMAGE',
    ]);
  });

  it('attaches nothing for a model that cannot see, and runs nothing', async () => {
    const { result, runProcessor } = await read(docx('two'), {}, { supportsVision: false });
    expect(textOf(result)).toContain('This model cannot see images, so the pictures are not shown');
    expect(runProcessor).not.toHaveBeenCalled();
  });

  it('says why the pictures could not be attached when the renderer cannot run, without the user\'s folders', async () => {
    const ctx = contextFor(docx('two'));
    vi.mocked(ctx.files!.runProcessor).mockResolvedValue({ code: 127, stdout: '', stderr: '/Users/zhangsan/Library/Application Support/阿布/python/bin/python3: No such file or directory' });
    const outcome = await readOffice('/d/report.docx', params(), ctx);
    const text = outcome.kind === 'done' ? textOf(outcome.result) : '';
    expect(text).toContain('The pictures could not be attached (the bundled Python could not run: Python was not found).');
    expect(text).not.toContain('zhangsan');
  });

  it('gives a workbook\'s sheet sizes without trailing empty cells, the row cut, its chart and picture', async () => {
    const { result } = await read(xlsx(520));
    const text = textOf(result);
    expect(text).toMatch(/^\[Excel workbook: 2 sheets\]/);
    expect(text).toContain("Sheets: 'Data' 521 rows × 2 columns (only the first 500 rows are shown below, 21 more are left out; to read them, run a Python script with openpyxl); 'Old' (hidden) 1 row × 1 column.");
    expect(text).toContain('Cells are shown as their values; formulas are not shown.');
    expect(text).toContain("Chart 1: barChart (vertical, clustered) \"Revenue by region\", sheet 'Data' at E2; series \"Revenue\": categories Sheet1!$A$2:$A$3, values Sheet1!$B$2:$B$3.");
    expect(text).toContain("Pictures: [Image 1] PNG 590×200 (1 KB), sheet 'Data' at B4.");
    expect(text).toContain('=== Sheet: Data ===\nRegion\tRevenue\nR0\t0\n');
    expect(text).toContain('[... 21 more rows omitted ...]');
  });

  it('lists a presentation slide by slide', async () => {
    const { result } = await read(pptx(), {}, { supportsVision: false });
    const text = textOf(result);
    expect(text).toMatch(/^\[PowerPoint: 2 slides\. Slides are not rendered/);
    expect(text).toContain('=== Slide 1 ===\n[On this slide: Image 1]\nQuarterly review\nLine one\nline two\n=== Slide 2 ===\n[On this slide: Chart 1]\nChart slide');
    expect(text).toContain('[Image 2] PNG 100×30 (1 KB), slide layout');
  });

  it('shows one picture with image_index, zoomed as asked', async () => {
    const ctx = contextFor(docx('many'));
    vi.mocked(ctx.files!.runProcessor).mockResolvedValue(probeAnswer({ ok: true, views: [{ ...view(1431, 205), region: [0, 0, 0.5, 1] }] }));
    const outcome = await readOffice('/d/report.docx', params({ imageIndex: 2, region: [0, 0, 0.5, 1] }), ctx);
    if (outcome.kind !== 'done' || typeof outcome.result === 'string') throw new Error('expected a picture');
    expect(JSON.parse(vi.mocked(ctx.files!.runProcessor).mock.calls[0][2][3] as string))
      .toMatchObject({ parts: ['word/media/image2.jpeg'], region: [0, 0, 0.5, 1], rotate: 0, side: 1600 });
    expect(textOf(outcome.result)).toMatch(/^\[Image 2 of report\.docx: JPEG 1431×205 \(1 KB\), in the text; region x 0–0\.5, y 0–1, shown at 1400×700 px\./);
    expect(outcome.result[1]).toEqual({ type: 'text', text: '[Image 2 of report.docx, region x 0–0.5, y 0–1, 1400×700 px]' });
  });

  it('refuses a picture that does not exist or cannot be drawn, and parameters that do not apply', async () => {
    expect(textOf((await read(docx('many'), { imageIndex: 9 })).result)).toBe('Error: image_index 9 does not exist; file has 5 pictures.');
    expect(textOf((await read(docx('many'), { imageIndex: 3 })).result)).toBe('Error: Image 3 is a vector picture (EMF), which cannot be shown.');
    expect(textOf((await read(docx('many'), { region: [0, 0, 0.5, 0.5] })).result)).toMatch(/^Error: region and rotate apply to one picture/);
    expect(textOf((await read(docx('many'), { pages: [[1, 1]] })).result)).toMatch(/^Error: pages is for PDF files/);
    expect(textOf((await read(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 1, 2, 3]))).result)).toMatch(/^Error: The file could not be opened as an Office document/);
    expect(textOf((await read(new Uint8Array(0))).result))
      .toBe('Error: The file could not be opened as an Office document (the file is empty). It may be damaged, password-protected, or an older .doc/.xls/.ppt file renamed.');
  });
});

describe('readOffice text budget', () => {
  it('cuts a long Chinese document under the bytes conversation history keeps, and says so', async () => {
    const paragraph = `<w:p><w:r><w:t>${'合同条款'.repeat(5_000)}</w:t></w:r></w:p>`;
    const bytes = zipSync({ 'word/document.xml': strToU8(`<w:document><w:body>${paragraph.repeat(4)}</w:body></w:document>`) });
    const text = textOf((await read(bytes)).result);
    expect(new TextEncoder().encode(text).length).toBeLessThan(256 * 1024);
    expect(text).toMatch(/\n\[\.\.\. the text is cut here: one read holds about 200 KB of text\. To read the rest, run a Python script with python-docx \.\.\.\]$/);
  });
});

describe('readOffice on files named .xlsx, .docx or .pptx that are no zip container', () => {
  async function readAt(path: string, bytes: Uint8Array, fields: Partial<DocumentReadParams> = {}): Promise<string> {
    const ctx = contextFor(bytes);
    const outcome = await readOffice(path, params(fields), ctx);
    if (outcome.kind !== 'done') throw new Error(`unexpected ${outcome.kind}`);
    expect(ctx.files!.runProcessor).not.toHaveBeenCalled();
    return textOf(outcome.result);
  }

  const table = '<html><head><meta charset="utf-8"><style>td { color: red }</style></head><body><table><tr><td>姓名</td><td>金额</td></tr><tr><td>张三</td><td>100</td></tr></table></body></html>';
  /** "姓名,金额\n张三,100\n" in GBK, as Chinese Windows writes a CSV. */
  const gbkCsv = new Uint8Array([0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0xd5, 0xc5, 0xc8, 0xfd, 0x2c, 0x31, 0x30, 0x30, 0x0a]);

  /** An OLE compound file with the streams an encrypted Office file has. */
  function encrypted(): Uint8Array {
    const cfb = XLSX.CFB.utils.cfb_new();
    XLSX.CFB.utils.cfb_add(cfb, '/EncryptionInfo', new Uint8Array([4, 0, 4, 0]));
    XLSX.CFB.utils.cfb_add(cfb, '/EncryptedPackage', new Uint8Array(64));
    return new Uint8Array(XLSX.CFB.write(cfb, { type: 'array' }) as ArrayLike<number>);
  }

  function biff(): Uint8Array {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['姓名', '金额'], ['张三', 100]]), '表1');
    return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'biff8' }) as ArrayBuffer);
  }

  it('reads an HTML table saved as .xlsx as a spreadsheet', async () => {
    const text = await readAt('/d/导出.xlsx', strToU8(table));
    expect(text).toMatch(/^\[Excel workbook: 1 sheet\]/);
    expect(text).toContain('Not an .xlsx inside: this file holds an HTML page, read as a spreadsheet. Pictures and charts are not listed.');
    expect(text).toContain('姓名\t金额\n张三\t100');
  });

  it('reads an old Excel 97-2003 workbook renamed .xlsx', async () => {
    const text = await readAt('/d/old.xlsx', biff());
    expect(text).toContain('this file holds an Excel 97-2003 (.xls) workbook, read as a spreadsheet');
    expect(text).toContain("Sheets: '表1' 2 rows × 2 columns.");
    expect(text).toContain('=== Sheet: 表1 ===\n姓名\t金额\n张三\t100');
  });

  it('reads a CSV renamed .xlsx, in UTF-8 or in GBK, without mangling its Chinese', async () => {
    const utf8 = await readAt('/d/a.xlsx', strToU8('姓名,金额\n张三,100\n'));
    expect(utf8).toContain('this file holds plain text such as CSV, read as a spreadsheet');
    expect(utf8).toContain('姓名\t金额\n张三\t100');
    expect(await readAt('/d/b.xlsx', gbkCsv)).toContain('姓名\t金额\n张三\t100');
  });

  it('still says a damaged zip is damaged', async () => {
    const text = await readAt('/d/broken.xlsx', new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9, 9, 9, 9, 9, 9]));
    expect(text).toMatch(/^Error: The file could not be opened as an Office document \(.+\)\. It may be damaged/);
  });

  it('says a password-protected workbook or document is password-protected', async () => {
    for (const name of ['/d/locked.xlsx', '/d/locked.docx', '/d/locked.pptx']) {
      expect(await readAt(name, encrypted())).toBe('Error: This file is password-protected, so it cannot be read. Reading it needs a copy without the password.');
    }
  });

  it('names an old Word or PowerPoint file renamed .docx or .pptx', async () => {
    const ole = biff();
    expect(await readAt('/d/old.docx', ole)).toBe('Error: This file is named .docx but holds an older Word 97-2003 (.doc) file, which read_file cannot read. Saved again as .docx (Save As in Office or WPS), it can be read.');
    expect(await readAt('/d/old.pptx', ole)).toContain('older PowerPoint 97-2003 (.ppt) file');
  });

  it('shows the text of an HTML page saved as .docx, without its markup and styles', async () => {
    const text = await readAt('/d/通知.docx', strToU8('<html><head><style>p{margin:0}</style></head><body><h1>关于放假的通知</h1><p>各部门：&nbsp;国庆放假 7 天。</p><table><tr><td>部门</td><td>值班人</td></tr></table></body></html>'));
    expect(text).toBe('[Not a Word document inside: this .docx file holds an HTML page, shown as its text. Its pictures, if any, are not read.]\n\n关于放假的通知\n各部门： 国庆放假 7 天。\n部门\t值班人');
  });

  it('refuses image_index on a file that holds no numbered pictures', async () => {
    expect(await readAt('/d/导出.xlsx', strToU8(table), { imageIndex: 1 })).toMatch(/^Error: this file is not a zip-based Office document/);
  });
});

describe('readOffice through the desktop\'s command route (no file processor)', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it('renders the attached pictures with run_argv_command on the file itself', async () => {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    vi.mocked(readFile).mockResolvedValueOnce(docx('two'));
    vi.mocked(invoke).mockResolvedValueOnce(probeAnswer({ ok: true, views: [view(970, 788), view(1431, 205)] }));
    const outcome = await readOffice('/Users/me/报告.docx', params(), {});
    if (outcome.kind !== 'done' || typeof outcome.result === 'string') throw new Error('expected pictures');
    const [command, payload] = vi.mocked(invoke).mock.calls[0] as [string, { program: string; args: string[]; timeout: number }];
    expect(command).toBe('run_argv_command');
    expect(payload.args.slice(2, 3)).toEqual(['office-image']);
    expect(payload.args[4]).toBe('/Users/me/报告.docx');
    expect(payload.timeout).toBe(30);
    expect(textOf(outcome.result)).toContain('Attached below, in this order: Image 1, Image 2.');
  });
});
