import type { ToolDefinition, ToolExecutionContext, ToolParameter, ToolResult } from '@/types';
import { isToolResultError } from '@/core/agent/toolResultErrors';
import { recordFileVersion } from '@/core/tools/fileReadRecords';
import { sha256Hex } from '@/core/session/turnUndoRecord';
import { exists, readFile as readBinFile } from '../fsBridge';
import { getFileExtension } from '../helpers/toolHelpers';
import { readPdf, type DocumentReadOutcome } from './pdfRead';
import { parseDocumentReadParams } from './readParams';

/**
 * read_file's reading of PDFs.
 *
 * `withDocumentReading` wraps the existing read_file definition: PDFs are read
 * here; every other read, and the text-only PDF fallback when the bundled
 * Python cannot run, stays read_file's own code. Keeping the logic
 * here leaves `fileTools.ts` as it was but for the wrapping call.
 */

const DOCUMENT_PARAMETERS = ['pages'] as const;

type FileKind = 'pdf';

function fileKind(path: string): FileKind | null {
  const ext = getFileExtension(path);
  if (ext === '.pdf') return 'pdf';
  return null;
}

const given = (value: unknown) => value !== undefined && value !== null && value !== '';

export const READ_FILE_DESCRIPTION = 'Read a file. Text files: the content (offset and limit page through large files). '
  + 'PDF: a short manifest first (which pages have an exact, OCR or garbled text layer, which hold pictures or drawings, which page images are attached), then the text of each page; '
  + 'pass pages (e.g. "18" or "3-5") for those pages\' text with page images. '
  + 'Images (png/jpg/gif/webp/bmp): the picture. Office documents (.docx/.xlsx/.pptx): their text. Archives: the list of entries. '
  + 'Read the manifest before answering: it says what you have not been shown. Answer from the text where it reads clearly; look at the page image where the text is missing or garbled, or where the answer lies in handwriting, signatures, stamps, marks, drawings or pictures.';

export const DOCUMENT_READ_PROPERTIES: Record<string, ToolParameter> = {
  pages: {
    type: 'string',
    description: 'PDF only: the pages to read with their page images, e.g. "18", "3-5" or "2,7" (up to 4 page images per call).',
  },
};

/** What the wrapper does with one call. */
type Handling =
  | { kind: 'upstream' }
  | { kind: 'done'; result: ToolResult }
  | { kind: 'fallback'; note: string };

/** Text put before the result of read_file's own code when the document reader could not run. */
function fallbackNote(detail: string): string {
  return `[Text only: the document reader (the bundled Python) could not run (${detail}), so this PDF's pictures, drawings and scanned pages were not examined, and pages was not applied. A page with little text here may hold content only visible as an image.]`;
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
    return { kind: 'done', result: `Error: ${asked.join(', ')} ${asked.length === 1 ? 'does' : 'do'} not apply to this file. pages is for PDFs.` };
  }
  const params = parseDocumentReadParams(input);
  if ('error' in params) return { kind: 'done', result: `Error: ${params.error}` };
  // A missing file is reported and recorded by read_file's own code.
  if (!(await (context?.files ? context.files.exists(filePath) : exists(filePath)))) return { kind: 'upstream' };

  const versionBefore = await versionOf(filePath, context);
  const outcome: DocumentReadOutcome = await readPdf(filePath, params, context);
  if (outcome.kind === 'aborted') return { kind: 'done', result: 'Error reading file: PDF extraction was aborted.' };
  if (outcome.kind === 'fallback') return { kind: 'fallback', note: fallbackNote(outcome.detail) };
  const result = outcome.result;
  if (typeof result === 'string' && isToolResultError(result)) return { kind: 'done', result };
  context?.reportMetadata?.({ fileReadOutcome: { kind: 'document' } });
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

/** read_file with PDFs read by this module. */
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

/**
 * Whether a read_file call must run in the shell rather than in the sidecar: a
 * PDF read (the document reader, and the text-only fallback that runs pdftotext
 * or pdfplumber, are programs the sidecar cannot start).
 */
export function readFileNeedsHostProcess(path: string): boolean {
  return fileKind(path) === 'pdf';
}

/**
 * Whether the images of a read_file result are how the model looked at a
 * document (page renders) rather than a picture to show in the reply.
 */
export function readFileImagesAreViews(input: Record<string, unknown> | undefined): boolean {
  const path = typeof input?.path === 'string' ? input.path : '';
  return fileKind(path) === 'pdf';
}
