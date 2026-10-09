import type { ToolCall } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { parsePresentedFilesInput, parsePresentedResult } from '@/core/tools/definitions/presentTools';
import { isToolResultNotRun } from '@/core/agent/toolResultMarkers';
import { normalizeSeparators } from '@/utils/pathUtils';
import { isToolResultError, mediaToolOutputPath } from '@/utils/workflowExtractor';

export interface PresentedFile {
  /** Absolute path with `/` separators. */
  path: string;
  description?: string;
}

/**
 * The files a turn hands to the user, read from its finished tool calls:
 * what present_files declared, plus the outputs of generate_image and
 * process_image. A present_files call counts when its result lists one
 * presented path per file it was given; the path comes from the result and
 * the description from the input at the same position. A path keeps the
 * position of its first appearance and takes the description of its latest one.
 */
export function collectPresentedFiles(toolCalls: readonly ToolCall[]): PresentedFile[] {
  const files: PresentedFile[] = [];
  const byPath = new Map<string, PresentedFile>();

  const add = (rawPath: string, description?: string) => {
    const path = normalizeSeparators(rawPath);
    const existing = byPath.get(path);
    if (existing) {
      if (description !== undefined) existing.description = description;
      return;
    }
    const file: PresentedFile = description !== undefined ? { path, description } : { path };
    byPath.set(path, file);
    files.push(file);
  };

  for (const tc of toolCalls) {
    if (tc.result === undefined || tc.isError === true) continue;
    if (isToolResultError(tc.result) || isToolResultNotRun(tc.result)) continue;

    if (tc.name === TOOL_NAMES.PRESENT_FILES) {
      const declared = parsePresentedFilesInput(tc.input.files);
      const presented = parsePresentedResult(tc.result);
      if (presented === null || presented.length !== declared.length) continue;
      presented.forEach((path, index) => add(path, declared[index].description));
      continue;
    }

    if (tc.name === TOOL_NAMES.GENERATE_IMAGE || tc.name === TOOL_NAMES.PROCESS_IMAGE) {
      const outputPath = mediaToolOutputPath(tc);
      if (outputPath) add(outputPath);
    }
  }

  return files;
}
