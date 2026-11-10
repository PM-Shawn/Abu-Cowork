import type { ToolDefinition, ToolExecutionContext, ToolParameter, ToolResult } from '@/types';
import { isToolResultError } from '@/core/agent/toolResultErrors';
import { recordFileVersion } from '@/core/tools/fileReadRecords';
import { sha256Hex } from '@/core/session/turnUndoRecord';
import { exists, readFile as readBinFile } from '../fsBridge';
import { getFileExtension } from '../helpers/toolHelpers';
import { readImageView } from './imageView';
import { readPdf, type DocumentReadOutcome } from './pdfRead';
import { asksForView, parseDocumentReadParams } from './readParams';

/**
 * read_file's reading of PDFs and of parts of pictures.
 *
 * `withDocumentReading` wraps the existing read_file definition: PDFs, and
 * region or rotated views of raster pictures, are read here; every other read
 * (a plain picture read included), and the text-only PDF fallback when the
 * bundled Python cannot run, stays read_file's own code. Keeping the logic
 * here leaves `fileTools.ts` as it was but for the wrapping call.
 */

const RASTER_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const DOCUMENT_PARAMETERS = ['pages', 'region', 'rotate'] as const;

type FileKind = 'pdf' | 'image';

function fileKind(path: string): FileKind | null {
  const ext = getFileExtension(path);
  if (ext === '.pdf') return 'pdf';
  if (RASTER_EXTENSIONS.has(ext)) return 'image';
  return null;
}

const given = (value: unknown) => value !== undefined && value !== null && value !== '';

export const READ_FILE_DESCRIPTION = 'Read a file. Text files: the content (offset and limit page through large files). '
  + 'PDF: a short manifest first (which pages have an exact, OCR or garbled text layer, which hold pictures or drawings, which page images are attached), then the text of each page; '
  + 'pass pages (e.g. "18" or "3-5") for those pages\' text with page images, and add region (with one page) or rotate to zoom into or turn part of a page. '
  + 'Images (png/jpg/gif/webp/bmp): the picture; region or rotate show part of it enlarged or turned. Office documents (.docx/.xlsx/.pptx): their text. Archives: the list of entries. '
  + 'Read the manifest before answering: it says what you have not been shown. Answer from the text where it reads clearly; look at the image where the text is missing or garbled, or where the answer lies in handwriting, signatures, stamps, marks, drawings or pictures, and zoom in rather than guess.';

export const DOCUMENT_READ_PROPERTIES: Record<string, ToolParameter> = {
  pages: {
    type: 'string',
    description: 'PDF only: the pages to read with their page images, e.g. "18", "3-5" or "2,7" (up to 4 page images per call). With region or rotate: one page.',
  },
  region: {
    type: 'object',
    description: 'Zoom: the part of a PDF page (with pages) or of a picture file to show enlarged, in fractions 0–1 from its top-left corner as shown, read off the rulers of the image you saw (with rotate, of the turned image); e.g. {"x0":0.5,"y0":0.6,"x1":1,"y1":1} is the lower right. For a PDF page the text layer inside the region comes too.',
    properties: {
      x0: { type: 'number', description: 'Left edge (0–1)' },
      y0: { type: 'number', description: 'Top edge (0–1)' },
      x1: { type: 'number', description: 'Right edge (0–1)' },
      y1: { type: 'number', description: 'Bottom edge (0–1)' },
    },
  },
  rotate: {
    type: 'number',
    description: 'Degrees to turn the PDF page or picture clockwise before showing it, to set sideways or upside-down content upright: 270 when the content lies turned a quarter clockwise (the tops of its letters face right), 90 when turned a quarter counter-clockwise (tops face left), 180 when upside down. region, if given, is on the turned image.',
  },
};

/** What the wrapper does with one call. */
type Handling =
  | { kind: 'upstream' }
  | { kind: 'done'; result: ToolResult }
  | { kind: 'fallback'; note: string };

const VIEW_APPLIES_TO = 'region and rotate work on PDF pages and on raster pictures (png, jpg, gif, webp, bmp)';

/** Text put before the result of read_file's own code when the document reader could not run. */
function fallbackNote(kind: FileKind, detail: string): string {
  return kind === 'pdf'
    ? `[Text only: the document reader (the bundled Python) could not run (${detail}), so this PDF's pictures, drawings and scanned pages were not examined, and pages, region and rotate were not applied. A page with little text here may hold content only visible as an image.]`
    : `[The picture viewer (the bundled Python) could not run (${detail}), so region and rotate were not applied: this is the whole picture.]`;
}

