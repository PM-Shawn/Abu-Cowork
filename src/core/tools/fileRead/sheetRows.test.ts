import { describe, it, expect } from 'vitest';
import { strToU8, unzipSync } from 'fflate';
import * as XLSX from 'xlsx';
import { readOfficeManifest } from './officeManifest';
import { readSheetRows, SheetStructureError } from './sheetRows';
import { zipSync } from 'fflate';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** One worksheet part and its shared strings, read as the reader reads them. */
function read(sheetXml: string, sharedStrings?: string, maxRows = 500) {
  const entries = {
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    ...(sharedStrings ? { 'xl/sharedStrings.xml': strToU8(sharedStrings) } : {}),
  };
  return readSheetRows(entries, [{ name: 'S', part: 'xl/worksheets/sheet1.xml' }], sharedStrings ? 'xl/sharedStrings.xml' : undefined, maxRows)[0];
}

const sheet = (rows: string, prefix = '') => {
  const p = prefix ? `${prefix}:` : '';
  return `<?xml version="1.0"?><${p}worksheet xmlns${prefix ? `:${prefix}` : ''}="${MAIN}"><${p}dimension ref="A1:Z9999"/><${p}sheetData>${rows}</${p}sheetData></${p}worksheet>`;
};

describe('readSheetRows', () => {
  it('reads shared, rich and inline strings, numbers, booleans and errors as SheetJS shows them raw', () => {
    const strings = `<sst xmlns="${MAIN}"><si><t>区域</t></si><si><r><t>华</t></r><r><rPr><b/></rPr><t xml:space="preserve">东 </t></r><rPh><t>かとう</t></rPh></si><si><t>A&amp;B_x000D_</t></si></sst>`;
    const result = read(sheet(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c><c r="C1" t="s"><v>2</v></c></row>'
      + '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1.1000000000000001</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="e"><v>#DIV/0!</v></c><c r="E2" s="3"><v>46023</v></c><c r="F2" t="str"><f>A1&amp;"x"</f><v>区域x</v></c></row>',
    ), strings);
    expect(result).toEqual({
      name: 'S',
      rows: [['区域', '金额', 'A&B\r'], ['华东 ', '1.1', 'TRUE', '#DIV/0!', '46023', '区域x']],
      totalRows: 2,
    });
  });

  it('keeps columns and rows in their places from the first row with data: a gap is an empty cell or an empty row', () => {
    const result = read(sheet('<row r="2"><c r="C2" t="inlineStr"><is><t>c</t></is></c><c r="A2"/></row><row r="4"><c r="B4"><v>7</v></c></row>'));
    expect(result.rows).toEqual([['', '', 'c'], [], ['', '7']]);
    expect(result.totalRows).toBe(3);
  });

  it('counts rows to the last one that holds a value, past the rows it shows, and not the formatted rows after it', () => {
    const rows = Array.from({ length: 700 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('')
      + '<row r="701" s="2" customFormat="1"/><row r="1048576" s="2" customFormat="1"><c r="A1048576" s="2"/></row>';
    const result = read(sheet(rows), undefined, 500);
    expect(result.rows).toHaveLength(500);
    expect(result.rows[499]).toEqual(['499']);
    expect(result.totalRows).toBe(700);
  });

  it('reads a sheet whose data starts far down: leading empty rows are not part of the read (data from row 600)', () => {
    const data = [600, 601, 602].map((n) => `<row r="${n}"><c r="A${n}"><v>${n}</v></c></row>`).join('');
    const declared = (ref: string) => `<?xml version="1.0"?><worksheet xmlns="${MAIN}"><dimension ref="${ref}"/><sheetData>${data}</sheetData></worksheet>`;
    for (const ref of ['A600:A602', 'A1:A602']) {
      expect(read(declared(ref))).toEqual({ name: 'S', rows: [['600'], ['601'], ['602']], totalRows: 3 });
    }
  });

  it('skips styled empty rows above the data, and counts the cut from the first row with data', () => {
    const empties = Array.from({ length: 800 }, (_, i) => `<row r="${i + 1}" s="1" customFormat="1"/>`).join('');
    const data = Array.from({ length: 700 }, (_, i) => `<row r="${801 + i}"><c r="A${801 + i}"><v>${i}</v></c></row>`).join('');
    const result = read(sheet(empties + data), undefined, 500);
    expect(result.rows).toHaveLength(500);
    expect(result.rows[0]).toEqual(['0']);
    expect(result.rows[499]).toEqual(['499']);
    expect(result.totalRows).toBe(700);
  });

  it('keeps a gap between rows with data as empty rows', () => {
    const result = read(sheet('<row r="5"><c r="A5"><v>1</v></c></row><row r="7"><c r="A7"><v>2</v></c></row>'));
    expect(result.rows).toEqual([['1'], [], ['2']]);
    expect(result.totalRows).toBe(3);
  });

  it('does not let a self-closing shared string shift the ones after it', () => {
    const strings = `<sst xmlns="${MAIN}"><si><t>a</t></si><si/><si><t>c</t></si><si /><si><t>e</t></si></sst>`;
    const result = read(sheet('<row r="1"><c r="A1" t="s"><v>2</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>4</v></c></row>'), strings);
    expect(result.rows).toEqual([['c', '', 'e']]);
  });

  it('reads a sheet whose producer prefixes the namespace, and rows and cells without numbers', () => {
    const result = read(sheet('<x:row><x:c t="inlineStr"><x:is><x:t>a</x:t></x:is></x:c><x:c><x:v>2</x:v></x:c></x:row><x:row><x:c><x:v>3</x:v></x:c></x:row>', 'x'));
    expect(result.rows).toEqual([['a', '2'], ['3']]);
    expect(result.totalRows).toBe(2);
  });

  it('gives an empty sheet, a chart sheet and a missing part no rows', () => {
    expect(read(sheet('')).totalRows).toBe(0);
    expect(read(`<worksheet xmlns="${MAIN}"><sheetData/></worksheet>`)).toEqual({ name: 'S', rows: [], totalRows: 0 });
    expect(read(sheet('<row r="1" s="1"/><row r="2"><c r="A2" s="1"/></row>'))).toEqual({ name: 'S', rows: [], totalRows: 0 });
    expect(readSheetRows({}, [{ name: 'Chart1' }], undefined, 500)).toEqual([{ name: 'Chart1', rows: [], totalRows: 0 }]);
  });

  it('matches SheetJS on a workbook SheetJS wrote, shared strings and all', () => {
    const data = [['名称', '数量', '单价', '备注'], ['甲', 3, 1.5, ''], ['乙', 0, -2, '退货'], [], ['丙', 1e21, 0.1 + 0.2, 'x']];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), '表');
    for (const bookSST of [false, true]) {
      const bytes = new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx', bookSST }) as ArrayBuffer);
      const entries = unzipSync(bytes);
      const manifest = readOfficeManifest(entries)!;
      const [ours] = readSheetRows(entries, manifest.sheets!, manifest.sharedStrings, 500);
      const theirs = (XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(bytes, { type: 'array' }).Sheets['表'], { header: 1, defval: '' }) as unknown[][])
        .map((row) => {
          const cells = row.map((cell) => String(cell ?? ''));
          while (cells.length && cells[cells.length - 1] === '') cells.pop();
          return cells;
        });
      expect(ours.rows).toEqual(theirs);
      expect(ours.totalRows).toBe(5);
    }
  });
});

