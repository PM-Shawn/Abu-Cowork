import { agentRunContext } from '../agentRunContext';
import { subagentRunContext } from '../subagentRunContext';
import type { ShimThrowKind } from './shimThrowKind';

export const SHIM_THROW_KIND: ShimThrowKind = 'wiring-guard';

/** The shell supplies credentials at admission and after each user selection. */
export function resolveEffectiveLlmCreds(
  _personalApiKey: string,
  _personalBaseUrl: string | undefined,
): { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean } {
  const context = agentRunContext.getStore() ?? subagentRunContext.getStore();
  if (!context) throw new Error('[sidecar] Model credentials requested outside an active run');
  return context.resolvedCreds;
}
