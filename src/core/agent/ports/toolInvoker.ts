import type { ToolDefinition, ToolResult, ToolExecutionContext } from '@/types';
import type { ConfirmationInfo } from '@/core/tools/commandSafety';
import { getAllTools, executeAnyTool, toolResultToString } from '@/core/tools/registry';
import { createPortSlot } from './portSlot';

/**
 * Callback type for command confirmation — mirrors registry.ts's
 * `CommandConfirmCallback` 1:1 (kept local rather than imported so this
 * port's type surface doesn't depend on registry.ts even at the type level).
 */
export type CommandConfirmCallback = (info: ConfirmationInfo) => Promise<boolean>;

/**
 * Callback type for file permission requests — mirrors registry.ts's
 * `FilePermissionCallback` 1:1.
 */
export type FilePermissionCallback = (request: {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
}, loopId?: string) => Promise<boolean>;

/**
 * Port #7 — abstracts subagentLoop's tool execution surface (currently a
 * hard `import { getAllTools, executeAnyTool, toolResultToString } from
 * '../tools/registry'`). registry.ts is not bundle-safe on its own: it pulls
 * in `mcpManager`, `useChatStore`, `@tauri-apps/api/path`'s `homeDir`, and
 * the enterprise policy modules — importing it (even just for these three
 * functions) drags that whole shell-singleton graph into any future
 * sidecar/Node bundle. `toolResultToString` is a pure formatter in isolation,
 * but because it's defined *inside* registry.ts, importing it from there
 * still pulls in registry.ts's full module-level import graph (the Tauri
 * `homeDir` import runs at module load, not call time) — so it's folded
 * into this port too rather than kept as a "safe" direct import.
 *
 * This is the seam described in
 * `docs/2026-07-19-phase1-p3-loop-migration-staging.md` §2 "P1-3a-pre" step
 * 2: the future sidecar-side subagent host plugs a reverse-RPC `tool.invoke`
 * implementation here (sidecar asks the shell to run the tool — the shell
 * keeps today's registry + permissions + approvals + pathSafety untouched;
 * see the design doc's "正式步 3a" for the `tool.invoke` reverse channel).
 * Until that lands, `createInProcessToolInvoker()` below is the only
 * implementation and forwards call-by-call to the registry functions — same
 * discipline as `ChatDelta` (see `chatDelta.ts`): no caching, no snapshotting,
 * every call re-forwards to the live functions so a tool registered mid-loop
 * (e.g. a newly connected MCP server) is observed by the very next call.
 */
export interface ToolInvoker {
  /** Mirrors registry.ts's `getAllTools`. */
  getAllTools(): ToolDefinition[];
  /** Mirrors registry.ts's `executeAnyTool`. */
  executeAnyTool(
    name: string,
    input: Record<string, unknown>,
    onRequireConfirmation?: CommandConfirmCallback,
    onRequireFilePermission?: FilePermissionCallback,
    toolContext?: ToolExecutionContext,
    /** Current context window usage (0-100). Scales truncation limits under pressure. */
    contextUsagePercent?: number
  ): Promise<ToolResult>;
  /** Mirrors registry.ts's `toolResultToString`. */
  toolResultToString(result: ToolResult): string;
}

/** Default in-process implementation — forwards to registry.ts at call
 *  time. This is the only module in the agent/ports layer allowed to import
 *  registry.ts directly; every other caller (subagentLoop and, later,
 *  agentLoop/toolExecutor if they migrate to this port) should go through
 *  `getToolInvoker()` instead. */
export function createInProcessToolInvoker(): ToolInvoker {
  return {
    getAllTools: () => getAllTools(),
    executeAnyTool: (name, input, onRequireConfirmation, onRequireFilePermission, toolContext, contextUsagePercent) =>
      executeAnyTool(name, input, onRequireConfirmation, onRequireFilePermission, toolContext, contextUsagePercent),
    toolResultToString: (result) => toolResultToString(result),
  };
}

/** Module-level slot for the app-wide default ToolInvoker — see
 *  `portSlot.ts` for the shared get/set/swap-hook contract every port in
 *  this directory follows. */
const slot = createPortSlot<ToolInvoker>(createInProcessToolInvoker);

export function getToolInvoker(): ToolInvoker {
  return slot.get();
}

export function setToolInvoker(invoker: ToolInvoker): void {
  slot.set(invoker);
}
