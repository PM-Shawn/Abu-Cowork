import { mcpManager } from '../mcp/client';
import { hasElectronCommandHost } from '../../utils/electronHost';
import { createLogger } from '../logging/logger';

export const BUILTIN_BROWSER_SERVER_NAME = 'abu-browser';

const logger = createLogger('builtinBrowserRuntime');
let connectPromise: Promise<boolean> | null = null;
let lifecycleGeneration = 0;
let stopped = false;

export async function ensureBuiltinBrowserRuntime(): Promise<boolean> {
  if (!hasElectronCommandHost() || stopped) return false;
  if (mcpManager.isConnected(BUILTIN_BROWSER_SERVER_NAME)) return true;
  if (connectPromise) return connectPromise;

  const generation = lifecycleGeneration;
  connectPromise = mcpManager.connectServer({
    name: BUILTIN_BROWSER_SERVER_NAME,
    transport: 'stdio',
    command: 'abu-browser-runtime',
    args: [],
    env: {},
    enabled: true,
    timeout: 120000,
  }).then(async () => {
    if (stopped || generation !== lifecycleGeneration) {
      await mcpManager.disconnectServer(BUILTIN_BROWSER_SERVER_NAME);
      return false;
    }
    return true;
  }).catch((error) => {
    logger.warn('bundled browser runtime unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }).finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

/**
 * Whether this host's BUILT-IN browser tools are in the tool registry yet.
 *
 * - `ready` — `abu-browser` is connected, so `getAllTools()` lists its tools.
 * - `unavailable` — there is no built-in browser here at all (legacy Tauri /
 *   web build, or the runtime was shut down). Nothing to wait for, and not a
 *   fact worth reporting to a user: the capability simply does not exist.
 * - `not-ready` — the runtime exists but had not finished its handshake
 *   within the caller's budget (still connecting, or the connect failed).
 */
export type BuiltinBrowserToolsReadiness = 'ready' | 'unavailable' | 'not-ready';

/**
 * Wait, up to `timeoutMs`, for the built-in browser's MCP tools to exist.
 *
 * ## Why this exists (issue #389)
 *
 * `abu-browser` connects asynchronously after every renderer load, while
 * `schedulerEngine.start()` immediately ticks to catch up missed tasks. A
 * scheduled run freezes its tool roster at dispatch
 * (`buildScheduledRunPermissionCeiling`), so an overdue browser task that wins
 * that race froze "there is no browser" into its ENTIRE lifetime — the model
 * then only saw `tool "abu-browser__*" is not allowed for this agent run`,
 * with no retry, even though the runtime came up seconds later.
 *
 * `runAgentLoopDispatched` already awaits `ensureBuiltinBrowserRuntime()`
 * before it runs anything; this is the same wait, made available to the one
 * caller that needs the roster BEFORE dispatch, and bounded because an
 * unattended run must not hang forever on a runtime that will never arrive.
 *
 * Deliberately only the built-in server: a third-party MCP server can be slow,
 * unreachable, or user-disabled, and no scheduled run should sit behind it.
 *
 * Zero-cost when the answer is already known: a connected runtime (or a host
 * without one) returns without creating a timer or awaiting a tick, so this
 * adds no latency to the normal 9am run.
 */
export async function waitForBuiltinBrowserTools(
  options: { timeoutMs: number },
): Promise<BuiltinBrowserToolsReadiness> {
  if (!hasElectronCommandHost() || stopped) return 'unavailable';
  if (mcpManager.isConnected(BUILTIN_BROWSER_SERVER_NAME)) return 'ready';
  if (options.timeoutMs <= 0) return 'not-ready';

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // Never rejects — `ensureBuiltinBrowserRuntime` reports failure as
      // `false`, which is "no browser tools for this run" just like a timeout.
      ensureBuiltinBrowserRuntime().then<BuiltinBrowserToolsReadiness>(
        (connected) => (connected ? 'ready' : 'not-ready'),
      ),
      new Promise<BuiltinBrowserToolsReadiness>((resolve) => {
        timer = setTimeout(() => resolve('not-ready'), options.timeoutMs);
      }),
    ]);
  } finally {
    // The connect attempt keeps running after a timeout (the next run, and the
    // dispatch itself, benefit from it); only this deadline is cleared.
    if (timer) clearTimeout(timer);
  }
}

export function initBuiltinBrowserRuntime(): void {
  stopped = false;
  lifecycleGeneration += 1;
  void ensureBuiltinBrowserRuntime();
}

export async function cleanupBuiltinBrowserRuntime(): Promise<void> {
  stopped = true;
  lifecycleGeneration += 1;
  const pending = connectPromise;
  if (pending) await pending;
  await mcpManager.disconnectServer(BUILTIN_BROWSER_SERVER_NAME);
}