describe('readSheetRows on a workbook SheetJS wrote, with its XML rewritten another valid way', () => {
  const bytes = () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[123, true, 'alpha']]), 'Data');
    return new Uint8Array(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
  };
  const rowsAfter = (rewrite: (xml: string) => string) => {
    const entries = unzipSync(bytes());
    entries['xl/worksheets/sheet1.xml'] = strToU8(rewrite(new TextDecoder().decode(entries['xl/worksheets/sheet1.xml'])));
    const manifest = readOfficeManifest(unzipSync(zipSync(entries)))!;
    return readSheetRows(unzipSync(zipSync(entries)), manifest.sheets!, manifest.sharedStrings, 500)[0].rows;
  };
  const usual = [['123', 'TRUE', 'alpha']];

  it('reads it as SheetJS does when nothing is rewritten', () => {
    expect(rowsAfter((xml) => xml)).toEqual(usual);
  });

  it('reads cell attributes in single quotes: a boolean stays TRUE, not 1', () => {
    expect(rowsAfter((xml) => xml.replace(/<c ([^>]*)>/g, (_all, attributes: string) => `<c ${attributes.replace(/="([^"]*)"/g, "='$1'")}>`))).toEqual(usual);
  });

  it('reads a value written as a CDATA section: the cell is there', () => {
    expect(rowsAfter((xml) => xml.replace('<v>alpha</v>', '<v><![CDATA[alpha]]></v>'))).toEqual(usual);
  });

  it('reads spaces around = and a character written as a reference', () => {
    expect(rowsAfter((xml) => xml.replace(/ t="b"/, ' t = "b" ').replace('<v>alpha</v>', '<v>&#97;lpha</v>'))).toEqual(usual);
  });

  it('refuses, for another reader to take over, a cell type it has no rule for', () => {
    expect(() => rowsAfter((xml) => xml.replace(' t="b"', ' t="zz"'))).toThrow(SheetStructureError);
  });

  it('refuses a part that is no worksheet', () => {
    expect(() => read('<?xml version="1.0"?><html><body/></html>')).toThrow(SheetStructureError);
  });
});
