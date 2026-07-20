/**
 * JSON-RPC 2.0 over NDJSON wire helpers — shared by main.ts.
 *
 * Ported byte-compatibly from the P1-0 handwritten `sidecar/index.mjs` (see that
 * file's git history / P1-0-REPORT.md). Protocol discipline (unchanged from P1-0):
 *   - stdin:  one JSON-RPC 2.0 message per line (LF-terminated).
 *   - stdout: one JSON-RPC 2.0 message per line — and ONLY that. Never write logs
 *             or anything else to stdout; the parent treats every stdout line as
 *             a protocol message. All diagnostics go to stderr (see shims/logger.ts).
 *
 * Error codes (JSON-RPC 2.0 standard):
 *   -32700 Parse error       — malformed JSON on a line
 *   -32600 Invalid Request   — non-object / array message, or missing method
 *   -32601 Method not found  — unknown method on a request (has `id`)
 *   -32603 Internal error    — handler threw something we couldn't classify
 *   -32000 Server error      — reserved range for LLMError passthrough (P1-1)
 */

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Thrown by request handlers that want to control the JSON-RPC error code/data
 * sent back to the shell (e.g. LLMError reconstruction data for `llm.chat`).
 * Handlers that throw anything else get wrapped as -32603 Internal error.
 */
export class RpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** Write one JSON-RPC message as a single stdout line (see module doc — stdout is protocol-only). */
export function writeLine(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export function makeError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorRes {
  return { jsonrpc: '2.0', id: id ?? null, error: data !== undefined ? { code, message, data } : { code, message } };
}

export function makeResult(id: string | number | null, result: unknown): JsonRpcResultRes {
  return { jsonrpc: '2.0', id, result };
}

export function makeNotification(method: string, params: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

export interface JsonRpcErrorRes {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorShape;
}

export interface JsonRpcResultRes {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: unknown;
}

/**
 * Convert a caught value from an async request handler into a JSON-RPC error
 * response line. `RpcError` instances carry an explicit code/data (used by
 * `llm.chat` to reconstruct LLMError shape for the shell); anything else
 * collapses to -32603 Internal error with the message as data for diagnosis.
 */
export function errorFromCaught(id: string | number | null, err: unknown): JsonRpcErrorRes {
  if (err instanceof RpcError) {
    return makeError(id, err.code, err.message, err.data);
  }
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  return makeError(id, -32603, 'Internal error', { message, stack });
}

/** Exit only after any queued stdout writes have been flushed to the pipe. */
export function flushAndExit(code: number): void {
  process.stdout.write('', () => process.exit(code));
}
