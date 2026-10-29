import type { ToolResultFileRef } from '@/types';

export const SPILL_NOTE_ENDING = 'Read the part you need with read_file using offset and limit, or search it with search_files.]';
const SPILL_NOTE = /^\[The full output(?: \((\d+) characters\))? is saved at (.+)\. Read the part you need with read_file using offset and limit, or search it with search_files\.\]$/;
const MISSING_NOTE = '[The full output file is unavailable; only the saved preview remains.]';

/** Recognizes only the application's generated final line. */
export function readToolResultFileReference(result: string, conversationId: string): ToolResultFileRef | undefined {
  const line = result.slice(result.lastIndexOf('\n') + 1);
  const match = SPILL_NOTE.exec(line);
  if (match) {
    const normalized = match[2].replace(/\\/g, '/');
    const prefix = `/conversations/${conversationId}/results/`;
    const boundary = normalized.lastIndexOf(prefix);
    if (boundary < 0) return undefined;
    const filename = normalized.slice(boundary + prefix.length);
    if (!/^[A-Za-z0-9_-]+\.txt$/.test(filename)) return undefined;
    return { relPath: `results/${filename}` };
  }
  if (result.startsWith('[session-memory:')) {
    const end = result.indexOf(']');
    const id = result.slice('[session-memory:'.length, end);
    if (end > 0 && /^[A-Za-z0-9_-]+$/.test(id)) return { relPath: `results/${id}.txt`, legacy: true };
  }
  return undefined;
}

export function rewriteToolResultFileNote(result: string, childPath: string, missing: boolean): string {
  const replacement = missing
    ? MISSING_NOTE
    : `[The full output is saved at ${childPath}. ${SPILL_NOTE_ENDING}`;
  if (result.startsWith('[session-memory:')) {
    const end = result.indexOf(']');
    return `${result.slice(end + 1).trimStart()}\n\n${replacement}`;
  }
  const start = result.lastIndexOf('\n') + 1;
  const line = result.slice(start);
  if (SPILL_NOTE.test(line) || line === MISSING_NOTE) {
    return result.slice(0, start) + replacement;
  }
  // A structured reference remains usable even when its preview has no footer.
  return `${result}\n\n${replacement}`;
}
