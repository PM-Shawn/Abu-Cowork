import type { ToolExecutionContext, ToolResultContent } from '@/types';
import { getBaseName } from '@/utils/pathUtils';
import { getI18n, format } from '@/i18n';
import { FileOperationDenied } from '@/core/tools/fileOperation';
import { readFile as readBinFile } from '../fsBridge';
import { getFileExtension } from '../helpers/toolHelpers';
import { runDocumentProbe, tooLargeError, type ImageViewProbe, type OfficeImageProbe } from './documentProbe';
import {
  readOfficeManifest,
  type ChartSeries,
  type OfficeChart,
  type OfficeKind,
  type OfficeManifest,
  type OfficePicture,
  type ZipEntries,
} from './officeManifest';
import type { DocumentReadOutcome } from './pdfRead';
import {
  asksForView,
  cutToJsonBytes,
  describeView,
  enlargedNote,
  READ_TEXT_BYTE_BUDGET,
  TURN_HINT,
  viewRulerNote,
  type DocumentReadParams,
} from './readParams';
import { OfficeTooLargeError, officeTooLargeNote, unpackOffice } from './officeUnpack';
import { labeledImage, withImages } from './resultImages';
import { readSheetRows, SheetUnreadableError } from './sheetRows';

/**
 * What read_file shows of a Word, Excel or PowerPoint file: a manifest of the
 * pictures, charts and embedded objects it holds besides its text, then the
 * text. A document with one or two pictures in its body has them attached;
 * others are shown one at a time with `image_index`.
 *
 * A file whose bytes are no zip container is not an Office file of the newer
 * kind whatever its name: web systems export an HTML table, a CSV text or an
 * old Excel 97-2003 workbook and name it .xlsx. Such a workbook is read as a
 * spreadsheet, such a document as text.
 */

/** A document with at most this many pictures in its body has them attached to a plain read. */
export const OFFICE_AUTO_IMAGE_MAX = 2;
/** Rows of each sheet a workbook read shows. */
export const MAX_SHEET_ROWS = 500;
/** Pictures named one by one in each list of a manifest; the rest are counted. */
const MAX_LISTED_PICTURES = 60;
/** Long side of an attached picture, before its rulers. */
const ATTACH_SIDE = 1400;
/** Long side of a picture shown with image_index, before its rulers. */
const VIEW_SIDE = 1600;

const ZOOM_HINT = `add region={"x0":…,"y0":…,"x1":…,"y1":…} (fractions of the picture from its top-left corner, as on the rulers) to zoom in. ${TURN_HINT}`;

/** Where the body of each kind is, for the list of pictures outside it. */
const BODY_NAME: Record<OfficeKind, string> = { docx: 'text', xlsx: 'sheets', pptx: 'slides' };
/** The Python library that reads past what a read shows. */
const PYTHON_LIBRARY: Record<OfficeKind, string> = { docx: 'python-docx', xlsx: 'openpyxl', pptx: 'python-pptx' };

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

function sizeText(picture: OfficePicture): string {
  const kb = Math.max(1, Math.round(picture.bytes / 1024));
  const pixels = picture.width && picture.height ? ` ${picture.width}×${picture.height}` : '';
  const what = picture.media === 'video' ? ' video' : picture.media === 'audio' ? ' sound' : '';
  return `${picture.format.toUpperCase()}${what}${pixels} (${kb.toLocaleString('en-US')} KB)`;
}

/** Why a listed item cannot be shown, or nothing when it can. */
function unshownNote(picture: OfficePicture): string {
  if (picture.media) return ' (cannot be shown)';
  return picture.renderable ? '' : ` (${picture.format.toUpperCase()} vector picture, cannot be shown)`;
}

function pictureEntry(picture: OfficePicture, kind: OfficeKind): string {
  const places = picture.where.filter((place) => !(kind === 'docx' && place === 'in the text'));
  const where = places.length > 3 ? `${places.slice(0, 3).join(', ')} and ${places.length - 3} more` : places.join(', ');
  return `[Image ${picture.index}] ${sizeText(picture)}${where ? `, ${where}` : ''}${unshownNote(picture)}`;
}

