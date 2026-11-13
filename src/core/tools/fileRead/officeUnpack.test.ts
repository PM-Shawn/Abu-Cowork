import { describe, it, expect, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { ToolExecutionContext, ToolResultContent } from '@/types';
import type { ToolFileAccess } from '@/core/tools/fileOperation';
import { OFFICE_MAX_PARTS, OFFICE_MAX_UNPACKED_BYTES, OfficeTooLargeError, unpackOffice } from './officeUnpack';
import { readOffice } from './officeRead';

const zip = (entries: Record<string, Uint8Array>) => zipSync(entries, { level: 1 });

describe('unpackOffice', () => {
  it('unpacks a package inside the limits', async () => {
    const entries = await unpackOffice(zip({ 'a.xml': strToU8('<a/>'), 'b.xml': strToU8('<b/>') }));
    expect(Object.keys(entries).sort()).toEqual(['a.xml', 'b.xml']);
  });

  it('refuses a package whose parts declare more than the total limit, before inflating the part that crosses it', async () => {
    const bytes = zip({ 'one.bin': new Uint8Array(600), 'two.bin': new Uint8Array(600) });
    await expect(unpackOffice(bytes, { maxUnpackedBytes: 1000, maxParts: 10 })).rejects.toBeInstanceOf(OfficeTooLargeError);
    await expect(unpackOffice(bytes, { maxUnpackedBytes: 1000, maxParts: 10 })).rejects.toThrow(/unpack/);
  });

  it('refuses a package with more parts than the limit', async () => {
    const parts: Record<string, Uint8Array> = {};
    for (let i = 0; i < 6; i++) parts[`p${i}.xml`] = strToU8('<a/>');
    await expect(unpackOffice(zip(parts), { maxUnpackedBytes: 1 << 20, maxParts: 5 })).rejects.toThrow(/more than 5 parts/);
  });

  it('keeps limits comparable to the 64 MB the old PowerPoint path took as input', () => {
    // Office XML packs 5-10x and media 1x, so 64 MB in is 64-640 MB out; 256 MB covers the media-heavy and
    // most text-heavy files, and bounds what one read may allocate.
    expect(OFFICE_MAX_UNPACKED_BYTES).toBe(256 * 1024 * 1024);
    expect(OFFICE_MAX_PARTS).toBe(20_000);
  });
});

describe('readOffice on a zip bomb', () => {
  it('answers with a clear note and does not inflate the package (a 300 MB zero-filled part in a 300 KB file)', async () => {
    const bomb = zip({
      '[Content_Types].xml': strToU8('<Types/>'),
      'ppt/presentation.xml': strToU8('<p/>'),
      'ppt/media/big.bin': new Uint8Array(300 * 1024 * 1024),
    });
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    const files = { readFile: vi.fn().mockResolvedValue(bomb), stat: vi.fn(), runProcessor: vi.fn() } as unknown as ToolFileAccess;
    const outcome = await readOffice('/d/deck.pptx', { pages: null, region: null, rotate: 0, imageIndex: null, textOffset: 0 }, { files } as ToolExecutionContext);
    if (outcome.kind !== 'done') throw new Error(outcome.kind);
    const text = typeof outcome.result === 'string' ? outcome.result : (outcome.result as ToolResultContent[]).map((b) => (b as { text?: string }).text ?? '').join('');
    expect(text).toMatch(/too large to read/);
    expect(text).toContain('256 MB');
  }, 60_000);
});
