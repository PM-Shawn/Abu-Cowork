import type { ProviderInstance } from '@/types/provider';
import { getTauriFetch } from './tauriFetch';
import { resolveOpenAIBaseUrl } from './urlUtils';
import { positiveInteger } from './contextWindow';
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

/**
 * Ollama 报告已加载模型时的名字总带标签：server/routes.go:2338 用
 * model.ParseName(m.ShortName).DisplayShortest() 生成，types/model/name.go:244-248 固定写成
 * 「模型:标签」，没写标签的名字由 ParseName 补上 latest（name.go:41,56）。阿布这边的模型名
 * 来自 /api/tags，同样带标签；用户手填的名字可能没有标签，比较前补上 :latest。
 */
function ollamaModelKey(name: string): string {
  const slash = name.lastIndexOf('/');
  return name.includes(':', slash + 1) ? name : `${name}:latest`;
}

/**
 * Ollama 按它自己的设置加载模型，实际长度只能从已加载的模型上读：GET /api/ps 返回
 * `models[]`，每条带 `name` 与 `context_length`（api/types.go:854-863 ProcessModelResponse，
 * server/routes.go:2333-2364 PsHandler 填的是运行器实际使用的 v.contextLength）。
 * 返回的 Map 以传入的 modelIds 为键，没加载的模型不在其中。
 */
export async function fetchOllamaLoadedContextWindows(baseUrl: string, modelIds: readonly string[]): Promise<Map<string, number>> {
  const data = await getJson(`${ollamaApiRoot(baseUrl)}/api/ps`);
  const loaded = new Map<string, number>();
  for (const entry of records(isRecord(data) ? data.models : undefined)) {
    const size = positiveInteger(entry.context_length);
    if (typeof entry.name === 'string' && size !== undefined) loaded.set(ollamaModelKey(entry.name), size);
  }
  const windows = new Map<string, number>();
  for (const id of modelIds) {
    const size = loaded.get(ollamaModelKey(id));
    if (size !== undefined) windows.set(id, size);
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
    case 'ollama':
      // 模型还没加载时问不到，调用方按下一级取值；第一次请求让 Ollama 加载后就能问到
      return (await fetchOllamaLoadedContextWindows(provider.baseUrl, [modelId])).get(modelId);
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