function pictureList(pictures: readonly OfficePicture[], kind: OfficeKind): string {
  const listed = pictures.slice(0, MAX_LISTED_PICTURES).map((picture) => pictureEntry(picture, kind));
  if (pictures.length > MAX_LISTED_PICTURES) listed.push(`and ${pictures.length - MAX_LISTED_PICTURES} more`);
  return listed.join('; ');
}

/** Pictures the body places, which a plain read may attach: not a header's, a layout's or a master's, and no video. */
function bodyPictures(manifest: OfficeManifest): OfficePicture[] {
  return manifest.pictures.filter((picture) => picture.inBody && !picture.media);
}

function seriesText(series: ChartSeries, withCache: boolean): string {
  const parts = [
    series.categories && `categories ${series.categories}`,
    series.values && `values ${series.values}`,
    series.x && `x ${series.x}`,
    series.y && `y ${series.y}`,
    series.sizes && `sizes ${series.sizes}`,
    series.data && `data ${series.data}`,
    withCache && series.cachedCategories && `cached categories [${series.cachedCategories.join(', ')}]`,
    withCache && series.cachedValues && `cached values [${series.cachedValues.join(', ')}]`,
  ].filter(Boolean);
  return `${series.name ? `series "${series.name}"` : 'series'}: ${parts.join(', ') || 'no cell ranges'}`;
}

function chartLine(chart: OfficeChart, kind: OfficeKind): string {
  // A workbook's own cells are in the read; a document's chart keeps its numbers in an embedded sheet.
  const withCache = kind !== 'xlsx';
  const series = chart.series.map((entry) => seriesText(entry, withCache)).join('; ');
  return `Chart ${chart.index}: ${chart.type}${chart.title ? ` "${chart.title}"` : ''}, ${chart.where}; ${series || 'no series'}.`;
}

/** The manifest lines shared by the three kinds: pictures, what is attached, charts, embedded objects. */
function holdingsLines(
  manifest: OfficeManifest,
  attached: { shown: OfficePicture[]; problem?: string },
  vision: boolean,
): string[] {
  const lines: string[] = [];
  const { pictures, charts, kind } = manifest;
  const body = bodyPictures(manifest);
  const outside = pictures.filter((picture) => !picture.inBody && !picture.media);
  const media = pictures.filter((picture) => picture.media);
  if (!body.length && !outside.length) lines.push('No pictures.');
  if (body.length) lines.push(`Pictures: ${pictureList(body, kind)}.`);
  if (outside.length) {
    lines.push(`Pictures outside the ${BODY_NAME[kind]} (headers, footers, layouts and masters, or not used): ${pictureList(outside, kind)}.`);
  }
  if (media.length) lines.push(`Videos and sounds, listed only: ${pictureList(media, kind)}.`);
  const viewable = [...body, ...outside].filter((picture) => picture.renderable);
  if (viewable.length) {
    if (!vision) {
      lines.push('This model cannot see images, so the pictures are not shown; if the answer depends on them, say that they could not be checked.');
    } else if (attached.shown.length) {
      const rest = viewable.length > attached.shown.length ? ' The other pictures are not attached.' : '';
      lines.push(`Attached below, in this order: ${attached.shown.map((p) => `Image ${p.index}`).join(', ')}.${rest} Rulers on their top and left edges mark fractions of the picture in tenths. To look closer, call read_file with image_index and ${ZOOM_HINT}`);
    } else if (attached.problem) {
      lines.push(`The pictures could not be attached (${attached.problem}).`);
    } else {
      lines.push(body.filter((picture) => picture.renderable).length > OFFICE_AUTO_IMAGE_MAX
        ? `Not attached (more than ${OFFICE_AUTO_IMAGE_MAX} pictures). To look at one, call read_file with image_index=N; ${ZOOM_HINT}`
        : `Pictures outside the ${BODY_NAME[kind]} are not attached. To look at one, call read_file with image_index=N; ${ZOOM_HINT}`);
    }
  }
  if (charts.length) {
    lines.push(kind === 'xlsx'
      ? 'Charts, described from their definitions (not drawn); the numbers are in the cells they name:'
      : 'Charts, described from their definitions (not drawn); their numbers are in a sheet embedded in the file, cached values shown where few:');
    for (const chart of charts) lines.push(chartLine(chart, kind));
  }
  if (manifest.embeddedObjects.length) {
    const names = manifest.embeddedObjects.slice(0, 10).join(', ');
    lines.push(`Embedded objects, not read: ${names}${manifest.embeddedObjects.length > 10 ? ` and ${manifest.embeddedObjects.length - 10} more` : ''}.`);
  }
  return lines;
}

