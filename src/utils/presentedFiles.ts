import type { ToolCall } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { parsePresentedFilesInput } from '@/core/tools/definitions/presentTools';
import { resolveExpectedFile } from '@/core/team/expectedFiles';
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
 * process_image. A path keeps the position of its first appearance and takes
 * the description of its latest one.
 */
export function collectPresentedFiles(
  toolCalls: readonly ToolCall[],
  workspacePath: string | null | undefined,
): PresentedFile[] {
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
    if (tc.result === undefined || tc.isError === true || isToolResultError(tc.result)) continue;

    if (tc.name === TOOL_NAMES.PRESENT_FILES) {
      for (const file of parsePresentedFilesInput(tc.input.files)) {
        add(resolveExpectedFile(file.path, workspacePath), file.description);
      }
      continue;
    }

    if (tc.name === TOOL_NAMES.GENERATE_IMAGE || tc.name === TOOL_NAMES.PROCESS_IMAGE) {
      const outputPath = mediaToolOutputPath(tc);
      if (outputPath) add(outputPath);
    }
  }

  return files;
}
