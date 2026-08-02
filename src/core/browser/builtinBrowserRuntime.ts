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
