/**
 * Sidecar-local replacement for `src/core/agent/ports/toolInvoker.ts`.
 *
 * Same bundle-graph-only reason as `settingsReaderRun.ts` (see that file's
 * doc for the full explanation) — `subagentLoop.ts`'s
 * `options.toolInvoker ?? getToolInvoker()` fallback is provably never
 * taken in the sidecar (`subagentHost.ts` always injects a per-run
 * reverse-RPC `ToolInvoker`), but the REAL module's default factory
 * (`createInProcessToolInvoker`) imports `src/core/tools/registry.ts` —
 * one of the heaviest modules in the whole app (`mcpManager`, `useChatStore`,
 * every tool definition file, `@tauri-apps/api/path`'s `homeDir`, the
 * enterprise policy modules). Throws if ever actually reached, same
 * "escalate cleanly, don't silently degrade" reasoning as
 * `settingsReaderRun.ts`.
 */
import type { ToolInvoker } from '@/core/agent/ports/toolInvoker';

function throwingDefault(): ToolInvoker {
  const throwFn = (): never => {
    throw new Error(
      '[sidecar] getToolInvoker() fallback reached inside the sidecar bundle — subagentHost.ts should always inject an explicit toolInvoker for every sidecar-run subagent. This indicates a wiring bug in subagentHost.ts, not a legitimate "no tools available" case.',
    );
  };
  return {
    getAllTools: throwFn,
    executeAnyTool: throwFn,
    toolResultToString: throwFn,
  };
}

let current: ToolInvoker = throwingDefault();

export function getToolInvoker(): ToolInvoker {
  return current;
}

export function setToolInvoker(invoker: ToolInvoker): void {
  current = invoker;
}
