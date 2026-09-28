import type { SettingsState } from '@/stores/settingsStore';
import { getActiveProvider } from '@/utils/settingsSelectors';
import { resolveModelDeclared } from '../llm/resolveModelDeclared';
import { resolveContextWindow } from '../llm/contextWindow';
import { localServerKind } from '../llm/localProvider';
import { getCapsPort } from './ports/capsPort';

/**
 * 主循环之外的入口（压缩、记忆提取、技能辅助调用）按同一套优先级算窗口，
 * 这样发给 Ollama 的 num_ctx 处处相同，模型不会被重新加载。
 */
export function contextWindowForModel(settings: SettingsState, modelId: string, probed?: number): number {
  const provider = getActiveProvider(settings);
  const discovered = provider ? getCapsPort().get(provider.id, modelId) : undefined;
  return resolveContextWindow({
    modelId,
    userSetting: resolveModelDeclared(provider, modelId)?.maxInputTokens,
    probed: probed ?? provider?.models.find((model) => model.id === modelId)?.contextWindow,
    discovered: discovered?.contextWindow,
    discoveredProbe: discovered?.contextWindowProbe,
    isLocal: localServerKind(provider) !== null,
    ceiling: settings.contextWindowSize,
  }).size;
}
