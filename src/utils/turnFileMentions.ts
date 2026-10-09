import type { ToolCall } from '@/types';
import { resolveExpectedFile } from '@/core/team/expectedFiles';
import { collectPresentedFiles } from '@/utils/presentedFiles';
import { getBaseName, normalizeSeparators } from '@/utils/pathUtils';
import { FILE_CREATE_TOOLS, FILE_WRITE_TOOLS, isToolResultError } from '@/utils/workflowExtractor';

export interface FileMention {
  /** Absolute path with `/` separators, as listed by collectTurnFilePaths. */
  path: string;
  line?: number;
}

/**
 * Absolute paths of the files a turn wrote, created or presented, each once,
 * with `/` separators. Failed and unfinished tool calls contribute nothing.
 */
export function collectTurnFilePaths(
  toolCalls: readonly ToolCall[],
  workspacePath: string | null | undefined,
): string[] {
  const paths = new Set<string>();

  for (const tc of toolCalls) {
    if (!FILE_WRITE_TOOLS.includes(tc.name) && !FILE_CREATE_TOOLS.includes(tc.name)) continue;
    if (tc.result === undefined || tc.isError === true || isToolResultError(tc.result)) continue;
    const input = tc.input as Record<string, unknown>;
    const inputPath = String(input.path || input.file_path || input.filePath || '').trim();
    if (inputPath) paths.add(normalizeSeparators(resolveExpectedFile(inputPath, workspacePath)));
  }

  for (const file of collectPresentedFiles(toolCalls, workspacePath)) paths.add(file.path);

  return Array.from(paths);
}

const LINE_SUFFIX = /(?:#L|:)(\d+)$/;

// A markdown link carries its target percent-encoded; inline code carries it as written.
function sameText(text: string, candidate: string): boolean {
  return text === candidate || text === encodeURI(candidate);
}

function findTurnPath(text: string, turnPaths: readonly string[]): string | null {
  const exact = turnPaths.find((path) => sameText(text, path));
  if (exact) return exact;
  if (text.includes('/')) return null;
  const sameName = turnPaths.filter((path) => sameText(text, getBaseName(path)));
  return sameName.length === 1 ? sameName[0] : null;
}

/**
 * The file of this turn that `text` names, or null. `text` is a full path
 * from `turnPaths`, or a bare file name that exactly one of them carries;
 * a trailing `#L<n>` or `:<n>` is read as a line number.
 */
export function resolveFileMention(text: string, turnPaths: readonly string[]): FileMention | null {
  const mention = normalizeSeparators(text.trim());
  if (!mention) return null;

  const whole = findTurnPath(mention, turnPaths);
  if (whole) return { path: whole };

  const suffix = LINE_SUFFIX.exec(mention);
  if (!suffix) return null;
  const path = findTurnPath(mention.slice(0, suffix.index), turnPaths);
  return path ? { path, line: Number(suffix[1]) } : null;
}
