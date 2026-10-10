/**
 * Smallest valid files for the preview specs. Each kind carries a visible marker that changes
 * with the version, so a spec can tell which write of the file is on screen.
 */
import { strToU8, zipSync } from 'fflate';
import * as XLSX from 'xlsx';

export function marker(kind: string, version: number): string {
  return `${kind}MARK-V${version}`;
}

export function textBytes(version: number): Buffer {
  return Buffer.from(`${marker('TXT', version)}\nsecond line\n`, 'utf8');
}

export function tsvBytes(version: number): Buffer {
  return Buffer.from(`姓名\tvalue\n${marker('TSV', version)}\t"a\tb"\n`, 'utf8');
}

/** One page per version, each page showing the marker. */
export function pdfBytes(version: number): Buffer {
  const pageCount = version;
  const text = marker('PDF', version);
  const objects: string[] = [];
  const fontId = 3 + pageCount * 2;
  const kids: string[] = [];
  for (let i = 0; i < pageCount; i++) kids.push(`${3 + i * 2} 0 R`);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`);
  for (let i = 0; i < pageCount; i++) {
    const contentId = 4 + i * 2;
    const stream = `BT /F1 24 Tf 40 100 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export function docxBytes(version: number): Buffer {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    `<w:p><w:r><w:t>${marker('DOCX', version)}</w:t></w:r></w:p>` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    'word/document.xml': strToU8(document),
  }));
}

export function xlsxBytes(version: number): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['name', 'value'], [marker('XLSX', version), 1]]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
