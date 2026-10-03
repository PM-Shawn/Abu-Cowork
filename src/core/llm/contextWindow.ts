import { resolveCapabilities } from './modelCapabilities';

/** 本地服务商按名字估计窗口时的封顶值。 */
export const LOCAL_ESTIMATE_CAP = 32768;

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** 第 4 级：按名字估计。内置表描述的是训练上限或云端上限，本地服务商不按它给大值。 */
export function estimateContextWindow(modelId: string, isLocal: boolean): number {
  const byName = resolveCapabilities(modelId).contextWindow;
  return isLocal ? Math.min(byName, LOCAL_ESTIMATE_CAP) : byName;
}

/**
 * 界面上显示的长度写法：8K、16K、128K、1M。
 * 云端常写整千（128000），本地常写 1024 的倍数（131072），两种都显示为 128K；
 * 128000 同时是 1024 的倍数（125 × 1024），所以先认整千。整百万与 1048576 的倍数显示为 M。
 */
export function formatContextLength(tokens: number): string {
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`;
  if (tokens % 1000 === 0) return `${tokens / 1000}K`;
  if (tokens % 1024 === 0) return `${tokens / 1024}K`;
  return `${Math.round(tokens / 1000)}K`;
}

export interface ContextWindowInputs {
  modelId: string;
  /** 1. 用户在「上下文长度」里填的值 */
  userSetting?: number;
  /** 2. 服务报告的值：本次运行问到的，或「获取模型」时记下的 */
  probed?: number;
  /** 3. 从超长报错学到的值 */
  discovered?: number;
  /** 学到第 3 级那一刻服务报告的值；与本次 probed 不同说明用户改过服务端设置，第 3 级作废 */
  discoveredProbe?: number;
  isLocal: boolean;
  /** 全局 contextWindowSize，只约束第 2–4 级 */
  ceiling?: number;
}

export type ContextWindowSource = 'user' | 'service' | 'estimate';

export interface ResolvedContextWindow {
  /** 输入可用的窗口，已按全局上限裁剪 */
  size: number;
  /** 模型自己的窗口，未经全局上限裁剪；回答预留按它计算，云端长窗口模型保持原有回答预算 */
  uncappedSize: number;
  source: ContextWindowSource;
}

export function resolveContextWindow(inputs: ContextWindowInputs): ResolvedContextWindow {
  const user = positiveInteger(inputs.userSetting);
  if (user !== undefined) return { size: user, uncappedSize: user, source: 'user' };
  const ceiling = positiveInteger(inputs.ceiling);
  const bounded = (value: number, source: ContextWindowSource): ResolvedContextWindow => ({
    size: ceiling === undefined ? value : Math.min(value, ceiling),
    uncappedSize: value,
    source,
  });
  const probed = positiveInteger(inputs.probed);
  const discoveredProbe = positiveInteger(inputs.discoveredProbe);
  const discoveredStale = probed !== undefined && discoveredProbe !== undefined && probed !== discoveredProbe;
  const service = [probed, discoveredStale ? undefined : positiveInteger(inputs.discovered)]
    .filter((value): value is number => value !== undefined);
  if (service.length > 0) return bounded(Math.min(...service), 'service');
  return bounded(estimateContextWindow(inputs.modelId, inputs.isLocal), 'estimate');
}