interface SheetText { name: string; rows: number; columns: number; text: string }

/** A sheet's text: its first MAX_SHEET_ROWS rows, tab-separated, and how many more there are. */
function sheetText(name: string, shown: readonly string[][], totalRows: number): SheetText {
  const rows = shown.slice(0, MAX_SHEET_ROWS);
  const lines = [`=== Sheet: ${name} ===`];
  for (const row of rows) lines.push(row.join('\t'));
  if (totalRows > MAX_SHEET_ROWS) lines.push(`[... ${totalRows - MAX_SHEET_ROWS} more rows omitted ...]`);
  return { name, rows: totalRows, columns: rows.reduce((max, row) => Math.max(max, row.length), 0), text: lines.join('\n') };
}

/** Each sheet's values with SheetJS, which reads every row; a string is read as text (HTML, CSV). */
async function readSheets(data: Uint8Array | string): Promise<SheetText[]> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(data, { type: typeof data === 'string' ? 'string' : 'array' });
  return workbook.SheetNames.map((name) => {
    const raw = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: '' }) as unknown[][];
    // A sheet's declared range often runs far past its data: trailing empty
    // cells and rows are left out, so they neither fill the read with tabs nor
    // count in the size the manifest gives.
    const rows = raw.map((row) => {
      const cells = row.map((cell) => String(cell ?? ''));
      let end = cells.length;
      while (end > 0 && cells[end - 1] === '') end--;
      return cells.slice(0, end);
    });
    while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
    return sheetText(name, rows, rows.length);
  });
}

/**
 * The sheets of an .xlsx from its XML, first rows only (sheetRows.ts), so a
 * large workbook takes about a second, not the tens of seconds a full parse
 * would hold the process for. SheetJS reads a workbook this reader cannot.
 */
async function readWorkbookSheets(entries: ZipEntries, manifest: OfficeManifest, bytes: Uint8Array): Promise<SheetText[]> {
  try {
    return readSheetRows(entries, manifest.sheets ?? [], manifest.sharedStrings, MAX_SHEET_ROWS)
      .map((sheet) => sheetText(sheet.name, sheet.rows, sheet.totalRows));
  } catch (err) {
    // SheetJS would build the same oversized rows, so it is not asked.
    if (err instanceof SheetUnreadableError) throw err;
    return readSheets(bytes);
  }
}

/** The text of a read, cut to the read's byte budget, the cut marked with how to read on (`kind`: the Office file it was read from). */
function boundedBody(text: string, kind: OfficeKind | null): string {
  const { text: kept, cut } = cutToJsonBytes(text, READ_TEXT_BYTE_BUDGET);
  if (!cut) return text;
  const rest = kind ? ` To read the rest, run a Python script with ${PYTHON_LIBRARY[kind]}` : '';
  return `${kept}\n[... the text is cut here: one read holds about ${Math.round(READ_TEXT_BYTE_BUDGET / 1000)} KB of text.${rest} ...]`;
}

