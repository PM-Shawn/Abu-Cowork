// @vitest-environment node
/**
 * payload_too_large crosses three places that cannot import each other:
 * the main process (electron/ipcPayloadError.cjs, thrown by
 * electron/securityBoundary.cjs), the sandboxed preload (electron/preload.cjs,
 * which inlines the same format) and the renderer parser (./payloadTooLarge).
 * Electron IPC keeps only `message`, so the three strings must be identical.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  formatPayloadTooLargeMessage,
  IPC_MAX_ARGS_BYTES,
  IPC_MAX_RAW_BODY_BYTES,
  parsePayloadTooLargeError,
} from './payloadTooLarge';

const require_ = createRequire(import.meta.url);
const electronDir = fileURLToPath(new URL('../../../electron/', import.meta.url));
const main = require_(join(electronDir, 'ipcPayloadError.cjs')) as {
  createPayloadTooLargeError: (f: { bytes: number; limit: number; method: string }) => Error;
};
const boundary = require_(join(electronDir, 'securityBoundary.cjs')) as {
  validateInvokePayload: (record: unknown, payload: unknown) => unknown;
};

type PreloadInvoke = (cmd: string, args?: unknown, options?: unknown) => unknown;

function loadPreloadInvoke(): PreloadInvoke {
  const exposed = new Map<string, unknown>();
  const context: Record<string, unknown> = {
    require: () => ({
      contextBridge: { exposeInMainWorld: (key: string, value: unknown) => exposed.set(key, value) },
      ipcRenderer: { invoke: async () => undefined, on() {}, send() {}, sendSync: () => null },
      webUtils: { getPathForFile: () => '' },
    }),
  };
  context.globalThis = context;
  runInNewContext(readFileSync(join(electronDir, 'preload.cjs'), 'utf8'), context, { filename: 'preload.cjs' });
  return (exposed.get('__TAURI_INTERNALS__') as { invoke: PreloadInvoke }).invoke;
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    // The preload runs in a vm realm, so its Error is not `instanceof Error` here.
    return String((err as { message?: unknown }).message);
  }
  throw new Error('expected a throw');
}

describe('payload_too_large contract (main ↔ preload ↔ renderer)', () => {
  it('the renderer formats and parses exactly what main throws', () => {
    const fields = { bytes: 11, limit: 10, method: 'mcp_write' };
    const err = main.createPayloadTooLargeError(fields);
    expect(err.message).toBe(formatPayloadTooLargeMessage(fields));
    expect(parsePayloadTooLargeError(new Error(`Error invoking remote method 'tauri:invoke': Error: ${err.message}`)))
      .toMatchObject(fields);
  });

  it('the renderer limits match the main-process limits', () => {
    const record = { label: 'main' };
    const args = { id: 'a', message: 'x'.repeat(IPC_MAX_ARGS_BYTES) };
    const bytes = 'id'.length + 'a'.length + 'message'.length + IPC_MAX_ARGS_BYTES;
    const expected = formatPayloadTooLargeMessage({ bytes, limit: IPC_MAX_ARGS_BYTES, method: 'mcp_write' });
    expect(thrownMessage(() => boundary.validateInvokePayload(record, { cmd: 'mcp_write', args }))).toBe(expected);
    expect(thrownMessage(() => boundary.validateInvokePayload(record, {
      cmd: 'mcp_write', body: new Uint8Array(IPC_MAX_RAW_BODY_BYTES + 1), headers: { id: 'a' },
    }))).toBe(formatPayloadTooLargeMessage({
      bytes: IPC_MAX_RAW_BODY_BYTES + 1,
      limit: IPC_MAX_RAW_BODY_BYTES,
      method: 'mcp_write',
    }));
  });

  it('the preload throws the same message for the same args', () => {
    const invoke = loadPreloadInvoke();
    const args = { id: 'a', message: 'x'.repeat(IPC_MAX_ARGS_BYTES) };
    const bytes = 'id'.length + 'a'.length + 'message'.length + IPC_MAX_ARGS_BYTES;
    const message = thrownMessage(() => invoke('mcp_write', args));
    expect(message).toBe(formatPayloadTooLargeMessage({ bytes, limit: IPC_MAX_ARGS_BYTES, method: 'mcp_write' }));
    expect(parsePayloadTooLargeError(new Error(message))).toMatchObject({ bytes, limit: IPC_MAX_ARGS_BYTES });
  });
});