async function versionOf(path: string, context?: ToolExecutionContext): Promise<string> {
  return sha256Hex(new Uint8Array(await (context?.files ? context.files.readFile(path) : readBinFile(path))));
}

async function handle(input: Record<string, unknown>, context?: ToolExecutionContext): Promise<Handling> {
  const filePath = typeof input.path === 'string' ? input.path : '';
  const kind = fileKind(filePath);
  if (!kind) {
    const asked = DOCUMENT_PARAMETERS.filter((name) => given(input[name]));
    if (!asked.length) return { kind: 'upstream' };
    return { kind: 'done', result: `Error: ${asked.join(', ')} ${asked.length === 1 ? 'does' : 'do'} not apply to this file. pages is for PDFs; ${VIEW_APPLIES_TO}.` };
  }
  const params = parseDocumentReadParams(input);
  if ('error' in params) return { kind: 'done', result: `Error: ${params.error}` };
  if (kind === 'image') {
    if (params.pages) {
      return { kind: 'done', result: 'Error: pages does not apply to a picture file; use region and rotate to look at part of it.' };
    }
    // A model that cannot see gets read_file's own note; a plain read is read_file's own code.
    if (context?.supportsVision === false || !asksForView(params)) return { kind: 'upstream' };
  }
  // A missing file is reported and recorded by read_file's own code.
  if (!(await (context?.files ? context.files.exists(filePath) : exists(filePath)))) return { kind: 'upstream' };

  const versionBefore = await versionOf(filePath, context);
  const outcome: DocumentReadOutcome = kind === 'pdf'
    ? await readPdf(filePath, params, context)
    : await readImageView(filePath, params, context);
  if (outcome.kind === 'aborted') {
    return { kind: 'done', result: kind === 'pdf' ? 'Error reading file: PDF extraction was aborted.' : 'Error reading file: the read was aborted.' };
  }
  if (outcome.kind === 'fallback') return { kind: 'fallback', note: fallbackNote(kind, outcome.detail) };
  const result = outcome.result;
  if (typeof result === 'string' && isToolResultError(result)) return { kind: 'done', result };
  if (kind === 'pdf') context?.reportMetadata?.({ fileReadOutcome: { kind: 'document' } });
  // A read that showed the model any of the file records the file's version,
  // unless the file changed while it was read (fileReadRecords.ts).
  const versionAfter = await versionOf(filePath, context);
  if (versionAfter === versionBefore) await recordFileVersion(filePath, versionAfter, context);
  return { kind: 'done', result };
}

/** Put a note before a result of read_file's own code; an error stays as it is. */
function withNote(note: string, result: ToolResult): ToolResult {
  if (typeof result === 'string') return isToolResultError(result) ? result : `${note}\n\n${result}`;
  return [{ type: 'text', text: note }, ...result];
}

/** read_file with PDFs and picture views read by this module. */
export function withDocumentReading(base: ToolDefinition): ToolDefinition {
  return {
    ...base,
    description: READ_FILE_DESCRIPTION,
    inputSchema: {
      ...base.inputSchema,
      properties: { ...base.inputSchema.properties, ...DOCUMENT_READ_PROPERTIES },
    },
    execute: async (input, context) => {
      let handling: Handling;
      try {
        handling = await handle(input, context);
      } catch (err) {
        return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (handling.kind === 'done') return handling.result;
      const result = await base.execute(input, context);
      return handling.kind === 'fallback' ? withNote(handling.note, result) : result;
    },
  };
}

/** A call that asks for part of a picture or a turned one; `rotate: 0` turns nothing. */
function asksForPictureView(input: Record<string, unknown>): boolean {
  return given(input.region) || (given(input.rotate) && Number(input.rotate) % 360 !== 0);
}

/**
 * Whether a read_file call must run in the shell rather than in the sidecar:
 * a PDF read (its text-only fallback runs pdftotext or pdfplumber, which the
 * sidecar cannot start) and a view of part of a picture (the viewer is a
 * Python program, which the sidecar cannot start either).
 */
export function readFileNeedsHostProcess(path: string, input: Record<string, unknown>): boolean {
  const kind = fileKind(path);
  if (kind === 'pdf') return true;
  return kind === 'image' && asksForPictureView(input);
}

/**
 * Whether the images of a read_file result are how the model looked at a
 * document (page renders, zoomed parts) rather than a picture to show in the
 * reply.
 */
export function readFileImagesAreViews(input: Record<string, unknown> | undefined): boolean {
  if (!input) return false;
  const path = typeof input.path === 'string' ? input.path : '';
  return fileKind(path) === 'pdf' || asksForPictureView(input);
}