export function buildDocxResult(manifest: OfficeManifest, holdings: string[]): string {
  const head = manifest.pictures.length || manifest.charts.length
    ? `[Word document. [Image N] and [Chart N] in the text mark where each picture and chart sits.]`
    : '[Word document]';
  const body = manifest.text?.trim() ? boundedBody(manifest.text, 'docx') : '(no text)';
  return `${[head, ...holdings].join('\n')}\n\n${body}`;
}

export function buildXlsxResult(manifest: OfficeManifest, sheets: readonly SheetText[], holdings: string[]): string {
  const info = new Map((manifest.sheets ?? []).map((sheet) => [sheet.name, sheet]));
  const sizes = sheets.map((sheet) => {
    const meta = info.get(sheet.name);
    const flags = [meta?.hidden ? 'hidden' : '', meta?.chartsheet ? 'chart sheet' : ''].filter(Boolean).join(', ');
    const cut = sheet.rows > MAX_SHEET_ROWS
      ? ` (only the first ${MAX_SHEET_ROWS} rows are shown below, ${(sheet.rows - MAX_SHEET_ROWS).toLocaleString('en-US')} more are left out; to read them, run a Python script with openpyxl)`
      : '';
    return `'${sheet.name}'${flags ? ` (${flags})` : ''} ${plural(sheet.rows, 'row')} × ${plural(sheet.columns, 'column')}${cut}`;
  });
  const head = [
    `[Excel workbook: ${plural(sheets.length, 'sheet')}]`,
    `Sheets: ${sizes.join('; ')}.`,
    'Cells are shown as their values; formulas are not shown.',
    ...holdings,
  ];
  return `${head.join('\n')}\n\n${boundedBody(sheets.map((sheet) => sheet.text).join('\n'), 'xlsx')}`;
}

export function buildPptxResult(manifest: OfficeManifest, holdings: string[]): string {
  const slides = manifest.slides ?? [];
  const head = [`[PowerPoint: ${plural(slides.length, 'slide')}. Slides are not rendered; their text is below, with the pictures and charts on each.]`, ...holdings];
  const body: string[] = [];
  slides.forEach((slide, i) => {
    body.push(`=== Slide ${i + 1} ===`);
    const on = [...slide.pictures.map((n) => `Image ${n}`), ...slide.charts.map((n) => `Chart ${n}`)];
    if (on.length) body.push(`[On this slide: ${on.join(', ')}]`);
    body.push(...slide.lines);
  });
  return `${head.join('\n')}\n\n${boundedBody(body.join('\n'), 'pptx')}`;
}

