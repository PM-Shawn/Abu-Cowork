import type { ModelInfo } from '@/types/provider';
import type { ApiFormat } from '@/types';
import { getTauriFetch } from './tauriFetch';
import { resolveOpenAIBaseUrl } from './urlUtils';
import { deriveUiCaps } from './modelCapabilities';

export interface FetchModelsResult {
  success: boolean;
  models: ModelInfo[];
  error?: string;
}

const EXCLUDE_PATTERNS = ['embedding', 'whisper', 'tts', 'dall-e', 'moderation', 'davinci', 'babbage'];

/** Fetch available models from a provider's GET /models endpoint */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  apiFormat: ApiFormat
): Promise<FetchModelsResult> {
  if (apiFormat === 'anthropic') {
    return { success: false, models: [], error: 'Anthropic API does not support model listing' };
  }

  try {
    // Use the same URL resolution as the chat adapter for consistency
    const resolvedBase = resolveOpenAIBaseUrl(baseUrl);
    const modelsUrl = `${resolvedBase}/models`;

    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const fetchFn = await getTauriFetch();
    const resp = await fetchFn(modelsUrl, { method: 'GET', headers });

    if (!resp.ok) {
      const msg = resp.status === 403 || resp.status === 404
        ? '该供应商不支持自动获取模型列表，请手动填写模型 ID'
        : `HTTP ${resp.status}`;
      return { success: false, models: [], error: msg };
    }

    const data = await resp.json() as { data?: { id: string }[] };
    const rawModels = data.data ?? [];

    const models: ModelInfo[] = rawModels
      .filter((m) => {
        const id = m.id.toLowerCase();
        return !EXCLUDE_PATTERNS.some(p => id.includes(p));
      })
      .map((m) => ({ id: m.id, label: m.id, capabilities: deriveUiCaps(m.id) }));

    return { success: true, models };
  } catch (e) {
    return {
      success: false,
      models: [],
      error: e instanceof Error ? e.message : 'Fetch failed',
    };
  }
}
