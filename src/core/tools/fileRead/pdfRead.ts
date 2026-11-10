import type { ToolExecutionContext, ToolResultContent } from '@/types';
import { getBaseName } from '@/utils/pathUtils';
import { format, getI18n } from '@/i18n';
import {
  runDocumentProbe,
  tooLargeError,
  type PdfPageFacts,
  type PdfPageProbe,
  type PdfReadProbe,
  type ProbeOutcome,
} from './documentProbe';
import {
  formatPageList,
  pagesArgument,
  READ_TEXT_BYTE_BUDGET,
  type DocumentReadParams,
} from './readParams';
import { labeledImage, withImages } from './resultImages';

/**
 * What read_file shows of a PDF: a short manifest of what the file holds and
 * what the model has and has not been shown, then the text of each page, then
 * pictures of the pages that need a look.
 *
 * Text and picture complement each other. A text layer gives exact characters
 * but can be garbled (a broken font encoding) or wrong (scanner OCR), and it
 * says nothing about figures, stamps, signatures or vector drawings; a page
 * picture shows all of that but can blur small print. The manifest says which
 * is which, so the model knows where to trust the text and where to look, and
 * how to look closer (`pages`).
 */

/**
 * When a page needs to be looked at rather than only read: little text, a
 * garbled text layer, pictures covering a quarter of the page (scans included),
 * a vector drawing (CAD exports keep their labels in the text layer and their
 * geometry in paths), or a figure on a page with little text.
 */
export const PDF_LOOK_RULE = {
  littleText: 200,
  imageShare: 0.25,
  drawingPaths: 300,
  figureText: 800,
  figurePaths: 50,
} as const;

/** A document this short has its pages that need a look attached as images. */
export const PDF_AUTO_IMAGE_MAX_PAGES = 3;
/** At most this many page images per read_file call with `pages`. */
export const PDF_MAX_PAGE_IMAGES = 4;
/** Characters of PDF text per read_file call. */
export const PDF_TEXT_BUDGET = 100_000;
/** Long side of a whole-page image, before its rulers. */
const PAGE_SIDE = 1400;
/** A page with this many vector paths is mentioned as holding lines or shapes. */
const SOME_PATHS = 10;

export type DocumentReadOutcome =
  | { kind: 'done'; result: string | ToolResultContent[] }
  /** Python could not run: read_file falls back to text extraction alone. */
  | { kind: 'fallback'; detail: string }
  | { kind: 'aborted' };

/** Why a page needs a look; empty when its text says everything. */
export function lookReasons(page: PdfPageFacts): string[] {
  const why: string[] = [];
  if (page.chars < PDF_LOOK_RULE.littleText) why.push('little or no text');
  if (page.garbled) why.push('garbled text layer');
  if (page.image_share >= PDF_LOOK_RULE.imageShare) why.push('pictures');
  if (page.paths >= PDF_LOOK_RULE.drawingPaths) why.push('vector drawing');
  if (!why.length && page.chars < PDF_LOOK_RULE.figureText && (page.images > 0 || page.paths >= PDF_LOOK_RULE.figurePaths)) {
    why.push('figure');
  }
  return why;
}

const needsLook = (page: PdfPageFacts) => lookReasons(page).length > 0;

const RULER_NOTE = 'Rulers on the top and left edges mark fractions of the page in tenths (0 = top/left, 1 = bottom/right).';

/** "page 18" or "pages 1–3, 7". */
function pagesText(pages: readonly number[]): string {
  return `${pages.length === 1 ? 'page' : 'pages'} ${formatPageList(pages)}`;
}

