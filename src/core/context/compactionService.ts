import { computeCompactionPlan, createCompactBoundaryMarker } from './compactBoundary';
import { summarizeConversation } from './contextCompressor';
import type { CompressionConfig } from './contextCompressor';
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

export async function compactConversationManually(
  convId: string,
): Promise<CompactionResult> {
  const conv = useChatStore.getState().conversations[convId];
  if (!conv) return { compacted: false, reason: 'no-conversation' };

  const messages = conv.messages ?? [];
  const plan = computeCompactionPlan(messages);
  if (!plan) return { compacted: false, reason: 'too-few' };

  let summaryText: string;
  try {
    const settings = useSettingsStore.getState();
    const provider = getActiveProvider(settings);
    const adapter: LLMAdapter =
      provider?.apiFormat === 'openai-compatible'
        ? new OpenAICompatibleAdapter()
        : new ClaudeAdapter();
    const creds = resolveEffectiveLlmCreds(
      getActiveApiKey(settings),
      provider?.baseUrl || undefined,
    );
    const config: CompressionConfig = {
      adapter,
      model: getEffectiveModel(settings),
      apiKey: creds.apiKey,
      baseUrl: creds.baseUrl,
    };
    summaryText = await summarizeConversation(plan.middleMessages, config);
  } catch {
    return { compacted: false, reason: 'summarize-failed' };
  }

  if (!summaryText.trim()) return { compacted: false, reason: 'summarize-failed' };

  const marker = createCompactBoundaryMarker({
    summaryText: summaryText.trim(),
    summarizedFromId: plan.summarizedFromId,
    summarizedToId: plan.summarizedToId,
    source: 'manual',
    timestamp: Date.now(),
  });

  useChatStore.getState().addMessage(convId, marker);
  useChatStore.getState().clearContextCache(convId);

  return { compacted: true, reason: 'ok' };
}
