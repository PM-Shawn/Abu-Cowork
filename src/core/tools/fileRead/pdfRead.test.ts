import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ToolResultContent } from '@/types';
import type { PdfPageProbe, PdfReadProbe, PdfViewProbe } from './documentProbe';
import { buildPdfReadResult, buildPdfViewResult, lookReasons, readPdf } from './pdfRead';
import type { DocumentReadParams } from './readParams';

function page(n: number, fields: Partial<PdfPageProbe> = {}): PdfPageProbe {
  return {
    n, w: 595, h: 842, chars: 1200, garbled: false, ocr: false,
    images: 0, image_share: 0, paths: 0, text: `text of page ${n}`, ...fields,
  };
}

function pdf(list: PdfPageProbe[], fields: Partial<PdfReadProbe> = {}): PdfReadProbe {
  return { ok: true, pages: list.length, unexamined_from: null, text_cut_at: null, text_cut_from: 0, list, seconds: 0.1, ...fields };
}

const textOf = (result: string | ToolResultContent[]): string =>
  typeof result === 'string' ? result : (result[0] as { text: string }).text;
const imagesOf = (result: string | ToolResultContent[]) =>
  typeof result === 'string' ? [] : result.filter((block) => block.type === 'image');
const labelsOf = (result: string | ToolResultContent[]) =>
  typeof result === 'string' ? [] : result.slice(1).flatMap((block) => (block.type === 'text' ? [block.text] : []));

const img = { data: 'AAAA', w: 1034, h: 1426 };
const fileName = 'contract.pdf';

describe('lookReasons (the page rule), on the facts of the sample files', () => {
  it('flags a scanned contract page with an OCR layer, and its signature page for little text', () => {
    expect(lookReasons(page(1, { chars: 363, ocr: true, images: 1, image_share: 0.749 }))).toEqual(['pictures']);
    expect(lookReasons(page(18, { chars: 93, ocr: true, images: 1, image_share: 0.717 }))).toEqual(['little or no text', 'pictures']);
  });

  it('flags a CAD drawing whose labels are text and whose geometry is paths', () => {
    expect(lookReasons(page(1, { chars: 804, paths: 6625 }))).toEqual(['vector drawing']);
    expect(lookReasons(page(2, { chars: 143, paths: 12947 }))).toEqual(['little or no text', 'vector drawing']);
  });

  it('flags a page that is only pictures, a garbled layer, and a figure with little text', () => {
    expect(lookReasons(page(1, { chars: 0, images: 12, image_share: 1 }))).toEqual(['little or no text', 'pictures']);
    expect(lookReasons(page(1, { garbled: true }))).toEqual(['garbled text layer']);
    expect(lookReasons(page(1, { chars: 600, paths: 80 }))).toEqual(['figure']);
    expect(lookReasons(page(1, { chars: 600, images: 1, image_share: 0.1 }))).toEqual(['figure']);
  });

  it('leaves a text page alone, logo and table lines included', () => {
    expect(lookReasons(page(1))).toEqual([]);
    expect(lookReasons(page(1, { chars: 2500, images: 1, image_share: 0.02, paths: 120 }))).toEqual([]);
    expect(lookReasons(page(1, { chars: 900, paths: 60 }))).toEqual([]);
  });
});

