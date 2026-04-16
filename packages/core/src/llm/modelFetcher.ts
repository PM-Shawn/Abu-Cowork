import type { ModelInfo } from '../../../../src/types/provider';
import type { ApiFormat } from '../../../../src/types';
import type { FetchAdapter } from '../ports/adapters/fetch';

export interface FetchModelsResult {
  success: boolean;
  models: ModelInfo[];
  error?: string;
}

/**
 * 对比 Abu 原版改动：
 * - 原版调用全局 fetch；
 * - 新版通过 FetchAdapter 注入，Tauri/Node 各自实现。
 */
export async function fetchProviderModels(
  fetchAdapter: FetchAdapter,
  baseUrl: string,
  apiKey: string,
  apiFormat: ApiFormat
): Promise<FetchModelsResult> {
  if (apiFormat === 'anthropic') {
    return { success: false, models: [], error: 'Anthropic API does not support model listing' };
  }

  try {
    const url = baseUrl.replace(/\/+$/, '');
    const modelsUrl = url.endsWith('/v1') ? `${url}/models` : `${url}/v1/models`;

    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await fetchAdapter.fetch(modelsUrl, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      return { success: false, models: [], error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    const rawModels = data.data ?? [];

    const EXCLUDE_PATTERNS = [
      'embedding',
      'whisper',
      'tts',
      'dall-e',
      'moderation',
      'davinci',
      'babbage',
    ];

    const models: ModelInfo[] = rawModels
      .filter((m: { id: string }) => {
        const id = m.id.toLowerCase();
        return !EXCLUDE_PATTERNS.some((p) => id.includes(p));
      })
      .map((m: { id: string }) => ({ id: m.id, label: m.id }));

    return { success: true, models };
  } catch (e) {
    return {
      success: false,
      models: [],
      error: e instanceof Error ? e.message : 'Fetch failed',
    };
  }
}
