import type { ZipEntries } from './officeManifest';
import { parseXml } from './officeXml';

/**
 * The first rows of each worksheet of an .xlsx, read straight from its XML.
 *
 * A read shows at most a few hundred rows a sheet, and parsing a whole
 * workbook with SheetJS to get them blocks the process for as long as the
 * workbook is large (about 20 s for a 10 MB ledger on a busy machine, longer
 * than the desktop's sidecar heartbeat allows). This reader streams each
 * sheet's XML through the XML parser (officeXml.ts), keeps its first rows,
 * and notes the last row that holds a value, so it never builds the rest.
 *
 * XML it does not recognise (a part that is not a worksheet, a cell type it
 * has no rule for) throws `SheetStructureError`; the caller hands the
 * workbook to SheetJS instead of showing a partial read.
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

/** A part this reader does not recognise; another reader can still read the workbook. */
export class SheetStructureError extends Error {
  constructor(part: string, reason: string) {
    super(`${part}: ${reason}`);
    this.name = 'SheetStructureError';
  }
}

class Overflow extends Error {}

/** `_x000D_` and the like: characters OOXML strings escape. */
function unescapeOoxml(text: string): string {
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** "AB" → 27 (0-based); a column past Excel's last (XFD) is refused. */
function columnIndex(letters: string): number {
  if (letters.length > 3) throw new Overflow(`a cell reference ("${letters.slice(0, 8)}...") lies beyond Excel's last column (XFD)`);
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  if (index - 1 > MAX_COLUMN) throw new Overflow(`a cell reference ("${letters}") lies beyond Excel's last column (XFD)`);
  return index - 1;
}

/** The strings of a shared string table, by index. Phonetic guides (`rPh`) are left out of a string's text. */
function readSharedStrings(bytes: Uint8Array | undefined, part: string): string[] {
  const strings: string[] = [];
  if (!bytes) return strings;
  let root = '';
  let depth = 0;
  let item: string | null = null;
  let inText = 0;
  let inPhonetic = 0;
  parseXml(decoder.decode(bytes), {
    open(name) {
      if (depth++ === 0) root = name;
      else if (name === 'si') item = '';
      else if (name === 'rPh') inPhonetic++;
      else if (name === 't' && item !== null) inText++;
    },
    text(data) {
      if (item !== null && inText && !inPhonetic) item += data;
    },
    close(name) {
      depth--;
      if (name === 'si' && item !== null) {
        strings.push(unescapeOoxml(item));
        item = null;
      } else if (name === 'rPh') inPhonetic--;
      else if (name === 't' && item !== null) inText--;
    },
  });
  if (root !== 'sst') throw new SheetStructureError(part, 'not a shared string table');
  return strings;
}

/** What one cell of a worksheet shows, as SheetJS gives it with `raw`. */
function cellValue(type: string | undefined, v: string | undefined, inline: string | undefined, strings: readonly string[], part: string): string {
  switch (type) {
    case 'inlineStr': return inline === undefined ? '' : unescapeOoxml(inline);
    case 's': return v === undefined ? '' : (strings[Number(v)] ?? '');
    case 'b': return v === undefined ? '' : v === '1' ? 'TRUE' : 'FALSE';
    case 'str': case 'e': case 'd': return v === undefined ? '' : unescapeOoxml(v);
    case undefined: case 'n': {
      if (v === undefined) return '';
      const number = Number(v);
      return v.trim() !== '' && Number.isFinite(number) ? String(number) : v;
    }
    default: throw new SheetStructureError(part, `a cell of type "${type}" has no rule here`);
  }
}

function readSheet(
  bytes: Uint8Array | undefined,
  part: string,
  strings: readonly string[],
  maxRows: number,
  budget: { left: number },
): Omit<SheetRows, 'name'> {
  if (!bytes) return { rows: [], totalRows: 0 };
  const rows: string[][] = [];
  // Rows above the first one that holds a value are not part of the read: a sheet whose data starts at
  // row 600 shows its first rows, and the cut counts from there. `base` is the number of the row above it.
  let base = 0;
  let started = false;
  let done = false;
  let previous = 0;
  let lastValueRow = 0;
  let root = '';
  let depth = 0;
  let inSheetData = false;

  // The row being read.
  let rowNumber = 0;
  let rowCells: string[] = [];
  let rowHasValue = false;
  let building = false;
  let next = 0;
  // The cell being read.
  let cell: { type?: string; column: number } | null = null;
  let v: string | undefined;
  let inline: string | undefined;
  let inV = false;
  let inInline = false;
  let inText = 0;
  let inPhonetic = 0;

  parseXml(decoder.decode(bytes), {
    open(name, attributes) {
      if (depth++ === 0) {
        root = name;
        if (!root.endsWith('sheet')) throw new SheetStructureError(part, 'not a worksheet');
        return;
      }
      if (name === 'sheetData') inSheetData = true;
      else if (!inSheetData) return;
      else if (name === 'row') {
        if (cell) throw new SheetStructureError(part, 'a row opens inside a cell');
        const given = Number(attributes.r);
        rowNumber = Number.isInteger(given) && given > previous ? given : previous + 1;
        previous = rowNumber;
        rowCells = [];
        rowHasValue = false;
        next = 0;
        building = !done && rows.length < maxRows;
      } else if (name === 'c') {
        if (cell) throw new SheetStructureError(part, 'a cell opens inside another cell');
        const reference = /^([A-Z]+)\d*$/.exec(attributes.r ?? '')?.[1];
        cell = { type: attributes.t, column: building ? (reference ? columnIndex(reference) : next) : 0 };
        v = undefined;
        inline = undefined;
      } else if (name === 'v' && cell) {
        inV = true;
        rowHasValue = true;
        v = '';
      } else if (name === 'is' && cell) {
        inInline = true;
        rowHasValue = true;
        inline = '';
      } else if (inInline && name === 'rPh') inPhonetic++;
      else if (inInline && name === 't') inText++;
    },
    text(data) {
      if (inV) v = (v ?? '') + data;
      else if (inInline && inText && !inPhonetic) inline = (inline ?? '') + data;
    },
    close(name) {
      depth--;
      if (!inSheetData) return;
      if (name === 'sheetData') inSheetData = false;
      else if (name === 'v') inV = false;
      else if (name === 'is') inInline = false;
      else if (name === 'rPh' && inInline) inPhonetic--;
      else if (name === 't' && inInline) inText--;
      else if (name === 'c' && cell) {
        if (building) {
          const value = cellValue(cell.type, v, inline, strings, part);
          const column = cell.column;
          next = column + 1;
          budget.left -= 1 + Math.max(0, column + 1 - rowCells.length);
          if (budget.left < 0) throw new Overflow('it holds more cells than a read can build');
          while (rowCells.length < column) rowCells.push('');
          rowCells[column] = value;
        }
        cell = null;
      } else if (name === 'row') {
        if (rowHasValue) lastValueRow = rowNumber;
        if (!building) return;
        let end = rowCells.length;
        while (end > 0 && rowCells[end - 1] === '') end--;
        const cells = rowCells.slice(0, end);
        // Still above the data (an empty or only formatted row).
        if (!started && cells.length === 0) return;
        if (!started) { started = true; base = rowNumber - 1; }
        if (rowNumber - base > maxRows) { done = true; return; }
        while (rows.length < rowNumber - base - 1) rows.push([]);
        rows.push(cells);
      }
    },
  });
  if (!root) throw new SheetStructureError(part, 'no XML found');
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return { rows, totalRows: Math.max(rows.length, Math.max(0, lastValueRow - base)) };
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
  const strings = readSharedStrings(sharedStringsPart ? entries[sharedStringsPart] : undefined, sharedStringsPart ?? '');
  const budget = { left: MAX_BUILT_CELLS };
  return sheets.map((sheet) => {
    try {
      return { name: sheet.name, ...readSheet(sheet.part ? entries[sheet.part] : undefined, sheet.part ?? '', strings, maxRows, budget) };
    } catch (err) {
      if (err instanceof Overflow) throw new SheetUnreadableError(sheet.name, err.message);
      throw err;
    }
  });
}
