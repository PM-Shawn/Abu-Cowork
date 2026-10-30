/**
 * A tool result too long for the conversation keeps its beginning and its end
 * there; the whole text goes to a file the model can read with read_file.
 *
 * The threshold is DSH's `spill-policy` default (12 500 tokens). A read_file
 * result keeps the file tool's own size and pagination rules.
 * The omission line is the one `toolResultFold` folds in the step view.
 */

import { estimateTokens } from './tokenEstimator';
import { charsOmittedMarker } from './truncation';
import { TOOL_NAMES } from '../tools/toolNames';
import { SPILL_NOTE_ENDING } from '../session/toolResultFileReference';

export const SPILL_THRESHOLD_TOKENS = 12_500;
const PREVIEW_HEAD_TOKENS = 2_500;
const PREVIEW_TAIL_TOKENS = 1_000;

/** The last line `boundToolResult` writes: where the rest is, for the model. */
export function isSpillNoteLine(line: string): boolean {
  return line.startsWith('[') && line.endsWith(SPILL_NOTE_ENDING);
}

/** Writes the full text of one tool result and returns the file's path. */
export type ToolResultFileWriter = (toolCallId: string, text: string) => Promise<string>;

export async function boundToolResult(params: {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  writeFile: ToolResultFileWriter;
}): Promise<string> {
  const { result } = params;
  if (params.toolName === TOOL_NAMES.READ_FILE) return result;
  const tokens = estimateTokens(result);
  if (tokens <= SPILL_THRESHOLD_TOKENS) return result;

  const charsPerToken = result.length / tokens;
  const headChars = Math.floor(PREVIEW_HEAD_TOKENS * charsPerToken);
  const tailChars = Math.floor(PREVIEW_TAIL_TOKENS * charsPerToken);
  const head = result.slice(0, headChars);
  const tail = result.slice(result.length - tailChars);

  const where = `The full output (${result.length} characters) is saved at ${await params.writeFile(params.toolCallId, result)}.`;

  return [
    head,
    charsOmittedMarker(result.length - head.length - tail.length),
    tail,
    `[${where} ${SPILL_NOTE_ENDING}`,
  ].join('\n\n');
}
