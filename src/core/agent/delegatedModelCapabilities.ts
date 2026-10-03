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
 * 子代理自己的模型及其能力：与主循环（agentLoop.ts 给工具上下文的档位）同一算法，
 * 声明能力按子代理的规则补全。
 *
 * 两处调用：子代理循环用它选择发给模型的电脑操控说明；在 sidecar 里运行时，循环读取
 * 共享的设置镜像，只把 activeModel 固定为派发时快照里的值（sidecar/src/subagentHost.ts
 * 的 createRunScopedSettingsReader）。外壳的子代理会话用派发时的完整设置快照计算一次，
 * 工具执行时以外壳这份结果为准，覆盖 sidecar 发来的副本。
 */
export function resolveDelegatedModelCapabilities(
  agentModel: string | undefined,
  settings: Readonly<SettingsState>,
): AgentModelCapabilities & { modelId: string } {
  const modelId = resolveAgentModel(agentModel, settings);
  const provider = getActiveProvider(settings);
  return {
    modelId,
    ...resolveAgentModelCapabilities({
      modelId,
      providerSource: provider?.source,
      declared: resolveDelegatedDeclaredCapabilities(provider, modelId),
    }),
  };
}
