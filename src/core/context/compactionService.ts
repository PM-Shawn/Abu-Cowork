import { createFailedCompactBoundaryMarker } from './compactBoundary';
import type { SummaryRequest } from './contextCompressor';
import { compactHistory, readFileThroughTool } from './compaction';
import { isLabsFlagOn } from '../labs/resolve';
import { LABS_STATE_PRESERVING_COMPRESSION } from '../labs/registry';
import type { Message } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import {
  getEffectiveModel,
  getActiveProvider,
  getActiveApiKey,
} from '@/stores/settingsStore';
import { getModelUnavailableReason } from '@/utils/settingsSelectors';
import { getSettingsReader } from '@/core/agent/ports/settingsReader';
import { resolveEffectiveLlmCreds } from '@/core/enterprise/llm-resolver';
import { adapterKindFor } from '@/core/llm/adapterKind';
import { createAdapterForKind } from '@/core/llm/createAdapter';
import { providerChatOptions } from '@/core/llm/providerChatOptions';
import { resolveModelDeclared } from '@/core/llm/resolveModelDeclared';
import { resolveRequestBudget } from '@/core/llm/requestBudget';
import { resolveAgentModelCapabilities, resolveCapabilities } from '@/core/llm/modelCapabilities';
import { applyDeclaredCapabilities } from '@/core/llm/applyDeclaredCapabilities';
import { resolveModelProfile } from '@/core/llm/modelProfile';
import { rejectedCapabilities } from '@/core/llm/rejectionMemory';
import { getCapsPort } from '@/core/agent/ports/capsPort';
import { getToolInvoker } from '@/core/agent/ports/toolInvoker';
import { getConversationReader } from '@/core/agent/ports/conversationReader';
import { precomputeOrchestration } from '@/core/agent/entryOrchestration';
import { composeRequestPromptSections } from '@/core/agent/requestPrompt';
import { mergeSections, sectionsToString } from '@/core/llm/promptSections';
import { selectToolsForProfile } from '@/core/tools/toolSelection';
import { buildDeferredToolsSummary } from '@/core/tools/toolSearch';
import { adaptComputerToolForTier } from '@/core/tools/definitions/computerToolText';
import { getBuiltinSearchConfig } from '@/core/capabilities';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { isWindows } from '@/utils/platform';
import { getMessageText } from './contextUtils';
import { computeInputBudget, enforceContextBudget } from './contextManager';
import { estimateToolSchemaTokens } from './tokenEstimator';

export type CompactionReason = 'ok' | 'too-few' | 'summarize-failed' | 'no-conversation' | 'model-unavailable';

export interface CompactionResult {
  compacted: boolean;
  reason: CompactionReason;
}

/**
 * Resolve the LLM request for summarizing one conversation.
 *
 * Manual /compact summarizes THIS conversation, so it runs on the conversation's
 * own model — the same pin → index → global fallback agentLoop uses (#545).
 * Model name and provider identity (adapter / baseUrl / apiKey) all derive from
 * that one scoped snapshot so they can never diverge.
 *
 * Enterprise gateway mode forces the OpenAI-compatible adapter (LiteLLM exposes
 * that interface) — matching llmCall.ts. Missing the `forceOpenAiCompatible`
 * term would pick the Claude adapter under an enforced gateway and fail the call.
 *
 * Returns null when that model can no longer be used (provider removed/turned
 * off, model no longer listed): it is never called, and no other model is used.
 */