/** The manifest lines that describe the pages' text layers and contents. */
function contentLines(pages: readonly PdfPageFacts[]): string[] {
  const numbers = (keep: (page: PdfPageFacts) => boolean) => pages.filter(keep).map((page) => page.n);
  const lines: string[] = [];
  const intact = numbers((p) => !p.ocr && !p.garbled && p.chars >= PDF_LOOK_RULE.littleText);
  const ocr = numbers((p) => p.ocr && !p.garbled);
  const garbled = numbers((p) => p.garbled);
  const little = numbers((p) => p.chars < PDF_LOOK_RULE.littleText);
  if (intact.length) lines.push(`Text layer intact: ${pagesText(intact)}. Its characters are exact; prefer them for names and numbers.`);
  if (ocr.length) lines.push(`Scanned pages with an OCR text layer: ${pagesText(ocr)}. Printed text is mostly read right; a passage you can read whole below needs no look. Handwriting, signatures, stamps, ticks and circles are not in the OCR text (at most as stray characters): look at the page image for those, and for any figure the text shows garbled or in doubt.`);
  if (garbled.length) lines.push(`Garbled text layer (broken font encoding): ${pagesText(garbled)}. Do not trust these characters; read the page image instead.`);
  if (little.length) lines.push(`Little or no text: ${pagesText(little)}. What ${little.length === 1 ? 'it holds' : 'they hold'} (signatures, stamps, handwriting, drawings, pictures) is only in the page image.`);

  const pictures = numbers((p) => !p.ocr && p.image_share >= PDF_LOOK_RULE.imageShare);
  const drawings = numbers((p) => p.paths >= PDF_LOOK_RULE.drawingPaths);
  const figures = numbers((p) => lookReasons(p).includes('figure'));
  const listed = new Set([...pictures, ...drawings, ...figures]);
  const smallPictures = numbers((p) => !p.ocr && p.images > 0 && !listed.has(p.n));
  const someLines = numbers((p) => p.paths >= SOME_PATHS && !listed.has(p.n));
  if (pictures.length) lines.push(`Pictures cover a quarter or more of ${pagesText(pictures)}.`);
  if (drawings.length) lines.push(`Vector drawings (${PDF_LOOK_RULE.drawingPaths}+ lines and shapes): ${pagesText(drawings)}. The text layer holds their labels but not what the labels point to; look at the page image.`);
  if (figures.length) lines.push(`Figures or charts with little text: ${pagesText(figures)}.`);
  if (smallPictures.length) lines.push(`Smaller pictures (logos, photos, stamps): ${pagesText(smallPictures)}.`);
  if (someLines.length) lines.push(`Some lines or shapes (tables, rules, small charts): ${pagesText(someLines)}.`);
  return lines;
}

function pageLabel(fileName: string, page: number): string {
  return `Page ${page} of ${fileName}`;
}

function textBody(pages: readonly PdfPageProbe[]): string {
  const body: string[] = [];
  for (const page of pages) {
    if (page.text === undefined) continue;
    body.push(`--- Page ${page.n} ---`);
    const text = page.text.trim();
    body.push(text ? text + (page.text_cut ? '\n[... the text of this page is cut here: the read budget ran out ...]' : '') : '(no text layer)');
  }
  return body.join('\n');
}

/**
 * The result of a PDF read: manifest, page text, then the page images in the
 * order the manifest names them. With `explicitPages`, every rendered page is
 * attached; otherwise only the pages that need a look.
 */
