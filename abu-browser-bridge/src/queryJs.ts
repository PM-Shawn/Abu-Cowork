import { Worker } from 'node:worker_threads';

export const QUERY_JS_TIMEOUT_MS = 10_000;
export const QUERY_JS_HTML_LIMIT_BYTES = 2 * 1024 * 1024;
export const QUERY_JS_OUTPUT_LIMIT_CHARS = 30_000;
export const QUERY_JS_WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 32,
  codeRangeSizeMb: 16,
  stackSizeMb: 4,
} as const;
export const QUERY_JS_READONLY_NOTE =
  'note: this ran against a read-only copy — the live page was not modified';

interface QueryJsWorkerMessage {
  ok: boolean;
  json?: string;
  error?: string;
}

interface EvaluateQueryJsOptions {
  timeoutMs?: number;
  htmlLimitBytes?: number;
  outputLimitChars?: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function trimToBudget(text: string, outputLimitChars: number = QUERY_JS_OUTPUT_LIMIT_CHARS): string {
  const note = `\n${QUERY_JS_READONLY_NOTE}`;
  if (text.length + note.length <= outputLimitChars) return `${text}${note}`;

  const truncation = `\n\n[Truncated: output exceeded ${outputLimitChars} characters. Return fewer fields or use a narrower selector.]\n${QUERY_JS_READONLY_NOTE}`;
  const keep = Math.max(0, outputLimitChars - truncation.length);
  return `${text.slice(0, keep)}${truncation}`;
}

export async function evaluateQueryJsOnHtml(
  html: string,
  code: string,
  options: EvaluateQueryJsOptions = {},
): Promise<string> {
  const htmlLimitBytes = options.htmlLimitBytes ?? QUERY_JS_HTML_LIMIT_BYTES;
  const size = byteLength(html);
  if (size > htmlLimitBytes) {
    throw new Error(
      `Page HTML is too large for query_js (${size} bytes, limit ${htmlLimitBytes}). ` +
        'Pass `selector` to query only the smallest subtree that contains the data you need.',
    );
  }

  const worker = new Worker(new URL('./queryJsWorker.mjs', import.meta.url), {
    workerData: { html, code },
    resourceLimits: QUERY_JS_WORKER_RESOURCE_LIMITS,
  });

  try {
    const message = await new Promise<QueryJsWorkerMessage>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? QUERY_JS_TIMEOUT_MS;
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error(`query_js timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      worker.once('message', (value: QueryJsWorkerMessage) => {
        clearTimeout(timer);
        resolve(value);
      });
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once('exit', (codeValue) => {
        clearTimeout(timer);
        if (codeValue !== 0) reject(new Error(`query_js worker exited with code ${codeValue}`));
      });
    });

    if (!message.ok) throw new Error(message.error || 'query_js failed');
    return trimToBudget(message.json ?? 'null', options.outputLimitChars);
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}
