/**
 * Scratchpad entry classify/format helpers — split out of
 * `src/stores/scratchpadStore.ts` (were defined there under "Helper
 * Functions for EventRouter Integration") so `eventRouter.ts` can import
 * them without dragging in that file's `zustand` `create()` + `persist` +
 * `immer` module-load graph. Third instance of the "pure function trapped in
 * a zustand module" pattern in this worktree, after `settingsStore.ts`'s
 * derive functions (`settingsSelectors.ts`) and `PROVIDER_CONFIGS`
 * (`providerConfigs.ts`) — see `docs/2026-07-20-phase1-p3b-loop-entry-design.md`
 * §5 "3b-1".
 *
 * These four are classify/format functions of their arguments — no
 * scratchpadStore state access. They do call `getI18n()`/`format()`
 * (`@/i18n`), a separate already-catalogued shell-singleton concern (P1-3a-pre
 * §3 / P1-3b-pre §6) unrelated to the zustand-module coupling this move
 * fixes — untouched by this relocation.
 *
 * `scratchpadStore.ts` imports + re-exports all four unchanged so no
 * existing importer needs to change; this file is the source of truth going
 * forward.
 */
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { getI18n, format } from '@/i18n';
import type { ScratchpadEntryType } from '@/stores/scratchpadStore';

/**
 * Generate scratchpad entry title from tool call
 */
export function generateScratchpadTitle(
  _toolName: string,
  toolInput: Record<string, unknown>,
  type: ScratchpadEntryType
): string {
  const path = (toolInput.path || toolInput.file_path || toolInput.filePath) as string | undefined;
  const fileName = path ? path.split(/[/\\]/).pop() : undefined;
  const query = (toolInput.query || toolInput.pattern) as string | undefined;

  const s = getI18n().scratchpad;
  switch (type) {
    case 'extraction':
      return fileName ? format(s.extractionTitleFile, { file: fileName }) : s.extractionTitle;
    case 'analysis':
      return fileName ? format(s.analysisTitleFile, { file: fileName }) : s.analysisTitle;
    case 'search': {
      if (query) {
        const truncated = query.slice(0, 30) + (query.length > 30 ? '...' : '');
        return format(s.searchTitle, { query: truncated });
      }
      return s.searchResultsTitle;
    }
    case 'summary':
      return fileName ? format(s.summaryTitleFile, { file: fileName }) : s.summaryTitle;
    case 'preview':
      return fileName ? format(s.previewTitleFile, { file: fileName }) : s.previewTitle;
    default:
      return s.resultTitle;
  }
}

/**
 * Determine scratchpad entry type from tool name
 */
export function inferScratchpadType(toolName: string): ScratchpadEntryType | null {
  // File read tools → extraction
  if ([TOOL_NAMES.READ_FILE, 'read', 'get_file_contents'].includes(toolName)) {
    return 'extraction';
  }

  // Search tools → search
  if ([TOOL_NAMES.WEB_SEARCH, 'search', 'grep', 'find'].includes(toolName)) {
    return 'search';
  }

  // List directory → preview
  if (toolName === TOOL_NAMES.LIST_DIRECTORY) {
    return 'preview';
  }

  return null;
}

/**
 * Should this tool result be captured in scratchpad?
 */
export function shouldCaptureScratchpad(
  toolName: string,
  result: string
): boolean {
  const type = inferScratchpadType(toolName);
  if (!type) return false;

  // Only capture if result is substantial (not just a status message)
  const minLength = 100;
  if (result.length < minLength) return false;

  // Don't capture error results
  if (result.toLowerCase().startsWith('error:')) return false;

  return true;
}

/**
 * Truncate content for scratchpad preview
 */
export function truncateScratchpadContent(content: string, maxLength: number = 2000): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + `\n\n... (${content.length - maxLength} more characters)`;
}
