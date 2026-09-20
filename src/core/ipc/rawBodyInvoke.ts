/**
 * The single place that decides how conversation-sized text crosses the
 * Electron IPC boundary (#549). Electron renderer: UTF-8 bytes on the
 * raw-body channel (128 MiB) with a small closed header set that
 * `electron/securityBoundary.cjs` validates per command. Anything else
 * (Tauri legacy, web preview, unit tests, the Node sidecar's invoke shim):
 * the original plain-args form (8 MiB). `invoke` is called synchronously so
 * existing observers see the write before this function returns.
 */
import { invoke } from '@tauri-apps/api/core';
import { hasElectronRawBodyInvoke } from '@/utils/electronHost';
import {
  IPC_MAX_ARGS_BYTES,
  IPC_MAX_RAW_BODY_BYTES,
  PayloadTooLargeError,
  parsePayloadTooLargeError,
} from './payloadTooLarge';

export type TextRawBodyCommand = 'mcp_write' | 'append_file_text' | 'atomic_write_text';

const TEXT_ARG_KEY: Record<TextRawBodyCommand, 'message' | 'data' | 'content'> = {
  mcp_write: 'message',
  append_file_text: 'data',
  atomic_write_text: 'content',
};

/**
 * Optional `mcp_write` diagnostic headers accepted by the main process. `id`
 * is deliberately absent: it always comes from `target`, never from meta.
 */
const MCP_WRITE_META_KEYS = ['method', 'rpcId', 'runId', 'clientMessageId', 'payloadDigest'] as const;
/** Main-process per-header byte cap (non-path headers). */
const MAX_META_VALUE_BYTES = 256;

const encoder = new TextEncoder();

export interface InvokeTextCommandOptions {
  /** Label for errors/traces (JSON-RPC method for mcp_write). */
  method?: string;
  /**
   * mcp_write diagnostic headers (method/rpcId/runId/clientMessageId/
   * payloadDigest). Values that the main process would reject (empty, NUL,
   * over 256 UTF-8 bytes) and unknown keys are dropped — they are
   * diagnostics only and must never make the write itself fail.
   */
  meta?: Record<string, string>;
  /** Pre-encoded `text` (UTF-8), when the caller already measured it. */
  encoded?: Uint8Array;
}

/** UTF-8 byte length without allocating (a lone surrogate encodes as U+FFFD = 3 bytes). */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function usableMetaValue(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_META_VALUE_BYTES
    && !value.includes('\u0000')
    && utf8ByteLength(value) <= MAX_META_VALUE_BYTES;
}

function mcpWriteHeaders(id: string, meta: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = { id };
  if (!meta) return headers;
  for (const key of MCP_WRITE_META_KEYS) {
    if (!Object.hasOwn(meta, key)) continue;
    const value = meta[key];
    if (usableMetaValue(value)) headers[key] = value;
  }
  return headers;
}

export function invokeTextCommand(
  cmd: TextRawBodyCommand,
  target: { id: string } | { path: string },
  text: string,
  options: InvokeTextCommandOptions = {},
): Promise<void> {
  const method = options.method ?? cmd;
  const relabel = (err: unknown): never => {
    throw parsePayloadTooLargeError(err, method) ?? err;
  };
  try {
    const bytes = options.encoded ?? encoder.encode(text);
    if (hasElectronRawBodyInvoke()) {
      if (bytes.byteLength > IPC_MAX_RAW_BODY_BYTES) {
        return Promise.reject(new PayloadTooLargeError(bytes.byteLength, IPC_MAX_RAW_BODY_BYTES, method));
      }
      const headers = 'id' in target
        ? mcpWriteHeaders(target.id, options.meta)
        : { path: encodeURIComponent(target.path) };
      return Promise.resolve(invoke<void>(cmd, bytes, { headers })).catch(relabel);
    }
    // The plain form is measured by main/preload over all string values and
    // keys; the text dominates, so checking it alone keeps this a cheap
    // early refusal while the boundary stays authoritative.
    if (bytes.byteLength > IPC_MAX_ARGS_BYTES) {
      return Promise.reject(new PayloadTooLargeError(bytes.byteLength, IPC_MAX_ARGS_BYTES, method));
    }
    // Promise.resolve: some test doubles return a bare value.
    return Promise.resolve(invoke<void>(cmd, { ...target, [TEXT_ARG_KEY[cmd]]: text })).catch(relabel);
  } catch (err) {
    return Promise.reject(err);
  }
}
