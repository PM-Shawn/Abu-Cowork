/**
 * Sidecar shim for `src/core/logging/logger.ts`.
 *
 * The real logger writes warn/error to disk via Tauri's `appDataDir`/plugin-fs
 * (browser/webview-only APIs unavailable in a plain Node process) and does
 * ring-buffer bookkeeping for a UI log viewer that doesn't exist in the
 * sidecar. Swapped in at bundle time by `scripts/build-sidecar.mjs` (esbuild
 * plugin, resolved-absolute-path match) for every `createLogger()` call
 * reached transitively from the LLM adapters. Same public surface
 * (`createLogger(module) -> Logger`), stderr-only — stdout is reserved for
 * JSON-RPC protocol lines (see sidecar/src/protocol.ts).
 */

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(module: string, level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const prefix = `[sidecar:${module}] [${level}]`;
  if (data !== undefined) {
    console.error(prefix, message, data);
  } else {
    console.error(prefix, message);
  }
}

export function createLogger(module: string): Logger {
  return {
    debug: (message, data) => log(module, 'debug', message, data),
    info: (message, data) => log(module, 'info', message, data),
    warn: (message, data) => log(module, 'warn', message, data),
    error: (message, data) => log(module, 'error', message, data),
  };
}