describe('buildPdfReadResult', () => {
  it('describes a long scanned document, attaches nothing and says how to look', () => {
    const list = Array.from({ length: 23 }, (_, i) => page(i + 1, {
      chars: i === 17 ? 93 : 400, ocr: true, images: 1, image_share: 0.75,
    }));
    const result = buildPdfReadResult(pdf(list), { fileName, vision: true, explicitPages: false });
    const text = textOf(result);
    expect(text).toMatch(/^\[PDF: 23 pages\]\n/);
    expect(text).toContain('Scanned pages with an OCR text layer: pages 1–23. Printed text is mostly read right; a passage you can read whole below needs no look.');
    expect(text).toContain('Handwriting, signatures, stamps, ticks and circles are not in the OCR text');
    expect(text).toContain('Little or no text: page 18. What it holds (signatures, stamps');
    // Every page of a long scan needs its image for something; the task decides which to look at.
    expect(text).toContain('No page images come with a full read of a document of more than 3 pages; the lines above say which pages hold content seen only in their images. Look at the pages the answer needs, not at every page listed: pages="1" shows one page, pages="1-2" a range (up to 4 page images per call).');
    expect(text).not.toMatch(/need a look|pages 1–23, which/);
    expect(text).toContain('call read_file with pages="18" and region=');
    expect(text).toContain('--- Page 18 ---\ntext of page 18');
    expect(imagesOf(result)).toHaveLength(0);
  });

  it('attaches the pages of a short drawing that need a look, each after its label', () => {
    const result = buildPdfReadResult(pdf([
      page(1, { chars: 804, paths: 6625, img }),
      page(2, { chars: 143, paths: 12947, img }),
      page(3, { chars: 2000, img }),
    ]), { fileName: 'pier.pdf', vision: true, explicitPages: false });
    const text = textOf(result);
    expect(text).toContain('Text layer intact: pages 1, 3.');
    expect(text).toContain('Little or no text: page 2.');
    expect(text).toContain('Vector drawings (300+ lines and shapes): pages 1–2.');
    expect(text).toContain('Page images attached below, in this order: pages 1, 2. Rulers on the top and left edges');
    // The turn is named by how the content lies, and region follows the turn.
    expect(text).toContain('270 when it lies turned a quarter clockwise (the tops of its letters face right), 90 when turned a quarter counter-clockwise');
    expect(text).toContain('region is given on the turned image, as its rulers show: to zoom into content you have seen only unturned, call with rotate alone first.');
    expect(imagesOf(result)).toHaveLength(2);
    expect(labelsOf(result)).toEqual([
      '[Page 1 of pier.pdf, whole page, 1034×1426 px]',
      '[Page 2 of pier.pdf, whole page, 1034×1426 px]',
    ]);
    // Every page that needs a look is attached: nothing is listed as missing.
    expect(text).not.toMatch(/Not attached|No page images come/);
  });

  it('lists nothing as not attached when every page asked for came with its image', () => {
    const text = textOf(buildPdfReadResult(pdf([page(1, { chars: 0, images: 1, image_share: 1, img })], { pages: 1 }), { fileName, vision: true, explicitPages: true }));
    expect(text).toContain('Page images attached below, in this order: page 1.');
    expect(text).not.toMatch(/Not attached|No page images come|pages=""/);
  });

  it('names the few pages of a long text document that hold content seen only in their images', () => {
    const list = Array.from({ length: 23 }, (_, i) => page(i + 1, i === 21 || i === 22 ? { chars: 90, images: 2, image_share: 0.3 } : {}));
    const text = textOf(buildPdfReadResult(pdf(list), { fileName, vision: true, explicitPages: false }));
    expect(text).toContain('Not attached as images: pages 22–23, which hold content seen only in their images (no page images come with a full read of a document of more than 3 pages). To see them, call read_file with pages="22-23".');
    const apart = Array.from({ length: 23 }, (_, i) => page(i + 1, i === 2 || i === 9 ? { chars: 0 } : {}));
    expect(textOf(buildPdfReadResult(pdf(apart), { fileName, vision: true, explicitPages: false }))).toContain('call read_file with pages="3,10".');
  });

  it('says a text-only document needs no look', () => {
    const text = textOf(buildPdfReadResult(pdf([page(1, { img }), page(2, { img })]), { fileName, vision: true, explicitPages: false }));
    expect(text).toContain('No page needs a look: the text layer carries the content.');
  });

  it('attaches nothing to a model that cannot see, and says which pages hold image-only content', () => {
    const result = buildPdfReadResult(pdf([page(1, { chars: 0, images: 1, image_share: 1, img })]), { fileName, vision: false, explicitPages: false });
    expect(imagesOf(result)).toHaveLength(0);
    expect(textOf(result)).toContain('This model cannot see images, so no page images are attached. Page 1 holds content that is only visible as images or drawings');
    expect(textOf(result)).not.toContain('region=');
  });

  it('with pages: attaches every rendered page and names the ones past the per-call limit', () => {
    const list = [3, 4, 5, 6, 7, 8].map((n, i) => page(n, i < 4 ? { img } : {}));
    const result = buildPdfReadResult(pdf(list, { pages: 23 }), { fileName, vision: true, explicitPages: true });
    const text = textOf(result);
    expect(text).toMatch(/^\[PDF: 23 pages\. This read covers pages 3–8\.\]/);
    expect(text).toContain('Page images attached below, in this order: pages 3, 4, 5, 6.');
    expect(text).toContain('Not attached as images: pages 7–8 (at most 4 page images come with one call). To see them, call read_file with pages, e.g. pages="7-8"');
    expect(imagesOf(result)).toHaveLength(4);
  });

  it('names pages that could not be rendered, and where the text and the examination stopped', () => {
    const text = textOf(buildPdfReadResult(pdf([
      page(1, { chars: 0, image_share: 1, images: 1, skip: 'time' }),
      page(2, { text: 'cut', text_cut: true }),
      page(3, { text: undefined }),
    ], { pages: 40, text_cut_at: 2, unexamined_from: 4 }), { fileName, vision: true, explicitPages: false }));
    expect(text).toContain('Could not be rendered within the time or size limit: page 1.');
    expect(text).toContain('The text stops at page 2 (about 100,000 characters per read). To read on, call read_file with pages="2-".');
    expect(text).toContain('Pages from 4 on were not examined in the time available. To read them, call read_file with pages="4-".');
    expect(text).toContain('--- Page 2 ---\ncut\n[... the text of this page is cut here');
    expect(text).not.toContain('--- Page 3 ---');
  });

  it('says where in a long page the text stopped, and how to read on from there with the later pages kept', () => {
    const cut = textOf(buildPdfReadResult(pdf([
      page(1, { text: 'head of a long page', text_cut: true }),
    ], { pages: 2, text_cut_at: 1, text_cut_from: 100000 }), { fileName, vision: false, explicitPages: false }));
    expect(cut).toContain('The text stops partway through page 1, at character 100,000 of its text (about 100,000 characters per read). To read on, call read_file with pages="1-" and text_offset=100000; the pages after it follow.');
    const rest = textOf(buildPdfReadResult(pdf([
      page(1, { text: 'tail of a long page', text_from: 100000 }),
      page(2, { text: 'page two' }),
    ], { pages: 2 }), { fileName, vision: false, explicitPages: true }));
    expect(rest).toContain('--- Page 1, from character 100,000 of its text ---\ntail of a long page');
    expect(rest).toContain('--- Page 2 ---\npage two');
    expect(rest).not.toContain('The text stops');
  });

  it('marks a garbled layer and lists smaller pictures and lines', () => {
    const text = textOf(buildPdfReadResult(pdf([
      page(1, { garbled: true }),
      page(2, { chars: 3000, images: 1, image_share: 0.03 }),
      page(3, { chars: 3000, paths: 40 }),
    ]), { fileName, vision: true, explicitPages: false }));
    expect(text).toContain('Garbled text layer (broken font encoding): page 1. Do not trust these characters');
    expect(text).toContain('Smaller pictures (logos, photos, stamps): page 2.');
    expect(text).toContain('Some lines or shapes (tables, rules, small charts): page 3.');
  });
});

