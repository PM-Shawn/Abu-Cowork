import type { ProviderInstance } from '@/types/provider';
import { getTauriFetch } from './tauriFetch';
import { resolveOpenAIBaseUrl } from './urlUtils';
import { LOCAL_ESTIMATE_CAP, positiveInteger } from './contextWindow';
import { localServerKind } from './localProvider';

export const CONTEXT_PROBE_TIMEOUT_MS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** 服务不支持这个接口、超时或连不上都返回 undefined，调用方转到下一级。 */
async function getJson(url: string, init: RequestInit = {}): Promise<unknown> {
  const fetchFn = await getTauriFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONTEXT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    // 设计要求询问失败时静默，不打断对话
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function stripV1(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

export function ollamaApiRoot(baseUrl: string): string {
  return stripV1(baseUrl);
}

export async function fetchOllamaTrainingContext(baseUrl: string, modelId: string): Promise<number | undefined> {
  const data = await getJson(`${ollamaApiRoot(baseUrl)}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId }),
  });
  if (!isRecord(data) || !isRecord(data.model_info)) return undefined;
  const info = data.model_info;
  const architecture = info['general.architecture'];
  if (typeof architecture === 'string') {
    const exact = positiveInteger(info[`${architecture}.context_length`]);
    if (exact !== undefined) return exact;
  }
  const anyKey = Object.keys(info).find((key) => key.endsWith('.context_length'));
  return anyKey === undefined ? undefined : positiveInteger(info[anyKey]);
}

/** Ollama 的窗口由阿布决定：训练上限与 32768 取小。 */
export async function fetchOllamaContextWindows(baseUrl: string, modelIds: readonly string[]): Promise<Map<string, number>> {
  const entries = await Promise.all(modelIds.map(async (id) => [id, await fetchOllamaTrainingContext(baseUrl, id)] as const));
  const windows = new Map<string, number>();
  for (const [id, trained] of entries) {
    if (trained !== undefined) windows.set(id, Math.min(trained, LOCAL_ESTIMATE_CAP));
  }
  return windows;
}

export async function fetchLmStudioContextWindows(baseUrl: string): Promise<Map<string, number>> {
  const data = await getJson(`${stripV1(baseUrl)}/api/v0/models`);
  const windows = new Map<string, number>();
  for (const entry of records(isRecord(data) ? data.data : undefined)) {
    const size = positiveInteger(entry.loaded_context_length) ?? positiveInteger(entry.max_context_length);
    if (typeof entry.id === 'string' && size !== undefined) windows.set(entry.id, size);
  }
  return windows;
}

export async function fetchLlamaCppContextWindows(baseUrl: string, apiKey: string): Promise<Map<string, number>> {
  const data = await getJson(`${resolveOpenAIBaseUrl(baseUrl)}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  const windows = new Map<string, number>();
  for (const entry of records(isRecord(data) ? data.data : undefined)) {
    const size = isRecord(entry.meta) ? positiveInteger(entry.meta.n_ctx) : undefined;
    if (typeof entry.id === 'string' && size !== undefined) windows.set(entry.id, size);
  }
  return windows;
}

/** 7.2 第 2 步：本地服务商问一次服务实际能记多长。非本地服务商不发请求。 */
export async function probeContextWindow(provider: ProviderInstance, modelId: string): Promise<number | undefined> {
  switch (localServerKind(provider)) {
    case 'ollama': {
      const trained = await fetchOllamaTrainingContext(provider.baseUrl, modelId);
      return trained === undefined ? undefined : Math.min(trained, LOCAL_ESTIMATE_CAP);
    }
    case 'lmstudio':
      return (await fetchLmStudioContextWindows(provider.baseUrl)).get(modelId);
    case 'custom-local': {
      const windows = await fetchLlamaCppContextWindows(provider.baseUrl, provider.apiKey);
      // llama.cpp 单模型服务不看请求里的模型名，只列出一个时就是它
      return windows.get(modelId) ?? (windows.size === 1 ? [...windows.values()][0] : undefined);
    }
    case null:
      return undefined;
  }
}
