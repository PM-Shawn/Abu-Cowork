import type { ModelInfo } from '@/types/provider';
import type { ApiFormat } from '@/types';
import { getTauriFetch } from './tauriFetch';
import { normalizeBaseUrl, resolveOpenAIBaseUrl } from './urlUtils';
import { deriveUiCaps } from './modelCapabilities';

/**
 * Why a fetch failed, in terms the UI can translate. Kept as a code rather
 * than prose because the distinction matters to the user: these three used to
 * collapse into one "this provider doesn't support model listing", which is
 * only true for 404. A 403 means the endpoint is there and this key simply
 * isn't allowed to list — telling that user to give up and type ids by hand
 * hides the fact that another key or config method would work.
 */
export type FetchModelsErrorCode =
  | 'unsupported'    // 404 — no model-list endpoint at this address
  | 'forbidden'      // 403 — endpoint exists, this key may not list models
  | 'unauthorized'   // 401 — key missing / invalid / expired
  | 'http'           // any other non-OK status
  | 'transport';     // request never completed

export interface FetchModelsResult {
  success: boolean;
  models: ModelInfo[];
  /** Diagnostic detail (status line or raw error). Not user-facing prose. */
  error?: string;
  errorCode?: FetchModelsErrorCode;
  status?: number;
}

/** Everything a fetcher needs to build its request. */
export interface FetchModelsContext {
  baseUrl: string;
  apiKey: string;
  apiFormat: ApiFormat;
}

/**
 * One provider family's way of listing models.
 *
 * Resolution is "first match wins" over `FETCHERS`, whose LAST entry matches
 * unconditionally — every OpenAI-compatible endpoint (the overwhelming
 * majority: DeepSeek, Kimi, GLM, MiniMax, Ark, DashScope, gateways, local
 * servers) is served by that one generic implementation, and a vendor only
 * earns its own entry when its listing endpoint genuinely differs. Adding a
 * special case therefore means inserting an entry BEFORE the fallback rather
 * than growing a branch inside the shared path.
 */
interface ModelFetcher {
  /** Diagnostic label — surfaces in the "no fetcher matched" impossible case. */
  name: string;
  match: (ctx: FetchModelsContext) => boolean;
  fetch: (ctx: FetchModelsContext, fetchFn: typeof globalThis.fetch) => Promise<FetchModelsResult>;
}

/**
 * Ids we never want in a chat-model checklist. A raw /models call returns the
 * vendor's whole catalog — embeddings, speech, image and moderation SKUs
 * included — and none of them can be selected as a chat model here.
 *
 * The audio/realtime/sora half of this list mirrors what a competitor applies
 * to OpenAI specifically; we apply the union to every provider because the
 * Chinese vendors serve the same non-chat SKU families off the same endpoint.
 */
const EXCLUDE_PATTERNS = [
  'embedding', 'whisper', 'tts', 'dall-e', 'moderation', 'davinci', 'babbage',
  'transcribe', 'speech', 'audio', 'realtime', 'sora',
];

export function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !EXCLUDE_PATTERNS.some((p) => lower.includes(p));
}

/** Shared non-OK-status → typed failure mapping. */
function failureForStatus(status: number): FetchModelsResult {
  const errorCode: FetchModelsErrorCode =
    status === 404 ? 'unsupported'
    : status === 403 ? 'forbidden'
    : status === 401 ? 'unauthorized'
    : 'http';
  return { success: false, models: [], error: `HTTP ${status}`, errorCode, status };
}

function toModelInfos(ids: { id: string; label?: string }[]): ModelInfo[] {
  return ids
    .filter((m) => isChatModelId(m.id))
    .map((m) => ({ id: m.id, label: m.label || m.id, capabilities: deriveUiCaps(m.id) }));
}

/**
 * Anthropic's Models API.
 *
 * Three things differ from the OpenAI-compatible shape and each one is a
 * silent failure if missed:
 *  - auth is `x-api-key` + `anthropic-version`, NOT `Authorization: Bearer`
 *    (a Bearer header returns 401);
 *  - the response paginates at 20 by default, so `limit` must be sent or the
 *    list is quietly truncated — 1000 is the documented maximum and is far
 *    above the catalog size, making one page enough;
 *  - the display name lives in `display_name`, not in the id.
 */
const anthropicFetcher: ModelFetcher = {
  name: 'anthropic',
  match: (ctx) => ctx.apiFormat === 'anthropic',
  fetch: async (ctx, fetchFn) => {
    const base = normalizeBaseUrl(ctx.baseUrl) || 'https://api.anthropic.com';
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (ctx.apiKey) headers['x-api-key'] = ctx.apiKey;

    const resp = await fetchFn(`${base}/v1/models?limit=1000`, { method: 'GET', headers });
    if (!resp.ok) return failureForStatus(resp.status);

    const data = await resp.json() as { data?: { id: string; display_name?: string }[] };
    const models = toModelInfos(
      (data.data ?? []).map((m) => ({ id: m.id, label: m.display_name })),
    );
    return { success: true, models };
  },
};

/**
 * The always-match fallback: a plain OpenAI-compatible `GET {base}/models`.
 * Must stay LAST in `FETCHERS` — anything after it is unreachable.
 */
const openAICompatibleFetcher: ModelFetcher = {
  name: 'openai-compatible',
  match: () => true,
  fetch: async (ctx, fetchFn) => {
    // Same URL resolution as the chat adapter, so the list and the chat call
    // can never disagree about which endpoint a provider actually is.
    const resolvedBase = resolveOpenAIBaseUrl(ctx.baseUrl);
    const headers: Record<string, string> = {};
    if (ctx.apiKey) headers['Authorization'] = `Bearer ${ctx.apiKey}`;

    const resp = await fetchFn(`${resolvedBase}/models`, { method: 'GET', headers });
    if (!resp.ok) return failureForStatus(resp.status);

    const data = await resp.json() as { data?: { id: string }[] };
    const models = toModelInfos(data.data ?? []);
    return { success: true, models };
  },
};

const FETCHERS: ModelFetcher[] = [
  anthropicFetcher,
  openAICompatibleFetcher, // always-match fallback — must be last
];

/** Fetch the models a provider offers, via whichever fetcher claims it. */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  apiFormat: ApiFormat,
): Promise<FetchModelsResult> {
  const ctx: FetchModelsContext = { baseUrl, apiKey, apiFormat };
  const fetcher = FETCHERS.find((f) => f.match(ctx)) ?? openAICompatibleFetcher;

  try {
    const fetchFn = await getTauriFetch();
    return await fetcher.fetch(ctx, fetchFn);
  } catch (e) {
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { success: false, models: [], error: raw, errorCode: 'transport' };
  }
}
