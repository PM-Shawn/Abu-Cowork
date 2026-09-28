// 只依赖纯函数（settingsSelectors 而非 settingsStore），sidecar 里的子代理循环与外壳的子代理会话共用
import { getActiveProvider, resolveAgentModel } from '../../utils/settingsSelectors';
import type { SettingsState } from '../../stores/settingsStore';
import {
  deriveDeclaredDefaults,
  resolveAgentModelCapabilities,
  type AgentModelCapabilities,
} from '../llm/modelCapabilities';
import { resolveModelDeclared } from '../llm/resolveModelDeclared';

export function resolveDelegatedDeclaredCapabilities(
  provider: ReturnType<typeof getActiveProvider>,
  modelId: string,
) {
  const declared = resolveModelDeclared(provider, modelId);
  if (provider?.source !== 'custom' || declared?.supportsImages !== undefined) {
    return declared;
  }
  return {
    ...declared,
    supportsImages: deriveDeclaredDefaults(modelId).supportsImages,
  };
}

/**
 * 子代理自己的模型能力：与主循环（agentLoop.ts 给工具上下文的档位）同一算法，
 * 声明能力按子代理的规则补全。sidecar 里的子代理循环与外壳的子代理会话各算一次，
 * 结果相同；外壳用自己算的值覆盖 sidecar 发来的副本。
 */
export function resolveDelegatedModelCapabilities(
  agentModel: string | undefined,
  settings: Readonly<SettingsState>,
): AgentModelCapabilities {
  const modelId = resolveAgentModel(agentModel, settings);
  const provider = getActiveProvider(settings);
  return resolveAgentModelCapabilities({
    modelId,
    providerSource: provider?.source,
    declared: resolveDelegatedDeclaredCapabilities(provider, modelId),
  });
}
