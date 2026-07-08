import { computeCompactionPlan, createCompactBoundaryMarker } from './compactBoundary';
import { summarizeConversation } from './contextCompressor';
import type { CompressionConfig } from './contextCompressor';
import type { Message } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import {
  useSettingsStore,
  getEffectiveModel,
  getActiveProvider,
  getActiveApiKey,
} from '@/stores/settingsStore';
import { resolveEffectiveLlmCreds } from '@/core/enterprise/llm-resolver';
import { ClaudeAdapter } from '@/core/llm/claude';
import { OpenAICompatibleAdapter } from '@/core/llm/openai-compatible';
import type { LLMAdapter } from '@/core/llm/adapter';

export type CompactionReason = 'ok' | 'too-few' | 'summarize-failed' | 'no-conversation';

export interface CompactionResult {
  compacted: boolean;
  reason: CompactionReason;
}

/** A compaction plan (from computeCompactionPlan) — the range to summarize. */
interface CompactionPlan {
  middleMessages: Message[];
  summarizedFromId: string;
  summarizedToId: string;
}

/**
 * Land a compact-boundary marker into a conversation (append-only).
 *
 * Shared by the auto path (agentLoop Step 2.1) and the manual /compact path so
 * the marker-landing sequence lives in one place. addMessage pushes to store +
 * disk without mutating any existing message; the stale ephemeral 65% cache
 * (indexed by pre-marker positions) is invalidated.
 */
export function landCompactBoundaryMarker(
  convId: string,
  plan: CompactionPlan,
  summaryText: string,
  source: 'auto' | 'manual',
): Message {
  const marker = createCompactBoundaryMarker({
    summaryText: summaryText.trim(),
    summarizedFromId: plan.summarizedFromId,
    summarizedToId: plan.summarizedToId,
    source,
    timestamp: Date.now(),
  });
  useChatStore.getState().addMessage(convId, marker);
  useChatStore.getState().clearContextCache(convId);
  return marker;
}

/**
 * Resolve the LLM config for a summarization call from the current settings.
 *
 * Enterprise gateway mode forces the OpenAI-compatible adapter (LiteLLM exposes
 * that interface) — matching llmCall.ts. Missing the `forceOpenAiCompatible`
 * term would pick the Claude adapter under an enforced gateway and fail the call.
 */
function resolveSummarizeConfig(): CompressionConfig {
  const settings = useSettingsStore.getState();
  const provider = getActiveProvider(settings);
  const creds = resolveEffectiveLlmCreds(getActiveApiKey(settings), provider?.baseUrl || undefined);
  const adapter: LLMAdapter =
    creds.forceOpenAiCompatible || provider?.apiFormat === 'openai-compatible'
      ? new OpenAICompatibleAdapter()
      : new ClaudeAdapter();
  return {
    adapter,
    model: getEffectiveModel(settings),
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
  };
}

/**
 * Manual /compact: compact the conversation on explicit user request.
 *
 * Unlike the auto path, this is unguarded by the substantiveness/delta threshold
 * (computeCompactionPlan is called without an estimator) — the user asked, so we
 * compact whenever there are enough rounds.
 */
export async function compactConversationManually(
  convId: string,
): Promise<CompactionResult> {
  const conv = useChatStore.getState().conversations[convId];
  if (!conv) return { compacted: false, reason: 'no-conversation' };

  const messages = conv.messages ?? [];
  const plan = computeCompactionPlan(messages);
  if (!plan) return { compacted: false, reason: 'too-few' };

  // Show the in-progress indicator (same purple spinner the auto 65% path uses)
  // while the summarization LLM call runs — otherwise manual /compact is silent
  // for several seconds until the divider appears. Reset in finally on all paths.
  let summaryText: string;
  useChatStore.getState().setIsCompressing(convId, true);
  try {
    summaryText = await summarizeConversation(plan.middleMessages, resolveSummarizeConfig());
  } catch {
    return { compacted: false, reason: 'summarize-failed' };
  } finally {
    useChatStore.getState().setIsCompressing(convId, false);
  }

  if (!summaryText.trim()) return { compacted: false, reason: 'summarize-failed' };

  landCompactBoundaryMarker(convId, plan, summaryText, 'manual');
  return { compacted: true, reason: 'ok' };
}