export function buildPdfReadResult(
  probe: PdfReadProbe,
  options: { fileName: string; vision: boolean; explicitPages: boolean },
): string | ToolResultContent[] {
  const pages = probe.list;
  const lines: string[] = [];
  lines.push(options.explicitPages
    ? `[PDF: ${probe.pages} ${probe.pages === 1 ? 'page' : 'pages'}. This read covers ${pagesText(pages.map((p) => p.n))}.]`
    : `[PDF: ${probe.pages} ${probe.pages === 1 ? 'page' : 'pages'}]`);
  lines.push(...contentLines(pages));

  const look = pages.filter(needsLook).map((p) => p.n);
  const attached = options.vision
    ? pages.filter((p) => p.img && (options.explicitPages || needsLook(p)))
    : [];
  if (!options.vision) {
    if (look.length) {
      lines.push(`This model cannot see images, so no page images are attached. ${look.length === 1 ? 'Page' : 'Pages'} ${formatPageList(look)} ${look.length === 1 ? 'holds' : 'hold'} content that is only visible as images or drawings; if the answer depends on it, say that it could not be checked.`);
    }
  } else {
    if (attached.length) {
      lines.push(`Page images attached below, in this order: ${attached.length === 1 ? 'page' : 'pages'} ${attached.map((p) => p.n).join(', ')}. ${RULER_NOTE}`);
    }
    const shown = new Set(attached.map((p) => p.n));
    const failed = pages.filter((p) => !shown.has(p.n) && p.skip && (options.explicitPages || needsLook(p))).map((p) => p.n);
    const wanted = (options.explicitPages ? pages.map((p) => p.n) : look).filter((n) => !shown.has(n) && !failed.includes(n));
    if (wanted.length && options.explicitPages) {
      const next = wanted.slice(0, PDF_MAX_PAGE_IMAGES);
      lines.push(`Not attached as images: ${pagesText(wanted)} (at most ${PDF_MAX_PAGE_IMAGES} page images come with one call). To see them, call read_file with pages, e.g. pages="${pagesArgument(next)}" (up to ${PDF_MAX_PAGE_IMAGES} pages per call).`);
    } else if (wanted.length && wanted.length <= PDF_MAX_PAGE_IMAGES) {
      lines.push(`Not attached as images: ${pagesText(wanted)}, which ${wanted.length === 1 ? 'holds' : 'hold'} content seen only in ${wanted.length === 1 ? 'its image' : 'their images'} (no page images come with a full read of a document of more than ${PDF_AUTO_IMAGE_MAX_PAGES} pages). To see ${wanted.length === 1 ? 'it' : 'them'}, call read_file with pages="${pagesArgument(wanted)}".`);
    } else if (wanted.length) {
      // On a long scan every page is in `wanted`: which of them to look at is the task's choice, not this list's.
      const first = wanted[0];
      const range = first < probe.pages ? `, pages="${first}-${first + 1}" a range` : '';
      lines.push(`No page images come with a full read of a document of more than ${PDF_AUTO_IMAGE_MAX_PAGES} pages; the lines above say which pages hold content seen only in their images. `
        + `Look at the pages the answer needs, not at every page listed: pages="${first}" shows one page${range} (up to ${PDF_MAX_PAGE_IMAGES} page images per call).`);
    }
    if (failed.length) {
      lines.push(`Could not be rendered within the time or size limit: ${pagesText(failed)}. Ask for fewer pages at a time, e.g. pages="${failed[0]}".`);
    }
    if (!look.length && !options.explicitPages) {
      lines.push('No page needs a look: the text layer carries the content. To see a page anyway, call read_file with pages.');
    }
  }
  if (probe.text_cut_at !== null) {
    lines.push(`The text stops at page ${probe.text_cut_at} (about ${PDF_TEXT_BUDGET.toLocaleString('en-US')} characters per read). To read on, call read_file with pages="${probe.text_cut_at}-".`);
  }
  if (probe.unexamined_from !== null) {
    lines.push(`Pages from ${probe.unexamined_from} on were not examined in the time available. To read them, call read_file with pages="${probe.unexamined_from}-".`);
  }
  const text = `${lines.join('\n')}\n\n${textBody(pages)}`;
  return withImages(text, attached.flatMap((page) => labeledImage(
    `${pageLabel(options.fileName, page.n)}, whole page, ${page.img!.w}×${page.img!.h} px`,
    page.img!,
  )));
}

function probeFailure(outcome: Exclude<ProbeOutcome<unknown>, { status: 'ok' }>, fileName: string): DocumentReadOutcome {
  const t = getI18n().toolResult.fileRead;
  switch (outcome.status) {
    case 'aborted':
      return { kind: 'aborted' };
    case 'unavailable':
      return { kind: 'fallback', detail: outcome.detail };
    case 'tooLarge':
      // read_file's own extractors would hit the same limit: no fallback.
      return { kind: 'done', result: tooLargeError(fileName, outcome.bytes, outcome.limit) };
    case 'crashed':
      return {
        kind: 'done',
        result: `Error: The PDF reader stopped before finishing (${outcome.detail}). Read fewer pages at a time, e.g. pages="1-10".`,
      };
    case 'failed':
      if (outcome.message === 'password-protected') return { kind: 'done', result: t.pdfPasswordProtected };
      if (outcome.error === 'ValueError') return { kind: 'done', result: `Error: ${outcome.message}` };
      return { kind: 'done', result: format(t.pdfDamaged, { detail: outcome.message || outcome.error }) };
  }
}

/**
 * Read a PDF with the document probe. `fallback` when Python cannot run, so
 * read_file can still offer the text that other extractors find.
 */
export async function readPdf(
  filePath: string,
  params: DocumentReadParams,
  context?: ToolExecutionContext,
): Promise<DocumentReadOutcome> {
  const vision = context?.supportsVision !== false;
  const fileName = getBaseName(filePath);
  const outcome = await runDocumentProbe<PdfReadProbe>(filePath, 'pdf-read', {
    pages: params.pages,
    render: vision,
    render_all_at_most: PDF_AUTO_IMAGE_MAX_PAGES,
    max_render: PDF_MAX_PAGE_IMAGES,
    side: PAGE_SIDE,
    text_chars: PDF_TEXT_BUDGET,
    text_bytes: READ_TEXT_BYTE_BUDGET,
    look: PDF_LOOK_RULE,
  }, context);
  if (outcome.status !== 'ok') return probeFailure(outcome, fileName);
  return { kind: 'done', result: buildPdfReadResult(outcome.value, { fileName, vision, explicitPages: params.pages !== null }) };
}