describe('buildPdfViewResult', () => {
  const view = (fields: Partial<PdfViewProbe> = {}): PdfViewProbe => ({
    ok: true, pages: 23, page: { ...page(18, { chars: 93, ocr: true, images: 1, image_share: 0.72 }) },
    region: [0.25, 0.2, 0.9, 0.5], rotate: 0, rulers: [[0.25, 0.9], [0.2, 0.5]],
    img: { data: 'ZZZZ', w: 1643, h: 1070 }, text: '乙方(签字): 张三', ...fields,
  });

  it('returns the enlarged region with its label and the OCR text inside it', () => {
    const result = buildPdfViewResult(view(), { fileName, vision: true });
    expect(textOf(result)).toContain('[PDF page 18 of 23: region x 0.25–0.9, y 0.2–0.5, shown at 1643×1070 px. The rulers give fractions of the whole page as shown here (x along the top, y down the side)');
    expect(textOf(result)).toContain('Text layer inside this region (scanner OCR: it can misread characters; check them against the image):\n乙方(签字): 张三');
    expect(labelsOf(result)).toEqual(['[Page 18 of contract.pdf, region x 0.25–0.9, y 0.2–0.5, 1643×1070 px]']);
  });

  it('names the turn before the region it was cut from, and says when there is no text there', () => {
    const text = textOf(buildPdfViewResult(view({ rotate: 90, text: '' }), { fileName, vision: true }));
    expect(text).toContain('turned 90° clockwise, region x 0.25–0.9, y 0.2–0.5');
    expect(text).toContain('keeping the same rotate');
    expect(text).toContain('No text layer inside this region; read it from the image.');
  });

  it('says when a view enlarges a scan past its own pixels, so a smaller region would only blur', () => {
    const tight = textOf(buildPdfViewResult(view({ scan_zoom: 8 }), { fileName, vision: true }));
    expect(tight).toContain("This view enlarges the scan's own pixels about 8 times: a smaller region shows no more detail, only more blur. Read what is legible at this size, and if a character stays unclear, say which one instead of zooming further.");
    expect(textOf(buildPdfViewResult(view({ scan_zoom: 1.4 }), { fileName, vision: true }))).not.toContain('enlarges');
    expect(textOf(buildPdfViewResult(view({ scan_zoom: null }), { fileName, vision: true }))).not.toContain('enlarges');
    expect(buildPdfViewResult(view({ scan_zoom: 8, img: null }), { fileName, vision: false })).not.toContain('enlarges');
  });

  it('gives a model that cannot see the region text alone', () => {
    const result = buildPdfViewResult(view({ img: null }), { fileName, vision: false });
    expect(typeof result).toBe('string');
    expect(result).toContain('only the text layer inside the region is shown');
  });
});

