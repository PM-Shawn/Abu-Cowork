import { describe, it, expect, vi } from 'vitest';
import type { ToolExecutionContext, ToolResultContent } from '@/types';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { admissionMaxDimension } from '@/core/llm/imagePolicy';
import { admissionRawBytes } from '@/core/llm/imageFit';
import { readFileTool } from './fileTools';

/** A PNG header that declares a size; the rest of the file is filler bytes, `length` of them in all. */
function pngOf(width: number, height: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function access(source: Uint8Array, fitted: Uint8Array | Error = pngOf(1, 1)) {
  const processImage = vi.fn(async () => {
    if (fitted instanceof Error) throw fitted;
    return fitted;
  });
  return {
    files: {
      exists: vi.fn().mockResolvedValue(true),
      readFile: vi.fn().mockResolvedValue(source),
      readTextFile: vi.fn(),
      stat: vi.fn().mockResolvedValue({ size: source.length, isFile: true, isDirectory: false }),
      processImage,
    } as unknown as ToolFileAccess,
    processImage,
  };
}

async function read(source: Uint8Array, fitted?: Uint8Array | Error) {
  const { files, processImage } = access(source, fitted);
  const result = await readFileTool.execute({ path: '/d/plan.png' }, { files } as ToolExecutionContext);
  return { result: result as ToolResultContent[], processImage };
}

describe('read_file fits a plain picture by its long side to the admission limit', () => {
  const limit = admissionMaxDimension();

  it('fits a wide picture that is small in bytes (10032x4178, under 2 MB)', async () => {
    const { result, processImage } = await read(pngOf(10032, 4178), pngOf(limit, Math.round(4178 * limit / 10032)));
    expect(processImage).toHaveBeenCalledWith('/d/plan.png', null, 'fit-width', { width: limit });
    const image = result.find((block) => block.type === 'image');
    expect(image).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    expect(JSON.stringify(result[0])).toContain(`${limit}px on its long side`);
  });

  it('fits a tall picture by its height, so no side is over the limit (1000x20000)', async () => {
    const { processImage } = await read(pngOf(1000, 20000));
    // The long side is the height: the width is scaled by limit / 20000.
    expect(processImage).toHaveBeenCalledWith('/d/plan.png', null, 'fit-width', { width: Math.floor(1000 * limit / 20000) });
  });

  it('leaves a picture inside the limit untouched', async () => {
    const { result, processImage } = await read(pngOf(limit, limit));
    expect(processImage).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ type: 'text' });
    expect(JSON.stringify(result[0])).not.toContain('resized');
  });

  it('sends the picture as it is when the fit fails, for the send-time check to judge', async () => {
    const { result } = await read(pngOf(20000, 100), new Error('refused'));
    expect(result.some((block) => block.type === 'image')).toBe(true);
  });
});

/** A JPEG header (SOI, JFIF, frame header) that declares a size, padded to `length` bytes. */
function jpegOf(width: number, height: number, length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
  ]);
  return bytes;
}

async function readAs(file: string, source: Uint8Array, fits: Array<Uint8Array | Error>) {
  const { files, processImage } = access(source);
  for (const next of fits) processImage.mockImplementationOnce(async () => { if (next instanceof Error) throw next; return next; });
  const result = await readFileTool.execute({ path: file }, { files } as ToolExecutionContext) as ToolResultContent[];
  return { result, processImage };
}

describe('read_file also keeps a picture under the provider per-image byte limit', () => {
  const limit = admissionMaxDimension();
  const raw = admissionRawBytes();

  it('keeps a photo a JPEG when it is fitted (4000x3000), instead of a PNG that is larger than the file', async () => {
    const out = new Uint8Array(500_000);
    const { result, processImage } = await readAs('/d/photo.jpg', jpegOf(4000, 3000, 900_000), [out]);
    expect(processImage).toHaveBeenCalledTimes(1);
    expect(processImage).toHaveBeenCalledWith('/d/photo.jpg', null, 'fit-width', { width: limit, format: 'jpeg', quality: 85 });
    expect(result.find((b) => b.type === 'image')).toMatchObject({ source: { media_type: 'image/jpeg' } });
  });

  it('fits a 1900x1200 PNG of 6 MB, inside the side limit but over the byte limit, as a JPEG at full size', async () => {
    const { result, processImage } = await readAs('/d/shot.png', pngOf(1900, 1200, 6 * 1024 * 1024), [new Uint8Array(800_000)]);
    expect(processImage).toHaveBeenCalledWith('/d/shot.png', null, 'fit-width', { width: 1900, format: 'jpeg', quality: 75 });
    expect(result.find((b) => b.type === 'image')).toMatchObject({ source: { media_type: 'image/jpeg' } });
  });

  it('tries the next step when a fit is still over the limit, and stops at the first that is under it', async () => {
    const tooBig = new Uint8Array(raw + 1);
    const { processImage, result } = await readAs('/d/big.png', pngOf(4000, 3000, 9 * 1024 * 1024), [tooBig, new Uint8Array(1000)]);
    expect(processImage).toHaveBeenCalledTimes(2);
    expect(processImage.mock.calls[0][3]).toMatchObject({ width: limit });
    expect(processImage.mock.calls[1][3]).toMatchObject({ width: limit, format: 'jpeg' });
    expect(result.find((b) => b.type === 'image')).toMatchObject({ source: { media_type: 'image/jpeg' } });
  });

  it('leaves a picture that no step brings under the limit as it is, with no resize note, for the send-time check', async () => {
    const tooBig = new Uint8Array(raw + 1);
    const source = pngOf(4000, 3000, 9 * 1024 * 1024);
    const { result, processImage } = await readAs('/d/huge.png', source, [tooBig, tooBig, tooBig, tooBig]);
    expect(processImage.mock.calls.length).toBeLessThanOrEqual(4);
    expect(JSON.stringify(result[0])).not.toContain('resized');
    expect(result.find((b) => b.type === 'image')).toMatchObject({ source: { media_type: 'image/png' } });
  });
});
