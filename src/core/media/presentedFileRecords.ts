import type { ToolCall } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';

export interface PresentedFileInput {
  path: string;
  description?: string;
}

export function parsePresentedFilesInput(raw: unknown): PresentedFileInput[] {
  if (!Array.isArray(raw)) return [];
  const files: PresentedFileInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { path, description } = entry as Record<string, unknown>;
    if (typeof path !== 'string' || !path.trim()) continue;
    files.push(typeof description === 'string' && description !== ''
      ? { path: path.trim(), description } : { path: path.trim() });
  }
  return files;
}

export const PRESENTED_RESULT_PREFIX = 'Presented ';

export function parsePresentedResult(result: string): string[] | null {
  const paths: string[] = [];
  for (const line of result.split('\n')) {
    if (line.trim() === '') continue;
    if (!line.startsWith(PRESENTED_RESULT_PREFIX)) return null;
    paths.push(line.slice(PRESENTED_RESULT_PREFIX.length));
  }
  return paths;
}

export function isToolResultError(result: string): boolean {
  const trimmed = result.trimStart();
  return trimmed.startsWith('Error:') || trimmed.startsWith('Error ');
}

export function mediaToolAnnouncedPath(tc: ToolCall): string | null {
  if (!tc.result) return null;
  if (tc.name === TOOL_NAMES.GENERATE_IMAGE) {
    const match = tc.result.match(/(?:图片已保存到|Image saved to): (.+?)(?:\n|$)/);
    return match ? match[1].trim() : null;
  }
  if (tc.name === TOOL_NAMES.PROCESS_IMAGE) {
    const match = tc.result.match(/(?:Image processed successfully|图片处理成功): (.+?)(?:\n|$)/);
    return match ? match[1].trim() : null;
  }
  return null;
}