describe('readPdf', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  const params = (fields: Partial<DocumentReadParams> = {}): DocumentReadParams =>
    ({ pages: null, region: null, rotate: 0, ...fields });
  const optionsOf = () => JSON.parse((vi.mocked(invoke).mock.calls[0][1] as { args: string[] }).args[3]);
  const operationOf = () => (vi.mocked(invoke).mock.calls[0][1] as { args: string[] }).args[2];

  it('asks for renders only when the model can see', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 0, stdout: JSON.stringify(pdf([page(1)])), stderr: '' });
    await readPdf('/d/a.pdf', params(), { supportsVision: false });
    expect(optionsOf()).toMatchObject({ render: false, render_all_at_most: 3, max_render: 4, text_chars: 100_000, text_bytes: 200_000 });
    // A short document renders only the pages the manifest's rule says need a look.
    expect(optionsOf().look).toEqual({ littleText: 200, imageShare: 0.25, drawingPaths: 300, figureText: 800, figurePaths: 50 });
    vi.mocked(invoke).mockClear();
    await readPdf('/d/a.pdf', params({ pages: [[2, 3]] }), {});
    expect(optionsOf()).toMatchObject({ render: true, pages: [[2, 3]] });
  });

  it('views one page for region or rotate, and refuses several pages', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true, pages: 1, page: page(1), region: [0, 0, 1, 1], rotate: 90, rulers: [[1, 0], [0, 1]], img: img, text: '' }), stderr: '' });
    await readPdf('/d/a.pdf', params({ pages: [[5, 5]], rotate: 90 }), {});
    expect(operationOf()).toBe('pdf-view');
    expect(optionsOf()).toMatchObject({ page: 5, rotate: 90, side: 1600, render: true });

    vi.mocked(invoke).mockClear();
    const refused = await readPdf('/d/a.pdf', params({ pages: [[5, 6]], region: [0, 0, 0.5, 0.5] }), {});
    expect(refused).toEqual({ kind: 'done', result: expect.stringMatching(/^Error: region and rotate show one page/) });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('falls back when Python cannot run, and reports a crash or a refusal as an error', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 127, stdout: '', stderr: 'python3: command not found' });
    expect(await readPdf('/d/a.pdf', params(), {})).toEqual({ kind: 'fallback', detail: 'Python was not found' });

    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '{"ok":true,"list":[\n[truncated: output too large]', stderr: '' });
    expect(await readPdf('/d/a.pdf', params(), {})).toEqual({ kind: 'done', result: expect.stringMatching(/^Error: The PDF reader stopped before finishing \(output too large\)/) });

    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '{"ok":false,"error":"ValueError","message":"page 30 does not exist; the document has 23 pages"}', stderr: '' });
    expect(await readPdf('/d/a.pdf', params({ pages: [[30, 30]], region: [0, 0, 1, 0.5] }), {}))
      .toEqual({ kind: 'done', result: 'Error: page 30 does not exist; the document has 23 pages' });

    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '{"ok":false,"error":"RuntimeError","message":"password-protected"}', stderr: '' });
    expect(await readPdf('/d/a.pdf', params(), {})).toEqual({ kind: 'done', result: expect.stringMatching(/^Error: This PDF is password-protected/) });
  });
});
