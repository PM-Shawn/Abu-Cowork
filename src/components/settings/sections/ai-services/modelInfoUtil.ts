import { deriveUiCaps } from '@/core/llm/modelCapabilities';
import type { ModelDeclaredCapabilities, ModelInfo } from '@/types/provider';

/**
 * Build a ModelInfo, always attaching UI capability tags derived from the model id.
 * Ensures manually-added models get the same vision/thinking/long_context badges as
 * models pulled via the fetch flow (modelFetcher already calls deriveUiCaps).
 */
export function toModelInfo(
  id: string,
  opts?: { label?: string; isCustom?: boolean; declaredCapabilities?: ModelDeclaredCapabilities; contextWindow?: number },
): ModelInfo {
  return {
    id,
    label: opts?.label ?? id,
    capabilities: deriveUiCaps(id),
    ...(opts?.isCustom ? { isCustom: true } : {}),
    ...(opts?.declaredCapabilities ? { declaredCapabilities: opts.declaredCapabilities } : {}),
    ...(opts?.contextWindow !== undefined ? { contextWindow: opts.contextWindow } : {}),
  };
}

/** 把服务报告的窗口写进 ModelInfo.contextWindow，供高级配置显示「已识别」。 */
export function withContextWindows(models: ModelInfo[], windows: ReadonlyMap<string, number>): ModelInfo[] {
  return models.map((model) => {
    const size = windows.get(model.id);
    return size === undefined ? model : { ...model, contextWindow: size };
  });
}
