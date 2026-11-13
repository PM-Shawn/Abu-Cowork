import { getI18n, format } from '@/i18n';
import type { ZipEntries } from './officeManifest';

/**
 * Unpacking of a Word, Excel or PowerPoint package with a ceiling on what it may
 * allocate. fflate's `unzipSync` inflates every part eagerly, so a 1.5 MB package
 * holding a 1.5 GB zero-filled part (a zip bomb, or just a deck full of video)
 * took 1.6 GB of memory and blocked the sidecar for seconds before anything was
 * read. The sizes are read from the zip's central directory before a part is
 * inflated (fflate's `filter` runs per part, ahead of its inflate), and a package
 * over a limit is refused with a note at that point, so the part that would cross
 * the limit is never inflated. A declared size smaller than the real one cannot
 * be used to get around this: fflate sizes its output buffer by the declared
 * size and cuts the part there.
 *
 * The numbers: the PowerPoint path this replaced accepted at most 64 MB of input
 * (PROCESSOR_MAX_INPUT_BYTES). Office XML packs about 5-10x and media about 1x,
 * so such a file unpacks to 64-640 MB. 256 MB (4 x 64 MB) is the total allowed
 * here: it covers every media-heavy file the old path accepted and workbooks up to
 * about a million short rows, and bounds one read to a quarter-gigabyte of
 * allocation. 20,000 parts is several times the largest real packages (a
 * 1,000-slide deck, a Word file with thousands of pictures, hold a few thousand)
 * and far below what a bomb of tiny parts needs to hurt.
 */
export const OFFICE_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const OFFICE_MAX_PARTS = 20_000;

export interface UnpackLimits {
  maxUnpackedBytes: number;
  maxParts: number;
}

export class OfficeTooLargeError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'OfficeTooLargeError';
  }
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

export async function unpackOffice(
  bytes: Uint8Array,
  limits: UnpackLimits = { maxUnpackedBytes: OFFICE_MAX_UNPACKED_BYTES, maxParts: OFFICE_MAX_PARTS },
): Promise<ZipEntries> {
  const { unzipSync } = await import('fflate');
  let parts = 0;
  let unpacked = 0;
  return unzipSync(bytes, {
    filter: (file) => {
      parts += 1;
      if (parts > limits.maxParts) throw new OfficeTooLargeError(`it has more than ${limits.maxParts.toLocaleString('en-US')} parts`);
      unpacked += file.originalSize;
      if (unpacked > limits.maxUnpackedBytes) {
        throw new OfficeTooLargeError(`it would unpack to more than ${mb(limits.maxUnpackedBytes)}`);
      }
      return true;
    },
  });
}

/** The note a refused package gets (LLM- and user-facing, so it goes through i18n). */
export function officeTooLargeNote(err: OfficeTooLargeError): string {
  return format(getI18n().toolResult.fileRead.officeTooLarge, { detail: err.message });
}
