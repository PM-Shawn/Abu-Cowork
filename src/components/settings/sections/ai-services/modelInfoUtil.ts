import { deriveUiCaps } from '@/core/llm/modelCapabilities';
import type { ModelInfo } from '@/types/provider';

/**
 * Build a ModelInfo, always attaching UI capability tags derived from the model id.
 * Ensures manually-added models get the same vision/thinking/long_context badges as
 * models pulled via the fetch flow (modelFetcher already calls deriveUiCaps).
 */
export function toModelInfo(id: string, opts?: { label?: string; isCustom?: boolean }): ModelInfo {
  return {
    id,
    label: opts?.label ?? id,
    capabilities: deriveUiCaps(id),
    ...(opts?.isCustom ? { isCustom: true } : {}),
  };
}
