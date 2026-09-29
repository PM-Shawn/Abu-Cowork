import type { SettingsState } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { getActiveProvider } from '@/utils/settingsSelectors';
import { resolveModelDeclared } from '../llm/resolveModelDeclared';
import { resolveContextWindow } from '../llm/contextWindow';
import { probeContextWindow } from '../llm/contextWindowProbe';
import { localServerKind } from '../llm/localProvider';
import { getCapsPort } from './ports/capsPort';

/**
 * 本进程里每个「服务商:模型」最近一次向服务问到的窗口；`size` 为 undefined 表示问了但没问到。
 * 主循环与子代理每次运行开始询问后刷新，同一进程里的记忆提取、技能辅助调用、压缩读它，
 * 这些请求安排内容用的窗口与任务请求相同。
 */
const latestProbes = new Map<string, { size: number | undefined }>();

function probeKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/**
 * 记下本次运行问到的值。没问到（Ollama 已把模型卸载、服务没回应）时保留上一次问到的值，
 * 只在还没有任何已知值时记成「问过但没问到」，免得其他入口再问一次。
 */
export function rememberProbedContextWindow(providerId: string, modelId: string, size: number | undefined): void {
  const key = probeKey(providerId, modelId);
  if (size === undefined && latestProbes.get(key)?.size !== undefined) return;
  latestProbes.set(key, { size });
}

export function __resetProbedContextWindowsForTests(): void {
  latestProbes.clear();
}

/** 第 2 级的取值与主循环相同：本次问到的值，没问到时用「获取模型」时记下的值。 */
async function probedWindow(
  provider: ProviderInstance,
  modelId: string,
  userSetting: number | undefined,
): Promise<number | undefined> {
  const saved = provider.models.find((model) => model.id === modelId)?.contextWindow;
  const latest = latestProbes.get(probeKey(provider.id, modelId));
  if (latest !== undefined) return latest.size ?? saved;
  if (userSetting !== undefined || saved !== undefined || localServerKind(provider) === null) return saved;
  // 这个进程还没有运行问过（例如外壳里的手动压缩），自己问一次；没问到不记，下次再问
  const size = await probeContextWindow(provider, modelId);
  if (size !== undefined) rememberProbedContextWindow(provider.id, modelId, size);
  return size;
}

/** 主循环之外的入口（压缩、记忆提取、技能辅助调用）按同一套优先级算窗口。 */
export async function contextWindowForModel(settings: SettingsState, modelId: string): Promise<number> {
  const provider = getActiveProvider(settings);
  const userSetting = resolveModelDeclared(provider, modelId)?.maxInputTokens;
  const discovered = provider ? getCapsPort().get(provider.id, modelId) : undefined;
  return resolveContextWindow({
    modelId,
    userSetting,
    probed: provider ? await probedWindow(provider, modelId, userSetting) : undefined,
    discovered: discovered?.contextWindow,
    discoveredProbe: discovered?.contextWindowProbe,
    isLocal: localServerKind(provider) !== null,
    ceiling: settings.contextWindowSize,
  }).size;
}
