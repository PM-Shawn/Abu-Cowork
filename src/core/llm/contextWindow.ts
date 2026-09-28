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

export function resolveContextWindow(inputs: ContextWindowInputs): { size: number; source: ContextWindowSource } {
  const user = positiveInteger(inputs.userSetting);
  if (user !== undefined) return { size: user, source: 'user' };
  const ceiling = positiveInteger(inputs.ceiling);
  const bounded = (value: number): number => (ceiling === undefined ? value : Math.min(value, ceiling));
  const probed = positiveInteger(inputs.probed);
  const discoveredProbe = positiveInteger(inputs.discoveredProbe);
  const discoveredStale = probed !== undefined && discoveredProbe !== undefined && probed !== discoveredProbe;
  const service = [probed, discoveredStale ? undefined : positiveInteger(inputs.discovered)]
    .filter((value): value is number => value !== undefined);
  if (service.length > 0) return { size: bounded(Math.min(...service)), source: 'service' };
  return { size: bounded(estimateContextWindow(inputs.modelId, inputs.isLocal)), source: 'estimate' };
}
