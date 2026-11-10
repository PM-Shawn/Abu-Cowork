import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { ToolResultContent } from '@/types';
import type { PdfPageProbe, PdfReadProbe } from './documentProbe';
import { buildPdfReadResult, lookReasons, readPdf } from './pdfRead';
import type { DocumentReadParams } from './readParams';

function page(n: number, fields: Partial<PdfPageProbe> = {}): PdfPageProbe {
  return {
    n, w: 595, h: 842, chars: 1200, garbled: false, ocr: false,
    images: 0, image_share: 0, paths: 0, text: `text of page ${n}`, ...fields,
  };
}

function pdf(list: PdfPageProbe[], fields: Partial<PdfReadProbe> = {}): PdfReadProbe {
  return { ok: true, pages: list.length, unexamined_from: null, text_cut_at: null, list, seconds: 0.1, ...fields };
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

describe('readPdf', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  const params = (fields: Partial<DocumentReadParams> = {}): DocumentReadParams =>
    ({ pages: null, ...fields });
  const optionsOf = () => JSON.parse((vi.mocked(invoke).mock.calls[0][1] as { args: string[] }).args[3]);

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

  it('falls back when Python cannot run, and reports a crash or a refusal as an error', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 127, stdout: '', stderr: 'python3: command not found' });
    expect(await readPdf('/d/a.pdf', params(), {})).toEqual({ kind: 'fallback', detail: 'Python was not found' });

    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '{"ok":true,"list":[\n[truncated: output too large]', stderr: '' });
    expect(await readPdf('/d/a.pdf', params(), {})).toEqual({ kind: 'done', result: expect.stringMatching(/^Error: The PDF reader stopped before finishing \(output too large\)/) });

    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '{"ok":false,"error":"ValueError","message":"page 30 does not exist; the document has 23 pages"}', stderr: '' });
    expect(await readPdf('/d/a.pdf', params({ pages: [[30, 30]] }), {}))
      .toEqual({ kind: 'done', result: 'Error: page 30 does not exist; the document has 23 pages' });

    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: '{"ok":false,"error":"RuntimeError","message":"password-protected"}', stderr: '' });
    expect(await readPdf('/d/a.pdf', params(), {})).toEqual({ kind: 'done', result: expect.stringMatching(/^Error: This PDF is password-protected/) });
  });
});