async function resolveSummaryRequest(convId: string): Promise<{
  request: SummaryRequest;
  inputBudget: number;
  fitSummaryInput: (messages: Message[]) => Message[];
} | null> {
  const settings = getSettingsReader().getSnapshot();
  const chat = useChatStore.getState();
  const baseModel =
    chat.conversations[convId]?.model ??
    chat.conversationIndex?.[convId]?.model ??
    settings.activeModel;
  const scoped = baseModel === settings.activeModel ? settings : { ...settings, activeModel: baseModel };
  const provider = getActiveProvider(scoped);
  const creds = resolveEffectiveLlmCreds(getActiveApiKey(scoped), provider?.baseUrl || undefined);
  const modelIssue = creds.forceOpenAiCompatible || baseModel.providerId === 'enterprise-gateway'
    ? null
    : getModelUnavailableReason(settings, baseModel);
  if (modelIssue) {
    console.warn('[compaction] manual /compact skipped: model unavailable', {
      reason: modelIssue,
      providerId: baseModel.providerId,
      modelId: baseModel.modelId,
    });
    return null;
  }
  const adapter = createAdapterForKind(adapterKindFor(provider, creds.forceOpenAiCompatible));
  const model = getEffectiveModel(scoped);
  const conversation = chat.conversations[convId];
  const toolContext = { conversationId: convId, workspacePath: conversation.workspacePath ?? null, allowPermissionPrompts: false as const };
  const latestUser = [...conversation.messages].reverse().find((message) => message.role === 'user' && !message.isSystem);
  const userInput = latestUser ? getMessageText(latestUser.content) : '';
  const { route, systemPromptSections } = await precomputeOrchestration(
    convId, userInput, undefined, { settingsForModel: scoped, purpose: 'compaction' }, undefined, toolContext,
  );
  const declared = resolveModelDeclared(provider, model);
  const caps = applyDeclaredCapabilities(resolveCapabilities(model), declared);
  const budget = resolveRequestBudget(model, caps, provider, scoped, provider ? getCapsPort().get(provider.id, model) : undefined);
  const builtinWebSearch = provider ? getBuiltinSearchConfig(provider.capabilities, true) : undefined;
  const profile = resolveModelProfile({ modelId: model, provider, declared, overrides: rejectedCapabilities(provider?.id, model) });
  const { resolveTools, prefetchSkills } = await import('@/core/agent/agentLoop');
  const selected = resolveTools(getToolInvoker(), route, !!builtinWebSearch, undefined, {
    userInput,
    computerUseEnabled: scoped.computerUseEnabled ?? false,
    activeSkills: prefetchSkills(route.type === 'skill' ? route.skill : undefined, getConversationReader().getActiveSkills(convId)),
    turnCount: conversation.messages.filter((message) => message.role === 'assistant').length,
    hasGoal: conversation.goal !== undefined,
  }, undefined, convId);
  const computerUseTier = resolveAgentModelCapabilities({ modelId: model, providerSource: provider?.source, declared }).computerUseTier;
  const adapt = (tool: (typeof selected.tools)[number]) => adaptComputerToolForTier(tool, computerUseTier, isWindows());
  const deferredTools = declared?.supportsTools === false ? [] : selected.deferredTools;
  const tools = selectToolsForProfile((declared?.supportsTools === false ? [] : selected.tools)
    .filter((tool) => deferredTools.length > 0 || tool.name !== TOOL_NAMES.TOOL_SEARCH).map(adapt), profile);
  const sections = composeRequestPromptSections(systemPromptSections, tools, buildDeferredToolsSummary(deferredTools.map(adapt)));
  const systemPrompt = sectionsToString(sections);
  const toolTokens = estimateToolSchemaTokens(tools);
  const inputBudget = computeInputBudget(budget.contextWindowSize, budget.reasoningParams.maxTokens).inputBudget;
  return {
    inputBudget,
    fitSummaryInput: (messages) => enforceContextBudget(messages, systemPrompt, budget.contextWindowSize, budget.reasoningParams.maxTokens, toolTokens).messages,
    request: {
      adapter,
      chatOptions: {
        model,
        apiKey: creds.apiKey,
        baseUrl: creds.baseUrl,
        ...providerChatOptions(provider, model),
        systemPrompt,
        systemPromptSections: mergeSections(sections),
        tools: tools.length > 0 ? tools : undefined,
        ...budget.reasoningParams,
        localServer: budget.localServer,
        requestedContextLength: budget.requestedContextLength,
        supportsVision: caps.vision,
        declaredCapabilities: declared,
        capabilityOverrides: [...rejectedCapabilities(provider?.id, model)],
        builtinWebSearch,
      },
      conversationId: convId,
      providerInstanceId: provider?.id ?? 'unknown',
    },
  };
}

/**
 * Manual /compact: compact the conversation on explicit user request, keeping
 * only the newest step verbatim. The divider shows between turns (no loopId).
 * A failed summary is recorded as a failed divider and reported to the caller,
 * which tells the user.
 */
export async function compactConversationManually(
  convId: string,
): Promise<CompactionResult> {
  const conv = useChatStore.getState().conversations[convId];
  if (!conv) return { compacted: false, reason: 'no-conversation' };

  const toolInvoker = getToolInvoker();
  const readFile = readFileThroughTool(
    async (input, context) => toolInvoker.toolResultToString(await toolInvoker.executeAnyTool(
      'read_file',
      input,
      async () => false,
      async () => false,
      context,
    )),
    { conversationId: convId, workspacePath: conv.workspacePath ?? null },
  );

  useChatStore.getState().setIsCompressing(convId, true);
  let marker: Message | null;
  try {
    const resolved = await resolveSummaryRequest(convId);
    if (!resolved) return { compacted: false, reason: 'model-unavailable' };
    const keepAnchors = isLabsFlagOn(LABS_STATE_PRESERVING_COMPRESSION);
    marker = await compactHistory({
      history: conv.messages ?? [],
      inputBudget: resolved.inputBudget,
      retainTokens: 0,
      source: 'manual',
      summary: { ...resolved.request, preserveAnchors: keepAnchors },
      keepAnchors,
      fitSummaryInput: resolved.fitSummaryInput,
      readFile,
      now: () => Date.now(),
    });
  } catch (err) {
    console.warn('[compaction] manual /compact summary failed', { error: err instanceof Error ? err.message : String(err) });
    useChatStore.getState().addMessage(convId, createFailedCompactBoundaryMarker({ source: 'manual', timestamp: Date.now() }));
    return { compacted: false, reason: 'summarize-failed' };
  } finally {
    useChatStore.getState().setIsCompressing(convId, false);
  }

  if (!marker) return { compacted: false, reason: 'too-few' };
  useChatStore.getState().addMessage(convId, marker);
  return { compacted: true, reason: 'ok' };
}
