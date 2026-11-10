import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import {
  DOCUMENT_PROBE_SCRIPT,
  type PdfReadProbe,
} from './documentProbe';

/**
 * The probe program itself, run by the Python of this machine on files the
 * test writes to a temporary folder. Skipped where Python, pypdfium2 or
 * Pillow is missing; the bundled runtime has all three.
 */
const python = process.platform === 'win32' ? 'python' : 'python3';
const hasLibraries = spawnSync(python, ['-c', 'import pypdfium2, PIL'], { encoding: 'utf8' }).status === 0;

/**
 * A one-page 600×800 PDF from a content stream. With `scan`, a page-sized
 * picture lies under the content, as on a scanned page.
 */
function buildPdf(content: string, scan = false): Buffer {
  const resources = `/Font << /F1 5 0 R >>${scan ? ' /XObject << /Im1 6 0 R >>' : ''}`;
  const stream = `${scan ? 'q 600 0 0 800 0 0 cm /Im1 Do Q\n' : ''}${content}`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources << ${resources} >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...(scan ? ['<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream'] : []),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** A one-page PDF: a heading at the top left, a total at the bottom right, and 40 lines. */
function samplePdf(): Buffer {
  const lines = Array.from({ length: 40 }, (_, i) => `${50 + i * 10} 300 m ${50 + i * 10} 500 l S`).join('\n');
  return buildPdf(`BT /F1 24 Tf 50 740 Td (Invoice 12345) Tj ET\nBT /F1 12 Tf 420 60 Td (Total due 678.90) Tj ET\n${lines}\n`);
}

/**
 * Six lines of text, "Clause 1 …" at the top to "Clause 6 …" at the bottom,
 * written in the order 4, 1, 5, 2, 6, 3 (or top to bottom with `inOrder`); the
 * last line in two pieces. With `scan`, invisible over a page-sized picture,
 * as a scanner's OCR layer.
 */
function clausesPdf(scan: boolean, inOrder = false): Buffer {
  const mode = scan ? '3 Tr ' : '';
  const line = (n: number) => n === 6
    ? `BT ${mode}/F1 12 Tf 50 200 Td (Clause 6 ends) Tj ET\nBT ${mode}/F1 12 Tf 300 200 Td (the term) Tj ET`
    : `BT ${mode}/F1 12 Tf 50 ${700 - (n - 1) * 100} Td (Clause ${n} text) Tj ET`;
  const order = inOrder ? [1, 2, 3, 4, 5, 6] : [4, 1, 5, 2, 6, 3];
  return buildPdf(`${order.map(line).join('\n')}\n`, scan);
}

/** A 40×20 PNG, left half black, right half white. */
function samplePng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(40, 0);
  header.writeUInt32BE(20, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: 20 }, () => Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(20 * 3, 0),
    Buffer.alloc(20 * 3, 255),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe.skipIf(!hasLibraries)('the probe program on generated files', () => {
  let dir = '';
  const run = <T>(operation: string, options: Record<string, unknown>, file: string): T & { ok: boolean; error?: string; message?: string } => {
    const out = spawnSync(python, ['-c', DOCUMENT_PROBE_SCRIPT, operation, JSON.stringify(options), file], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    expect(out.status).toBe(0);
    return JSON.parse(out.stdout);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-'));
    writeFileSync(join(dir, 'input.pdf'), samplePdf());
    writeFileSync(join(dir, 'input.png'), samplePng());
    writeFileSync(join(dir, 'ocr.pdf'), clausesPdf(true));
    writeFileSync(join(dir, 'ocr-in-order.pdf'), clausesPdf(true, true));
    writeFileSync(join(dir, 'drawn.pdf'), clausesPdf(false));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('pdf-read: the page facts, its text and a render with rulers', () => {
    const read = run<PdfReadProbe>('pdf-read', { render: true, render_all_at_most: 3, side: 400 }, join(dir, 'input.pdf'));
    expect(read.ok).toBe(true);
    expect(read.pages).toBe(1);
    const [page] = read.list;
    expect(page).toMatchObject({ n: 1, w: 600, h: 800, garbled: false, ocr: false, images: 0, image_share: 0, paths: 40 });
    expect(page.chars).toBeGreaterThanOrEqual(26);
    expect(page.text).toContain('Invoice 12345');
    expect(page.img?.data.startsWith('/9j/')).toBe(true);
    // 300 × 400 page render, plus the rulers' margins.
    expect(page.img?.w).toBe(300 + 44);
    expect(page.img?.h).toBe(400 + 26);
  });

  it('pdf-read: renders nothing for a longer document than asked, and refuses pages outside it', () => {
    const read = run<PdfReadProbe>('pdf-read', { render: true, render_all_at_most: 0, side: 400 }, join(dir, 'input.pdf'));
    expect(read.list[0].img).toBeUndefined();
    const refused = run<PdfReadProbe>('pdf-read', { pages: [[5, 6]] }, join(dir, 'input.pdf'));
    expect(refused).toMatchObject({ ok: false, error: 'ValueError', message: expect.stringContaining('has 1 pages') });
  });

  it('pdf-read: gives an OCR layer written in no order as lines sorted by their place on the page', () => {
    const [page] = run<PdfReadProbe>('pdf-read', {}, join(dir, 'ocr.pdf')).list;
    expect(page.ocr).toBe(true);
    expect(page.text).toBe('Clause 1 text\nClause 2 text\nClause 3 text\nClause 4 text\nClause 5 text\nClause 6 ends the term');
  });

  it('pdf-read: keeps the order of an OCR layer written top to bottom, and of any text that is not OCR', () => {
    const inOrder = run<PdfReadProbe>('pdf-read', {}, join(dir, 'ocr-in-order.pdf')).list[0];
    expect(inOrder.ocr).toBe(true);
    expect(inOrder.text?.indexOf('Clause 1')).toBeLessThan(inOrder.text?.indexOf('Clause 2') ?? -1);
    const drawn = run<PdfReadProbe>('pdf-read', {}, join(dir, 'drawn.pdf')).list[0];
    expect(drawn.ocr).toBe(false);
    // Text a program drew where it wanted keeps the order it was drawn in.
    expect(drawn.text?.indexOf('Clause 4')).toBeLessThan(drawn.text?.indexOf('Clause 1') ?? -1);
  });
});
