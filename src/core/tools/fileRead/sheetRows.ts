import { decodeXml, type ZipEntries } from './officeManifest';

/**
 * The first rows of each worksheet of an .xlsx, read straight from its XML.
 *
 * A read shows at most a few hundred rows a sheet, and parsing a whole
 * workbook with SheetJS to get them blocks the process for as long as the
 * workbook is large (about 20 s for a 10 MB ledger on a busy machine, longer
 * than the desktop's sidecar heartbeat allows). This reader decodes each
 * sheet's XML, parses its first rows, finds its last row that holds a value,
 * and looks up only the shared strings those rows use.
 *
 * Values are as SheetJS gives them with `raw`: numbers as stored (dates as
 * their serial numbers), strings, `TRUE`/`FALSE`, error codes. Columns count
 * from A, rows count from the first one that holds a value, so
 * a sheet whose data starts at row 600 is read from there, where SheetJS's
 * `!ref` would start at A1 for a dimension of A1:... and show only blank rows.
 */

export interface SheetRows {
  name: string;
  /** The first rows, trailing empty cells left out. */
  rows: string[][];
  /** The number of the last row that holds a value (0 for an empty sheet). */
  totalRows: number;
}

const decoder = new TextDecoder();

/** Excel's last column, XFD (0-based). A cell reference past it cannot come from a real workbook. */
const MAX_COLUMN = 16383;
/** Cells (and the empty cells between them) one call may build over all the sheets it reads. */
const MAX_BUILT_CELLS = 5_000_000;

/**
 * A sheet whose XML asks for more than a read can build (a cell far past
 * Excel's last column, or millions of cells in the first rows). It is not
 * handed on to another reader, which would build the same rows.
 */
export class SheetUnreadableError extends Error {
  constructor(sheet: string, reason: string) {
    super(`The sheet "${sheet}" could not be read: ${reason}.`);
    this.name = 'SheetUnreadableError';
  }
}

class Overflow extends Error {}

