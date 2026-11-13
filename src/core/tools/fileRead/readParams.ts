/**
 * The optional read_file parameters that look into documents and pictures:
 * `pages` and `text_offset` (PDF).
 *
 * Models pass numbers as strings and objects as JSON text often enough that
 * every parser accepts both.
 */

/** Inclusive page ranges; an open end (`null`) runs to the last page. */
export type PageRanges = Array<[number, number | null]>;

export interface DocumentReadParams {
  pages: PageRanges | null;
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

/** Every document parameter of one read_file call, or the first one that cannot be used. */
export function parseDocumentReadParams(input: Record<string, unknown>): Parsed<DocumentReadParams> {
  const pages = parsePages(input.pages);
  if (isError(pages)) return pages;
  const textOffset = parseTextOffset(input.text_offset);
  if (isError(textOffset)) return textOffset;
  return { pages, textOffset };
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