/** Render pictures with the probe; the reason in words when it cannot. */
async function renderPictures(
  filePath: string,
  pictures: readonly OfficePicture[],
  options: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<{ views: OfficeImageProbe['views'] } | { problem: string } | { aborted: true }> {
  const outcome = await runDocumentProbe<OfficeImageProbe>(filePath, 'office-image', { ...options, parts: pictures.map((p) => p.part) }, context);
  switch (outcome.status) {
    case 'ok': return { views: outcome.value.views };
    case 'aborted': return { aborted: true };
    case 'unavailable': return { problem: `the bundled Python could not run: ${outcome.detail}` };
    case 'crashed': return { problem: `the picture renderer stopped: ${outcome.detail}` };
    case 'failed': return { problem: outcome.message || outcome.error };
    case 'tooLarge': return { problem: tooLargeError(getBaseName(filePath), outcome.bytes, outcome.limit).replace(/^Error: /, '') };
  }
}

const isView = (view: OfficeImageProbe['views'][number]): view is ImageViewProbe => !('error' in view);

/** Why a listed item cannot be shown with image_index, or null when it can. */
function notShowable(picture: OfficePicture): string | null {
  const format = picture.format.toUpperCase();
  if (picture.media === 'video') return `Error: Image ${picture.index} is a video (${format}), which cannot be shown: read_file shows pictures only. Say that the file holds a video at ${picture.where.join(', ') || 'this place'}.`;
  if (picture.media === 'audio') return `Error: Image ${picture.index} is a sound (${format}), which cannot be shown: read_file shows pictures only.`;
  if (!picture.renderable) return `Error: Image ${picture.index} is a vector picture (${format}), which cannot be shown.`;
  return null;
}

/** One picture shown with image_index, zoomed or turned when asked. */
async function showPicture(
  filePath: string,
  manifest: OfficeManifest,
  params: DocumentReadParams,
  context?: ToolExecutionContext,
): Promise<DocumentReadOutcome> {
  const fileName = getBaseName(filePath);
  const picture = manifest.pictures.find((p) => p.index === params.imageIndex);
  if (!picture) {
    return { kind: 'done', result: `Error: image_index ${params.imageIndex} does not exist; ${fileName} has ${plural(manifest.pictures.length, 'picture')}.` };
  }
  const refusal = notShowable(picture);
  if (refusal) return { kind: 'done', result: refusal };
  if (context?.supportsVision === false) {
    return { kind: 'done', result: format(getI18n().toolResult.file.imageSkipNoVision, { path: `${filePath} [Image ${picture.index}]`, mediaType: picture.format }) };
  }
  const rendered = await renderPictures(filePath, [picture], { region: params.region, rotate: params.rotate, side: VIEW_SIDE }, context);
  if ('aborted' in rendered) return { kind: 'aborted' };
  if ('problem' in rendered) return { kind: 'done', result: `Error: Image ${picture.index} could not be shown (${rendered.problem}).` };
  const view = rendered.views[0];
  if (!view || !isView(view)) return { kind: 'done', result: `Error: Image ${picture.index} could not be shown (${view && 'error' in view ? view.error : 'no answer'}).` };
  if (!view.img) return { kind: 'done', result: `Error: Image ${picture.index} came out too large to return; ask for a smaller region.` };
  const where = describeView(view.region, view.rotate, 'whole picture');
  const places = picture.where.join(', ');
  const enlarged = enlargedNote(view.zoom, 'picture');
  const text = `[Image ${picture.index} of ${fileName}: ${sizeText(picture)}${places ? `, ${places}` : ''}; ${where}, shown at ${view.img.w}×${view.img.h} px. `
    + `${viewRulerNote('picture')}]${enlarged ? `\n${enlarged}` : ''}`;
  return { kind: 'done', result: withImages(text, labeledImage(`Image ${picture.index} of ${fileName}, ${where}, ${view.img.w}×${view.img.h} px`, view.img)) };
}

/** The pictures a plain read attaches: one or two the body places and can be drawn, for a model that sees. */
async function attachPictures(
  filePath: string,
  manifest: OfficeManifest,
  vision: boolean,
  context?: ToolExecutionContext,
): Promise<{ shown: OfficePicture[]; blocks: ToolResultContent[]; problem?: string } | { aborted: true }> {
  const drawable = bodyPictures(manifest).filter((p) => p.renderable);
  if (!vision || drawable.length === 0 || drawable.length > OFFICE_AUTO_IMAGE_MAX) return { shown: [], blocks: [] };
  const rendered = await renderPictures(filePath, drawable, { side: ATTACH_SIDE }, context);
  if ('aborted' in rendered) return rendered;
  if ('problem' in rendered) return { shown: [], blocks: [], problem: rendered.problem };
  const fileName = getBaseName(filePath);
  const shown: OfficePicture[] = [];
  const blocks: ToolResultContent[] = [];
  drawable.forEach((picture, i) => {
    const view = rendered.views[i];
    if (!view || !isView(view) || !view.img) return;
    shown.push(picture);
    blocks.push(...labeledImage(`Image ${picture.index} of ${fileName}, whole picture, ${view.img.w}×${view.img.h} px`, view.img));
  });
  return shown.length ? { shown, blocks } : { shown, blocks, problem: 'the renderer returned no picture' };
}

// ── Files named .docx, .xlsx or .pptx that hold something else ─────────────────

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** The stream an encrypted (password-protected) Office file keeps its package in, as its OLE directory names it. */
const ENCRYPTED_PACKAGE = new TextEncoder().encode('EncryptedPackage').reduce<number[]>((out, byte) => [...out, byte, 0], []);

/** A zip local header, an empty archive or a spanned one. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8));
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);
}

function contains(bytes: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** The text of a file that holds text, by its byte-order mark, else UTF-8, else GB18030; null for binary content. */
function decodeText(bytes: Uint8Array): string | null {
  const decode = (encoding: string, from: number, fatal = false): string | null => {
    try {
      return new TextDecoder(encoding, { fatal }).decode(bytes.subarray(from));
    } catch {
      return null;
    }
  };
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return decode('utf-8', 3);
  if (startsWith(bytes, [0xff, 0xfe])) return decode('utf-16le', 2);
  if (startsWith(bytes, [0xfe, 0xff])) return decode('utf-16be', 2);
  if (bytes.subarray(0, 8192).includes(0)) return null;
  return decode('utf-8', 0, true) ?? decode('gb18030', 0) ?? decode('utf-8', 0);
}

/** What text a file holds, in words: "an HTML page", "an Excel 2003 XML workbook", "plain text". */
function textKind(text: string): string {
  const head = text.slice(0, 4096).trimStart();
  if (/^\{\\rtf/.test(head)) return 'RTF text';
  if (/urn:schemas-microsoft-com:office:spreadsheet/.test(head)) return 'an Excel 2003 XML workbook';
  if (/<(?:!doctype\s+html|html|table|body)\b/i.test(head)) return 'an HTML page';
  if (/^<\?xml/.test(head)) return 'XML text';
  return 'plain text';
}

/** The words of an HTML page, a block per line. */
function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->|<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|h[1-6]|li|tr|table|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, name: string) => {
      const lower = name.toLowerCase();
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
      if (named[lower]) return named[lower];
      const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .split('\n').map((line) => line.replace(/[ \t]+$/, '').replace(/^[ \t]+(?=\S)/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const OLD_FORMAT: Record<OfficeKind, string> = {
  docx: 'Word 97-2003 (.doc)', xlsx: 'Excel 97-2003 (.xls)', pptx: 'PowerPoint 97-2003 (.ppt)',
};

function kindOf(filePath: string): OfficeKind {
  const ext = getFileExtension(filePath);
  return ext === '.xlsx' ? 'xlsx' : ext === '.pptx' ? 'pptx' : 'docx';
}

/** A file named .docx, .xlsx or .pptx whose bytes are no zip container. */
async function readNonZip(filePath: string, bytes: Uint8Array): Promise<string> {
  const t = getI18n().toolResult.fileRead;
  const kind = kindOf(filePath);
  const ext = `.${kind}`;
  if (bytes.length === 0) return format(t.officeDamaged, { detail: 'the file is empty' });
  if (startsWith(bytes, OLE_MAGIC)) {
    if (contains(bytes, ENCRYPTED_PACKAGE)) return t.officePasswordProtected;
    if (kind !== 'xlsx') return format(t.officeOldFormat, { ext, format: OLD_FORMAT[kind] });
    return spreadsheetOf(bytes, `an ${OLD_FORMAT.xlsx} workbook`);
  }
  const text = decodeText(bytes);
  if (text === null) return format(t.officeDamaged, { detail: 'not a zip container, an older Office file or text' });
  const what = textKind(text);
  if (kind === 'xlsx' && what !== 'RTF text') return spreadsheetOf(text, what === 'plain text' ? 'plain text such as CSV' : what);
  const shown = what === 'an HTML page' ? htmlText(text) : text;
  const name = kind === 'docx' ? 'Word document' : 'PowerPoint file';
  const head = `[Not a ${name} inside: this ${ext} file holds ${what}${what === 'an HTML page' ? ', shown as its text' : ''}. Its pictures, if any, are not read.]`;
  return `${head}\n\n${shown.trim() ? boundedBody(shown, null) : '(no text)'}`;
}

/** A workbook that is no zip container, read as a spreadsheet: values only. */
async function spreadsheetOf(data: Uint8Array | string, what: string): Promise<string> {
  let sheets: SheetText[];
  try {
    sheets = await readSheets(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/password/i.test(message)) return getI18n().toolResult.fileRead.officePasswordProtected;
    return format(getI18n().toolResult.fileRead.officeDamaged, { detail: message });
  }
  const manifest: OfficeManifest = { kind: 'xlsx', pictures: [], charts: [], embeddedObjects: [] };
  return buildXlsxResult(manifest, sheets, [`Not an .xlsx inside: this file holds ${what}, read as a spreadsheet. Pictures and charts are not listed.`]);
}

/**
 * Read a .docx, .xlsx or .pptx: its manifest and text, or, with image_index,
 * one of its pictures.
 */
export async function readOffice(
  filePath: string,
  params: DocumentReadParams,
  context?: ToolExecutionContext,
): Promise<DocumentReadOutcome> {
  if (params.pages) {
    return { kind: 'done', result: 'Error: pages is for PDF files. A read of this file shows all of it; its pictures are numbered for image_index.' };
  }
  if (params.textOffset) {
    return { kind: 'done', result: 'Error: text_offset is for PDF files. A read of this file shows all of it.' };
  }
  if (asksForView(params) && params.imageIndex === null) {
    return { kind: 'done', result: 'Error: region and rotate apply to one picture of this document: pass image_index with the number read_file lists as [Image N].' };
  }
  let bytes: Uint8Array;
  let entries: ZipEntries;
  try {
    bytes = new Uint8Array(await (context?.files?.readFile(filePath) ?? readBinFile(filePath)));
  } catch (err) {
    if (err instanceof FileOperationDenied) throw err;
    return { kind: 'done', result: `Error reading file: ${err instanceof Error ? err.message : String(err)}` };
  }
  // The bytes say what the file is, not its name.
  if (!isZip(bytes)) {
    if (params.imageIndex !== null) {
      return { kind: 'done', result: 'Error: this file is not a zip-based Office document, so it holds no numbered pictures. Read it without image_index.' };
    }
    return { kind: 'done', result: await readNonZip(filePath, bytes) };
  }
  try {
    entries = await unpackOffice(bytes);
  } catch (err) {
    if (err instanceof OfficeTooLargeError) return { kind: 'done', result: officeTooLargeNote(err) };
    return { kind: 'done', result: format(getI18n().toolResult.fileRead.officeDamaged, { detail: err instanceof Error ? err.message : String(err) }) };
  }
  const manifest = readOfficeManifest(entries);
  if (!manifest) return { kind: 'done', result: 'Error: This file is not a Word, Excel or PowerPoint document (no document part inside).' };
  if (params.imageIndex !== null) return showPicture(filePath, manifest, params, context);

  const vision = context?.supportsVision !== false;
  const attached = await attachPictures(filePath, manifest, vision, context);
  if ('aborted' in attached) return { kind: 'aborted' };
  const holdings = holdingsLines(manifest, attached, vision);
  let text: string;
  if (manifest.kind === 'xlsx') {
    let sheets: SheetText[];
    try {
      sheets = await readWorkbookSheets(entries, manifest, bytes);
    } catch (err) {
      return { kind: 'done', result: `Error reading Excel file: ${err instanceof Error ? err.message : String(err)}` };
    }
    text = buildXlsxResult(manifest, sheets, holdings);
  } else {
    text = manifest.kind === 'docx' ? buildDocxResult(manifest, holdings) : buildPptxResult(manifest, holdings);
  }
  return { kind: 'done', result: withImages(text, attached.blocks) };
}
