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

const view = {
  ok: true, format: 'PNG', size: [4000, 3000], region: [0.5, 0.5, 1, 1], rotate: 0,
  rulers: [[0.5, 1], [0.5, 1]], img: { data: 'ZOOM', w: 1600, h: 1200 },
};

describe('read_file schema', () => {
  it('offers the document parameters beside upstream\'s and describes them', () => {
    expect(Object.keys(readFileTool.inputSchema.properties)).toEqual(['path', 'offset', 'limit', 'pages', 'text_offset', 'region', 'rotate', 'image_index']);
    expect(readFileTool.inputSchema.required).toEqual(['path']);
    expect(readFileTool.description).toContain('pass pages (e.g. "18" or "3-5")');
    expect(readFileTool.description).toContain('pass image_index to see one picture');
    expect(readFileTool.isConcurrencySafe).toBe(true);
  });
});

describe('withDocumentReading dispatch', () => {
  const upstream = vi.fn().mockResolvedValue('upstream result');
  const tool = withDocumentReading({
    name: 'read_file', description: 'x', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'p' } } }, execute: upstream,
  } as ToolDefinition);

  it('leaves text files and plain picture reads to read_file\'s own code', async () => {
    upstream.mockClear();
    expect(await tool.execute({ path: '/d/notes.txt' }, { files: files() })).toBe('upstream result');
    expect(await tool.execute({ path: '/d/photo.png' }, { files: files() })).toBe('upstream result');
    // A model that cannot see gets read_file's own note for a picture, region or not.
    expect(await tool.execute({ path: '/d/photo.png', region: [0, 0, 0.5, 0.5] }, { files: files(), supportsVision: false })).toBe('upstream result');
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it('refuses document parameters on files they do not apply to, before reading anything', async () => {
    upstream.mockClear();
    const access = files();
    expect(await tool.execute({ path: '/d/notes.txt', pages: '2' }, { files: access }))
      .toMatch(/^Error: pages does not apply to this file\. pages and text_offset are for PDFs/);
    expect(await tool.execute({ path: '/d/notes.txt', text_offset: 5 }, { files: access }))
      .toMatch(/^Error: text_offset does not apply to this file/);
    expect(await tool.execute({ path: '/d/photo.png', image_index: 2 }, { files: access }))
      .toMatch(/^Error: pages and image_index do not apply to a picture file/);
    expect(await tool.execute({ path: '/d/photo.png', text_offset: 5 }, { files: access }))
      .toMatch(/^Error: text_offset does not apply to a picture file/);
    expect(await tool.execute({ path: '/d/a.pdf', region: { x0: 0, y0: 0, x1: 900, y1: 900 } }, { files: access }))
      .toMatch(/^Error: region values are fractions between 0 and 1/);
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

  it('shows part of a picture enlarged, with its label, and records the read', async () => {
    const access = files({ code: 0, stdout: JSON.stringify(view), stderr: '' });
    const context: ToolExecutionContext = { files: access, conversationId: 'c-view' };
    const result = await tool.execute({ path: '/d/scan.png', region: { x0: 0.5, y0: 0.5, x1: 1, y1: 1 } }, context);
    const [, program, args] = access.runProcessor.mock.calls[0];
    expect(program).toMatch(/python/);
    expect(args[2]).toBe('image-view');
    expect(JSON.parse(args[3] as string)).toMatchObject({ region: [0.5, 0.5, 1, 1], rotate: 0, side: 1600 });
    expect(result).toEqual([
      { type: 'text', text: expect.stringMatching(/^\[Picture scan\.png \(4000×3000 px\): region x 0\.5–1, y 0\.5–1, shown at 1600×1200 px\./) },
      { type: 'text', text: '[scan.png, region x 0.5–1, y 0.5–1, 1600×1200 px]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZOOM' } },
    ]);
    expect(await recordedFileVersion('/d/scan.png', context)).toEqual(expect.any(String));
  });

  it('says when a zoom enlarges the picture\'s own pixels three times or more', async () => {
    const access = files({ code: 0, stdout: JSON.stringify({ ...view, zoom: 4 }), stderr: '' });
    const result = await tool.execute({ path: '/d/qr.png', region: { x0: 0.5, y0: 0.5, x1: 0.6, y1: 0.6 } }, { files: access });
    expect(Array.isArray(result) && result[0]).toEqual({ type: 'text', text: expect.stringContaining("\nThis view enlarges the picture's own pixels about 4 times") });
  });

  it('falls back to the whole picture, saying so, when Python cannot run', async () => {
    upstream.mockResolvedValueOnce([{ type: 'text', text: 'Image: /d/scan.png' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'X' } }]);
    const access = files({ code: 127, stdout: '', stderr: 'python3: command not found' });
    const result = await tool.execute({ path: '/d/scan.png', rotate: 90 }, { files: access });
    expect(Array.isArray(result) && result[0]).toEqual({
      type: 'text', text: '[The picture viewer (the bundled Python) could not run (Python was not found), so region and rotate were not applied: this is the whole picture.]',
    });
  });
});

describe('readFileNeedsHostProcess', () => {
  it('sends PDF reads and picture views to the host, and keeps Office reads and the rest in the sidecar', () => {
    expect(readFileNeedsHostProcess('/d/a.PDF', {})).toBe(true);
    // An Office read unzips and parses in the sidecar; only its picture renders reach the host.
    expect(readFileNeedsHostProcess('/d/a.docx', {})).toBe(false);
    expect(readFileNeedsHostProcess('/d/a.xlsx', {})).toBe(false);
    expect(readFileNeedsHostProcess('/d/a.pptx', { image_index: 2 })).toBe(false);
    expect(readFileNeedsHostProcess('/d/a.png', { region: { x0: 0, y0: 0, x1: 1, y1: 0.5 } })).toBe(true);
    expect(readFileNeedsHostProcess('/d/a.jpg', { rotate: 180 })).toBe(true);
    expect(readFileNeedsHostProcess('/d/a.jpg', { rotate: 0 })).toBe(false);
    expect(readFileNeedsHostProcess('/d/a.png', {})).toBe(false);
    expect(readFileNeedsHostProcess('/d/a.txt', { pages: '2' })).toBe(false);
  });
});

describe('readFileImagesAreViews', () => {
  it('marks document reads and zooms, not a plain picture read', () => {
    expect(readFileImagesAreViews({ path: '/d/a.pdf' })).toBe(true);
    expect(readFileImagesAreViews({ path: '/d/a.pptx' })).toBe(true);
    expect(readFileImagesAreViews({ path: '/d/qr.png', region: [0, 0, 1, 0.5] })).toBe(true);
    expect(readFileImagesAreViews({ path: '/d/qr.png' })).toBe(false);
    // rotate 0 turns nothing: the picture is the plain read, shown in the reply.
    expect(readFileImagesAreViews({ path: '/d/qr.png', rotate: 0 })).toBe(false);
    expect(readFileImagesAreViews({ path: '/d/qr.png', rotate: '360' })).toBe(false);
    expect(readFileImagesAreViews({ path: '/d/qr.png', rotate: 90 })).toBe(true);
    expect(readFileImagesAreViews(undefined)).toBe(false);
  });
});
