/**
 * Reading the main process's runtime-observability lines from a running app.
 *
 * `__ABU_SHELL__.getRuntimeDiagnostics()` hands back the most recent event
 * lines as JSON strings. Specs that judge what crossed the shell↔sidecar
 * boundary read them through here so they all see the same shape.
 */
import type { Page } from 'playwright';

export interface RuntimeEvent extends Record<string, unknown> {
  event?: string;
  method?: string;
  rpcId?: string;
  payloadBytes?: number;
}

/** The raw lines, for a spec that has to judge the text itself (leak checks). */
export async function readRuntimeEventLines(page: Page): Promise<string[]> {
  const diagnostics = await page.evaluate(async () => {
    const shell = (window as unknown as {
      __ABU_SHELL__: { getRuntimeDiagnostics: () => Promise<{ recentEventLines: string[] }> };
    }).__ABU_SHELL__;
    return shell.getRuntimeDiagnostics();
  });
  return diagnostics.recentEventLines;
}

/** Lines that are not JSON objects are dropped rather than failing the read. */
export function parseRuntimeEventLines(lines: readonly string[]): RuntimeEvent[] {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as RuntimeEvent];
    } catch {
      return [];
    }
  });
}

/** Runtime-observability lines as the main process currently holds them. */
export async function readRuntimeEvents(page: Page): Promise<RuntimeEvent[]> {
  return parseRuntimeEventLines(await readRuntimeEventLines(page));
}

/** Byte counts the renderer recorded for the RPCs a turn sends. */
export function sentPayloadBytes(events: RuntimeEvent[], method?: string): number[] {
  return events
    .filter((event) => event.event === 'renderer.sidecar_rpc_sent'
      && (method === undefined || event.method === method)
      && typeof event.payloadBytes === 'number')
    .map((event) => event.payloadBytes as number);
}

/**
 * Accumulates `renderer.sidecar_rpc_sent` events across reads, keyed by method
 * and rpcId, so an event that has left the main process's recent-lines window
 * is still counted by a journey that reads after every turn.
 */
export function createSentRpcLog(): { collect(events: RuntimeEvent[]): void; bytes(method: string): number[] } {
  const byKey = new Map<string, { method: string; payloadBytes: number; order: number }>();
  return {
    collect(events) {
      for (const event of events) {
        if (event.event !== 'renderer.sidecar_rpc_sent') continue;
        if (typeof event.method !== 'string' || typeof event.payloadBytes !== 'number') continue;
        const key = `${event.method}:${String(event.rpcId)}`;
        if (!byKey.has(key)) byKey.set(key, { method: event.method, payloadBytes: event.payloadBytes, order: byKey.size });
      }
    },
    bytes(method) {
      return [...byKey.values()]
        .filter((entry) => entry.method === method)
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.payloadBytes);
    },
  };
}