/** `_x000D_` and the like: characters OOXML strings escape. */
function unescapeOoxml(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The text of a string item (`<si>`, `<is>`): its `<t>` runs, phonetic guides left out. */
function itemText(item: string, p: string): string {
  const withoutPhonetic = item.replace(new RegExp(`<${p}rPh\\b[\\s\\S]*?</${p}rPh>`, 'g'), '');
  let text = '';
  for (const match of withoutPhonetic.matchAll(new RegExp(`<${p}t(?:\\s[^>]*)?>([^<]*)</${p}t>`, 'g'))) text += match[1];
  return unescapeOoxml(decodeXml(text));
}

/** "AB" → 27 (0-based); a column past Excel's last (XFD) is refused. */
function columnIndex(letters: string): number {
  if (letters.length > 3) throw new Overflow(`a cell reference ("${letters.slice(0, 8)}...") lies beyond Excel's last column (XFD)`);
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  if (index - 1 > MAX_COLUMN) throw new Overflow(`a cell reference ("${letters}") lies beyond Excel's last column (XFD)`);
  return index - 1;
}

/** A search for `needle` that remembers its last answer: for starts that only grow, it scans each stretch of `text` once. */
function forwardFinder(text: string, needle: string): (from: number) => number {
  let found = -2;
  return (from) => {
    if (found === -1) return -1;
    if (found < from) found = text.indexOf(needle, from);
    return found;
  };
}

/** Where the next cell element opens at or after `from`, or -1. */
function nextCellOpen(row: string, open: string, from: number): number {
  for (let at = row.indexOf(open, from); at >= 0; at = row.indexOf(open, at + 1)) {
    const after = row.charCodeAt(at + open.length);
    if (after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13) return at;
  }
  return -1;
}

class SharedStrings {
  private readonly text: string;
  private readonly prefix: string;
  private readonly starts: number[] = [];
  private readonly cache = new Map<number, string>();

  constructor(bytes: Uint8Array | undefined) {
    this.text = bytes ? decoder.decode(bytes) : '';
    this.prefix = /<([\w.-]+:)?sst\b/.exec(this.text)?.[1] ?? '';
    const open = `<${this.prefix}si`;
    // Every item counts, a self-closing `<si/>` (an empty string) included: the cell's index is the item's place.
    for (let at = this.text.indexOf(open); at >= 0; at = this.text.indexOf(open, at + open.length)) {
      const after = this.text.charCodeAt(at + open.length);
      if (after === 62 || after === 47 || after === 32 || after === 9 || after === 10 || after === 13) this.starts.push(at);
    }
  }

  get(index: number): string {
    const cached = this.cache.get(index);
    if (cached !== undefined) return cached;
    const start = this.starts[index];
    if (start === undefined) return '';
    const tagEnd = this.text.indexOf('>', start);
    if (tagEnd < 0 || this.text.charCodeAt(tagEnd - 1) === 47) {
      this.cache.set(index, '');
      return '';
    }
    const end = this.text.indexOf(`</${this.prefix}si>`, start);
    const value = itemText(this.text.slice(start, end < 0 ? undefined : end), this.prefix);
    this.cache.set(index, value);
    return value;
  }
}

/** One cell's value as shown. */
function cellValue(type: string | undefined, body: string, p: string, strings: SharedStrings): string {
  if (type === 'inlineStr') {
    const item = new RegExp(`<${p}is>([\\s\\S]*?)</${p}is>`).exec(body)?.[1];
    return item === undefined ? '' : itemText(item, p);
  }
  const raw = new RegExp(`<${p}v(?:\\s[^>]*)?>([^<]*)</${p}v>`).exec(body)?.[1];
  if (raw === undefined) return '';
  const value = decodeXml(raw);
  switch (type) {
    case 's': return strings.get(Number(value));
    case 'b': return value === '1' ? 'TRUE' : 'FALSE';
    case 'str': case 'e': case 'd': return unescapeOoxml(value);
    default: {
      const number = Number(value);
      return value.trim() !== '' && Number.isFinite(number) ? String(number) : value;
    }
  }
}

/**
 * The cells of one `<row>`, by column. The row is scanned once, left to right:
 * a cell ends at its own closing tag or where the next cell opens, so a
 * malformed row costs time in proportion to its length.
 */
function rowCells(row: string, p: string, strings: SharedStrings, budget: { left: number }): string[] {
  const cells: string[] = [];
  const open = `<${p}c`;
  const closeTag = `</${p}c>`;
  const findTagEnd = forwardFinder(row, '>');
  const findClose = forwardFinder(row, closeTag);
  let next = 0;
  for (let at = nextCellOpen(row, open, 0); at >= 0;) {
    const following = nextCellOpen(row, open, at + open.length);
    const limit = following < 0 ? row.length : following;
    const tagEnd = findTagEnd(at + open.length);
    if (tagEnd < 0 || tagEnd >= limit) { at = following; continue; } // a start tag that never ends: skipped
    const attributes = row.slice(at + open.length, tagEnd);
    let value = '';
    if (!attributes.endsWith('/')) {
      const close = findClose(tagEnd + 1);
      const bodyEnd = close >= 0 && close < limit ? close : limit;
      value = cellValue(/\st="(\w+)"/.exec(attributes)?.[1], row.slice(tagEnd + 1, bodyEnd), p, strings);
    }
    const reference = /\sr="([A-Z]+)\d*"/.exec(attributes)?.[1];
    const column = reference ? columnIndex(reference) : next;
    next = column + 1;
    budget.left -= 1 + Math.max(0, column + 1 - cells.length);
    if (budget.left < 0) throw new Overflow('it holds more cells than a read can build');
    while (cells.length < column) cells.push('');
    cells[column] = value;
    at = following;
  }
  let end = cells.length;
  while (end > 0 && cells[end - 1] === '') end--;
  return cells.slice(0, end);
}

/** The row number a `<row>` names, or the one after `previous`. */
function rowNumber(tag: string, previous: number): number {
  const number = Number(/\sr="(\d+)"/.exec(tag)?.[1]);
  return Number.isInteger(number) && number > previous ? number : previous + 1;
}

/** Whether a `<row>` holds a value: a cell with `<v>` or an inline string. */
function holdsValue(row: string, p: string): boolean {
  return row.includes(`<${p}v>`) || row.includes(`<${p}v `) || row.includes(`<${p}is>`);
}

function readSheet(bytes: Uint8Array | undefined, strings: SharedStrings, maxRows: number, budget: { left: number }): Omit<SheetRows, 'name'> {
  if (!bytes) return { rows: [], totalRows: 0 };
  const text = decoder.decode(bytes);
  const head = /<([\w.-]+:)?sheetData\b[^>]*?(\/?)>/.exec(text);
  if (!head || head[2] === '/') return { rows: [], totalRows: 0 };
  const p = head[1] ?? '';
  const start = head.index + head[0].length;
  const close = text.indexOf(`</${p}sheetData>`, start);
  const end = close < 0 ? text.length : close;
  const openRow = `<${p}row`;
  const rows: string[][] = [];
  let at = text.indexOf(openRow, start);
  let previous = 0;
  // Rows above the first one that holds a value are not part of the read: a sheet whose data starts at
  // row 600 shows its first rows, and the cut counts from there. `base` is the number of the row above it.
  let base = 0;
  let started = false;
  while (at >= 0 && at < end && rows.length < maxRows) {
    const tagEnd = text.indexOf('>', at);
    if (tagEnd < 0) break;
    const tag = text.slice(at, tagEnd + 1);
    const number = rowNumber(tag, previous);
    const selfClosing = tag.endsWith('/>');
    const rowEnd = selfClosing ? tagEnd + 1 : text.indexOf(`</${p}row>`, tagEnd);
    const body = selfClosing ? '' : text.slice(tagEnd + 1, rowEnd < 0 ? end : rowEnd);
    const cells = rowCells(body, p, strings, budget);
    if (!started && cells.length === 0) {
      // Still above the data (an empty or only formatted row).
      previous = number;
      at = rowEnd < 0 ? -1 : text.indexOf(openRow, rowEnd);
      continue;
    }
    if (!started) { started = true; base = number - 1; }
    if (number - base > maxRows) break;
    while (rows.length < number - base - 1) rows.push([]);
    rows.push(cells);
    previous = number;
    at = rowEnd < 0 ? -1 : text.indexOf(openRow, rowEnd);
  }
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return { rows, totalRows: Math.max(rows.length, Math.max(0, lastValueRow(text, start, end, p) - base)) };
}

/** The number of the last row between `start` and `end` that holds a value, found from the end. */
function lastValueRow(text: string, start: number, end: number, p: string): number {
  const openRow = `<${p}row`;
  for (let from = end; from > start;) {
    const last = text.lastIndexOf(openRow, from - 1);
    if (last < start) return 0;
    if (holdsValue(text.slice(last, from), p)) {
      const number = Number(/\sr="(\d+)"/.exec(text.slice(last, text.indexOf('>', last) + 1))?.[1]);
      if (Number.isInteger(number) && number > 0) return number;
      // Rows without numbers are numbered by their place.
      let count = 0;
      for (let at = text.indexOf(openRow, start); at >= 0 && at <= last; at = text.indexOf(openRow, at + openRow.length)) count++;
      return count;
    }
    from = last;
  }
  return 0;
}

/**
 * The first `maxRows` rows of each sheet, in workbook order. A chart sheet,
 * or a sheet whose part is missing, comes back empty.
 */
export function readSheetRows(
  entries: ZipEntries,
  sheets: ReadonlyArray<{ name: string; part?: string }>,
  sharedStringsPart: string | undefined,
  maxRows: number,
): SheetRows[] {
  const strings = new SharedStrings(sharedStringsPart ? entries[sharedStringsPart] : undefined);
  const budget = { left: MAX_BUILT_CELLS };
  return sheets.map((sheet) => {
    try {
      return { name: sheet.name, ...readSheet(sheet.part ? entries[sheet.part] : undefined, strings, maxRows, budget) };
    } catch (err) {
      if (err instanceof Overflow) throw new SheetUnreadableError(sheet.name, err.message);
      throw err;
    }
  });
}
