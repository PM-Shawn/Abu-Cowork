import type { Region } from './documentProbe';

/**
 * The optional read_file parameters that look into documents and pictures:
 * `pages` and `text_offset` (PDF), `region` and `rotate` (a PDF page or a picture), and
 * `image_index` (a picture embedded in a Word, Excel or PowerPoint file).
 *
 * Models pass numbers as strings and objects as JSON text often enough that
 * every parser accepts both.
 */

/** Inclusive page ranges; an open end (`null`) runs to the last page. */
export type PageRanges = Array<[number, number | null]>;

export type Rotation = 0 | 90 | 180 | 270;

export interface DocumentReadParams {
  pages: PageRanges | null;
  region: Region | null;
  rotate: Rotation;
  imageIndex: number | null;
  /** Characters of the first page's text to skip: reads on from where the last read of a long page stopped. */
  textOffset: number;
}

type Parsed<T> = T | { error: string };

function isError<T>(value: Parsed<T>): value is { error: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'error' in value;
}

/** "18", "3-5", "2,5", "10-" or a number. */
export function parsePages(spec: unknown): Parsed<PageRanges | null> {
  if (spec === undefined || spec === null || spec === '') return null;
  if (typeof spec === 'number') {
    return Number.isInteger(spec) && spec >= 1 ? [[spec, spec]] : { error: `pages must be a page number of 1 or more, got ${spec}` };
  }
  if (typeof spec !== 'string') return { error: 'pages must be a string such as "18", "3-5" or "2,5"' };
  const ranges: PageRanges = [];
  for (const raw of spec.split(/[,，]/)) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(\d+)(?:\s*[-–~]\s*(\d*))?$/.exec(part);
    if (!match) return { error: `pages could not be read at "${part}"; use forms like "18", "3-5", "2,5" or "10-"` };
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : match[2] === '' ? null : Number(match[2]);
    if (start < 1 || (end !== null && end < start)) return { error: `pages has an empty range at "${part}"` };
    ranges.push([start, end]);
  }
  return ranges.length ? ranges : { error: 'pages names no page' };
}

const REGION_FORM = 'region must be {"x0": …, "y0": …, "x1": …, "y1": …}, fractions of the page or picture from its top-left corner';

/** {x0, y0, x1, y1} (or [x0, y0, x1, y1]): fractions 0–1 of the page or picture, top-left origin. */
export function parseRegion(raw: unknown): Parsed<Region | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  let values: unknown[];
  if (typeof raw === 'string') {
    try {
      return parseRegion(JSON.parse(raw));
    } catch {
      return { error: REGION_FORM };
    }
  }
  if (Array.isArray(raw)) values = raw;
  else if (typeof raw === 'object') {
    const box = raw as Record<string, unknown>;
    values = [box.x0, box.y0, box.x1, box.y1];
  } else {
    return { error: REGION_FORM };
  }
  const numbers = values.map((value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value));
  if (numbers.length !== 4 || numbers.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return { error: `${REGION_FORM}; four numbers are needed` };
  }
  const [x0, y0, x1, y1] = numbers as number[];
  if ([x0, y0, x1, y1].some((value) => value < 0 || value > 1)) {
    return { error: 'region values are fractions between 0 and 1, as on the rulers of page images (not pixels or points)' };
  }
  if (x1 - x0 < 0.005 || y1 - y0 < 0.005) {
    return { error: 'region is empty: x1 must be greater than x0 and y1 greater than y0' };
  }
  return [x0, y0, x1, y1];
}

/** Degrees clockwise. */
export function parseRotation(raw: unknown): Parsed<Rotation> {
  if (raw === undefined || raw === null || raw === '') return 0;
  const value = Number(raw);
  const turned = value === -90 ? 270 : value === 360 ? 0 : value;
  if (turned === 0 || turned === 90 || turned === 180 || turned === 270) return turned;
  return { error: 'rotate must be 0, 90, 180 or 270 (degrees clockwise)' };
}

export function parseImageIndex(raw: unknown): Parsed<number | null> {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return { error: 'image_index must be a picture number of 1 or more, as listed by read_file ([Image N])' };
  return value;
}

/** Every document parameter of one read_file call, or the first one that cannot be used. */
export function parseDocumentReadParams(input: Record<string, unknown>): Parsed<DocumentReadParams> {
  const pages = parsePages(input.pages);
  if (isError(pages)) return pages;
  const region = parseRegion(input.region);
  if (isError(region)) return region;
  const rotate = parseRotation(input.rotate);
  if (isError(rotate)) return rotate;
  const imageIndex = parseImageIndex(input.image_index);
  if (isError(imageIndex)) return imageIndex;
  const textOffset = parseTextOffset(input.text_offset);
  if (isError(textOffset)) return textOffset;
  return { pages, region, rotate, imageIndex, textOffset };
}

