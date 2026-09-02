import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, type BrowserTransport, type BrowserTransportResponse } from '../../abu-browser-bridge/src/tools.ts';
import { linkAbortSignal } from '../../abu-browser-bridge/src/abortSignal.ts';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

interface RuntimeConfig {
  endpoint: URL;
  token: string;
}

interface RuntimeRequest {
  id: string;
  action: string;
  payload: Record<string, unknown>;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `browser_runtime_${Date.now().toString(36)}_${requestCounter.toString(36)}`;
}

function loadConfig(): RuntimeConfig {
  const rawEndpoint = process.env.ABU_BROWSER_RUNTIME_ENDPOINT?.trim();
  const token = process.env.ABU_BROWSER_RUNTIME_TOKEN;
  if (!rawEndpoint) {
    throw new Error('ABU_BROWSER_RUNTIME_ENDPOINT is required');
  }
  if (!token) {
    throw new Error('ABU_BROWSER_RUNTIME_TOKEN is required');
  }

  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error('ABU_BROWSER_RUNTIME_ENDPOINT must be a valid URL');
  }

  if (endpoint.protocol !== 'http:') {
    throw new Error('ABU_BROWSER_RUNTIME_ENDPOINT must use http on a loopback host');
  }
  if (!LOOPBACK_HOSTS.has(endpoint.hostname)) {
    throw new Error('ABU_BROWSER_RUNTIME_ENDPOINT must point to a loopback host');
  }

  return { endpoint, token };
}

function errorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'Browser runtime request timed out';
  }
  return err instanceof Error ? err.message : String(err);
}

function isBridgeResponse(value: unknown): value is BrowserTransportResponse & { id?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { success?: unknown }).success === 'boolean'
  );
}

class HttpBrowserTransport implements BrowserTransport {
  constructor(private readonly config: RuntimeConfig) {}

  isConnected(): boolean {
    return true;
  }

  getConnectionError(): string {
    return 'Electron browser runtime endpoint is not configured or reachable.';
  }

  getStatusMessage(): string {
    return 'Electron browser runtime transport is configured and ready.';
  }

  async send(
    action: string,
    payload: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
    opts?: { signal?: AbortSignal }
  ): Promise<BrowserTransportResponse> {
    const id = nextRequestId();
    const body: RuntimeRequest = { id, action, payload };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Fires immediately (before the fetch below ever starts) if opts.signal
    // is already aborted, and is always detached in `finally` so an
    // unrelated later abort on the caller's signal can't fire into a
    // settled/reused controller.
    const unlink = linkAbortSignal(opts?.signal, () => controller.abort());

    try {
      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Browser runtime request failed with HTTP ${response.status}`);
      }

      const data = await response.json() as unknown;
      if (!isBridgeResponse(data)) {
        throw new Error('Browser runtime returned an invalid response');
      }
      if (typeof data.id === 'string' && data.id !== id) {
        throw new Error('Browser runtime returned a mismatched response id');
      }
      return data;
    } catch (err) {
      throw new Error(errorMessage(err), { cause: err });
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }
}

async function main(): Promise<void> {
  const transport = new HttpBrowserTransport(loadConfig());
  const server = new McpServer({
    name: 'abu-electron-browser-runtime',
    version: '0.1.0',
  });

  registerTools(server, transport);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`Electron browser runtime failed: ${errorMessage(err)}\n`);
  process.exit(1);
});
