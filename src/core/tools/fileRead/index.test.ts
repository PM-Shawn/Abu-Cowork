import { describe, it, expect, vi } from 'vitest';
import type { ToolDefinition, ToolExecutionContext } from '@/types';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { readFileTool } from '@/core/tools/definitions/fileTools';
import { recordedFileVersion } from '@/core/tools/fileReadRecords';
import { readFileImagesAreViews, readFileNeedsHostProcess, withDocumentReading } from './index';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function files(answer?: { code: number; stdout: string; stderr: string }) {
  return {
    exists: vi.fn().mockResolvedValue(true),
    readFile: vi.fn().mockResolvedValue(PNG_BYTES),
    readTextFile: vi.fn().mockResolvedValue('plain text'),
    stat: vi.fn().mockResolvedValue({ size: 10, isFile: true, isDirectory: false }),
    processImage: vi.fn(),
    runProcessor: vi.fn().mockResolvedValue(answer ?? { code: 0, stdout: '{}', stderr: '' }),
  } as unknown as ToolFileAccess & { runProcessor: ReturnType<typeof vi.fn> };
}

describe('read_file schema', () => {
  it('offers the document parameters beside upstream\'s and describes them', () => {
    expect(Object.keys(readFileTool.inputSchema.properties)).toEqual(['path', 'offset', 'limit', 'pages', 'text_offset']);
    expect(readFileTool.inputSchema.required).toEqual(['path']);
    expect(readFileTool.description).toContain('pass pages (e.g. "18" or "3-5")');
    expect(readFileTool.isConcurrencySafe).toBe(true);
  });
});

describe('withDocumentReading dispatch', () => {
  const upstream = vi.fn().mockResolvedValue('upstream result');
  const tool = withDocumentReading({
    name: 'read_file', description: 'x', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'p' } } }, execute: upstream,
  } as ToolDefinition);

  it('leaves text files and pictures to read_file\'s own code', async () => {
    upstream.mockClear();
    expect(await tool.execute({ path: '/d/notes.txt' }, { files: files() })).toBe('upstream result');
    expect(await tool.execute({ path: '/d/photo.png' }, { files: files() })).toBe('upstream result');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('refuses pages on a file it does not apply to, and a malformed one, before reading anything', async () => {
    upstream.mockClear();
    const access = files();
    expect(await tool.execute({ path: '/d/notes.txt', pages: '2' }, { files: access }))
      .toMatch(/^Error: pages does not apply to this file\. pages and text_offset are for PDFs/);
    expect(await tool.execute({ path: '/d/notes.txt', text_offset: 5 }, { files: access }))
      .toMatch(/^Error: text_offset does not apply to this file/);
    expect(await tool.execute({ path: '/d/a.pdf', pages: 'first' }, { files: access }))
      .toMatch(/^Error: pages could not be read/);
    expect(upstream).not.toHaveBeenCalled();
    expect(access.runProcessor).not.toHaveBeenCalled();
  });

  it('leaves a missing file to read_file\'s own report', async () => {
    upstream.mockClear();
    const access = files();
    vi.mocked(access.exists).mockResolvedValue(false);
    expect(await tool.execute({ path: '/d/gone.pdf' }, { files: access })).toBe('upstream result');
    expect(access.runProcessor).not.toHaveBeenCalled();
  });

  it('falls back to read_file\'s own text extraction, saying so, when Python cannot run', async () => {
    upstream.mockResolvedValueOnce('plumber text');
    const access = files({ code: 127, stdout: '', stderr: 'python3: command not found' });
    const result = await tool.execute({ path: '/d/a.pdf' }, { files: access });
    expect(result).toMatch(/^\[Text only: the document reader \(the bundled Python\) could not run \(Python was not found\)/);
    expect(String(result).endsWith('plumber text')).toBe(true);
  });

  it('records the read and the outcome of a PDF it read', async () => {
    const reportMetadata = vi.fn();
    const context: ToolExecutionContext = { files: files({ code: 0, stdout: JSON.stringify({
      ok: true, pages: 1, unexamined_from: null, text_cut_at: null, text_cut_from: 0, seconds: 0.1,
      list: [{ n: 1, w: 595, h: 842, chars: 900, garbled: false, ocr: false, images: 0, image_share: 0, paths: 0, text: 'hello' }],
    }), stderr: '' }), conversationId: 'c-pdf', reportMetadata };
    const result = await tool.execute({ path: '/d/a.pdf' }, context);
    expect(String(result)).toContain('--- Page 1 ---\nhello');
    expect(reportMetadata).toHaveBeenCalledWith({ fileReadOutcome: { kind: 'document' } });
    expect(await recordedFileVersion('/d/a.pdf', context)).toEqual(expect.any(String));
  });
});

describe('readFileNeedsHostProcess', () => {
  it('sends PDF reads to the host and keeps the rest in the sidecar', () => {
    expect(readFileNeedsHostProcess('/d/a.PDF')).toBe(true);
    expect(readFileNeedsHostProcess('/d/a.png')).toBe(false);
    expect(readFileNeedsHostProcess('/d/a.txt')).toBe(false);
  });
});

describe('readFileImagesAreViews', () => {
  it('marks a PDF read, not a picture read', () => {
    expect(readFileImagesAreViews({ path: '/d/a.pdf' })).toBe(true);
    expect(readFileImagesAreViews({ path: '/d/qr.png' })).toBe(false);
    expect(readFileImagesAreViews(undefined)).toBe(false);
  });
});
