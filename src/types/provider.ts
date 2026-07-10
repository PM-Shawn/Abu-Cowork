// ============================================================
// ABU — Provider & Model Type Definitions (V2)
// ============================================================

import type { ApiFormat, ProviderCapabilities } from './index';
import type { WebSearchProviderType } from '../core/search/providers';

/** Provider source */
export type ProviderSource = 'builtin' | 'custom';

/** Provider connection status */
export type ProviderStatus = 'unchecked' | 'checking' | 'verified' | 'failed';

/** Model capability tags */
export type ModelCapability = 'vision' | 'tool_use' | 'web_search' | 'image_gen' | 'thinking' | 'long_context';

/**
 * Per-model subset of DeclaredCapabilities — the fields that genuinely vary per model
 * on the same endpoint. Endpoint/protocol-level fields (useRawUrl / thinkingFormat /
 * maxTokensField / requiresToolResultName) stay on ProviderInstance.declaredCapabilities.
 */
export interface ModelDeclaredCapabilities {
  supportsTools?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportedEfforts?: Array<'low' | 'medium' | 'high'>;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

/** Unified model definition */
export interface ModelInfo {
  id: string;
  label: string;
  capabilities?: ModelCapability[];
  contextWindow?: number;
  isCustom?: boolean;
  declaredCapabilities?: ModelDeclaredCapabilities;
}

/**
 * 用户对自定义/本地端点显式声明的能力。仅 source==='custom' 或本地(ollama/lmstudio)
 * provider 上出现；builtin 为 undefined → 回退 modelCapabilities.ts 自动探测(非破坏)。
 */
export interface DeclaredCapabilities {
  supportsTools?: boolean;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportedEfforts?: Array<'low' | 'medium' | 'high'>;
  /** 自定义协议：接口地址原样使用，跳过 /chat/completions 归一化 */
  useRawUrl?: boolean;
  /** Max input/context tokens for this endpoint; blank → provider default. */
  maxInputTokens?: number;
  /** Max output tokens (request max_tokens); blank → provider default. */
  maxOutputTokens?: number;
  /** How this provider expects the "reasoning/thinking" toggle to be shaped in the request body.
   *  Auto-derived from host when omitted; set explicitly to override
   *  (e.g. self-hosted qwen via vLLM needs 'qwen-chat-template'). */
  thinkingFormat?: 'openai' | 'deepseek' | 'qwen' | 'qwen-chat-template' | 'zai' | 'together' | 'openrouter';
  /** Which field name this provider uses for the output-token cap. Auto-derived when omitted. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** When true, tool-result (role:tool) messages must carry a `name` field mirroring the tool_call function name. */
  requiresToolResultName?: boolean;
}

/** Unified Provider instance (builtin and custom share the same structure) */
export interface ProviderInstance {
  id: string;
  source: ProviderSource;
  name: string;
  enabled: boolean;
  apiFormat: ApiFormat;
  baseUrl: string;
  apiKey: string;
  models: ModelInfo[];
  defaultModelId?: string;
  capabilities?: ProviderCapabilities;
  status: ProviderStatus;
  statusMessage?: string;
  statusLatency?: number;
  lastChecked?: number;
  sortOrder: number;
  /**
   * True once the user has explicitly added/configured this provider via
   * AddProviderModal. Decouples "should appear in the list" from
   * `enabled`/`apiKey` — so toggling off a provider (or clearing its key
   * via the danger zone) does not make it vanish from the UI, which users
   * read as accidental deletion. Only flipped back to false when the user
   * explicitly clicks the trash-can delete action.
   */
  userAdded?: boolean;
  declaredCapabilities?: DeclaredCapabilities;
}

/** Currently active model selection */
export interface ActiveModel {
  providerId: string;
  modelId: string;
}

/** Auxiliary capability service configuration */
export interface AuxiliaryServices {
  webSearch?: {
    provider: WebSearchProviderType;
    apiKey: string;
    baseUrl: string;
  };
  imageGen?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
}

/** Provider usage guide */
export interface ProviderGuide {
  steps: string[];
  url: string;
  urlLabel: string;
}
