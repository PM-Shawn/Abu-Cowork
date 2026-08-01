import type { ToolResult, ToolResultContent } from '@/types';

/**
 * Extract text-only representation from a ToolResult. For string results,
 * returns as-is. For rich content arrays, extracts text blocks.
 *
 * Relocated out of `registry.ts` (P1-3B-3A item 2) to a zero-import leaf
 * module — `registry.ts` drags the heaviest DRAGGER cluster in the app
 * (`mcpManager`/`useChatStore`/`@tauri-apps/api/path`/enterprise policy
 * modules), so pulling it in just for this one pure formatter would defeat
 * the sidecar's `ToolInvoker` port shim's whole reason for existing (see
 * `ports/toolInvoker.ts`'s own doc comment on exactly this). Before this
 * relocation, `sidecar/src/subagentHost.ts` carried its OWN hand-copied
 * duplicate of this function ("Mirrors src/core/tools/registry.ts's
 * toolResultToString exactly") — a documented-but-real drift risk (P1-3a).
 * Both `subagentHost.ts`'s reverse `ToolInvoker` and `agentLoopHost.ts`'s
 * (P1-3B-3A) now import this SAME relocated function — single source, zero
 * duplication. `registry.ts` re-exports it for existing callers.
 */
export function toolResultToString(result: ToolResult): string {
  if (typeof result === 'string') return result;
  return (
    result
      .filter((c): c is Extract<ToolResultContent, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n') || '[image]'
  );
}