/** Whether a call asks for a closer view (a region or a turn) rather than a plain read. */
export function asksForView(params: Pick<DocumentReadParams, 'region' | 'rotate'>): boolean {
  return params.region !== null || params.rotate !== 0;
}

/** The single page `pages` names, or null when it names none or several. */
export function singlePage(ranges: PageRanges | null): number | null {
  if (!ranges || ranges.length !== 1) return null;
  const [start, end] = ranges[0];
  return end === start ? start : null;
}

/** "100000" or a number: a count of characters, 0 or more. */
export function parseTextOffset(spec: unknown): Parsed<number> {
  if (spec === undefined || spec === null || spec === '') return 0;
  const value = typeof spec === 'string' && /^\s*\d+\s*$/.test(spec) ? Number(spec) : spec;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : { error: `text_offset must be a number of characters, 0 or more, got ${JSON.stringify(spec)}` };
}

/** "1–6, 9, 12–14" */
export function formatPageList(pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j === i ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/** A pages argument naming exactly these pages: "3,7,9", "1-3,5" (runs folded; pages apart stay apart). */
export function pagesArgument(pages: readonly number[]): string {
  return formatPageList(pages).replace(/–/g, '-').replace(/ /g, '');
}

/**
 * Bytes of document text one read returns, counted the way conversation
 * history counts a tool result: the UTF-8 bytes of its JSON form
 * (`DURABLE_TOOL_RESULT_MAX_RESULT_BYTES`, 256 KB), where a quote, a backslash
 * or a line break takes two. A read under this budget, with its manifest,
 * stays whole when the conversation is opened again. Chinese text takes three
 * bytes a character, so a character count alone would not keep it under.
 */
export const READ_TEXT_BYTE_BUDGET = 200_000;

const fraction = (value: number) => value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');

/** "turned 90° clockwise, region x 0.5–1, y 0.6–1", or "whole page": the turn comes first, the region is on the turned page. */
export function describeView(region: Region, rotate: number, whole: string): string {
  const [x0, y0, x1, y1] = region;
  const all = x0 <= 0 && y0 <= 0 && x1 >= 1 && y1 >= 1;
  const part = all ? whole : `region x ${fraction(x0)}–${fraction(x1)}, y ${fraction(y0)}–${fraction(y1)}`;
  return rotate ? `turned ${rotate}° clockwise, ${part}` : part;
}

/** How to turn sideways content, for manifests and tool descriptions. */
export const TURN_HINT = 'For sideways or upside-down content add rotate, the degrees to turn it clockwise: 270 when it lies turned a quarter clockwise (the tops of its letters face right), 90 when turned a quarter counter-clockwise (tops face left), 180 when upside down. The image is turned first and region is given on the turned image, as its rulers show: to zoom into content you have seen only unturned, call with rotate alone first.';

/** A view that enlarges a scan's or a picture's own pixels this many times or more says so. */
export const ENLARGED_NOTE_AT = 3;

/**
 * The note of a view enlarged past the pixels it was made from: a smaller
 * region only spreads the same pixels wider, so a character still unclear
 * here stays unclear. Empty below ENLARGED_NOTE_AT.
 */
export function enlargedNote(zoom: number | null | undefined, what: 'scan' | 'picture'): string {
  if (!zoom || zoom < ENLARGED_NOTE_AT) return '';
  return `This view enlarges the ${what}'s own pixels about ${Math.round(zoom)} times: a smaller region shows no more detail, only more blur. Read what is legible at this size, and if a character stays unclear, say which one instead of zooming further.`;
}

/** The ruler note of a zoomed or turned view. */
export function viewRulerNote(what: 'page' | 'picture'): string {
  return `The rulers give fractions of the whole ${what} as shown here (x along the top, y down the side); read a closer region off them, keeping the same rotate.`;
}

/** UTF-8 bytes `unit` (a UTF-16 code unit) takes inside a JSON string; a surrogate is counted per pair by the caller. */
function jsonBytesOf(code: number): number {
  if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) return 2;
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3;
}

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes of its JSON string form (what
 * `JSON.stringify` writes, quotes around it left out), between characters.
 */
export function cutToJsonBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (text.length * 6 <= maxBytes) return { text, cut: false };
  let bytes = 0;
  for (let at = 0; at < text.length;) {
    const code = text.charCodeAt(at);
    const next = text.charCodeAt(at + 1);
    let width = 1;
    let cost: number;
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      width = 2;
      cost = 4;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      cost = 6; // a lone surrogate is written as \uXXXX
    } else {
      cost = jsonBytesOf(code);
    }
    if (bytes + cost > maxBytes) return { text: text.slice(0, at), cut: true };
    bytes += cost;
    at += width;
  }
  return { text, cut: false };
}
