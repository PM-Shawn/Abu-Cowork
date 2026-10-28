import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '../../types';
import { runAgentLoop } from './agentLoop';
import { computeInputBudget } from '../context/contextManager';
import { estimateTokens, estimateToolSchemaTokens, resetCalibration } from '../context/tokenEstimator';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import * as adapters from '../llm/selectChatAdapter';
import { buildRunModelBinding } from './modelRecovery';
import { LLMError, type ChatOptions } from '../llm/adapter';
import type { Message } from '@/types';
import { toolRegistry } from '../tools/registry';
import { manageGoalTool } from '../tools/definitions/goalTools';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('../llm/contextWindowProbe', () => ({ probeContextWindow: probe }));

const originalSettings = useSettingsStore.getState();
const orchestration = {
  route: { type: 'general' as const, name: 'abu', cleanInput: 'hello' },
  systemPromptSections: [{ name: 'task-context', text: 'context instruction '.repeat(6000), cacheable: true }],
};

function setup(pinned?: number) {
  useSettingsStore.setState({
    contextWindowSize: 65536,
    maxOutputTokens: 32768,
    activeModel: { providerId: 'ollama', modelId: 'qwen3:32b' },
    providers: originalSettings.providers.map((provider) => provider.id === 'ollama' ? {
      ...provider, enabled: true, models: [
        { id: 'qwen3:32b', label: 'Qwen', declaredCapabilities: pinned ? { maxInputTokens: pinned } : undefined },
        { id: 'large-model', label: 'Large', declaredCapabilities: { maxInputTokens: 65536, maxOutputTokens: 8192 } },
      ],
    } : { ...provider, enabled: false }),
  });
  const chat = vi.fn(async (_messages: Message[], _options: ChatOptions, event: (event: StreamEvent) => void) => {
    event({ type: 'text', text: 'Completed.' });
    event({ type: 'done', stopReason: 'end_turn' });
  });
  vi.spyOn(adapters, 'selectChatAdapter').mockReturnValue({ chat });
  return { chat, conversationId: useChatStore.getState().createConversation() };
}

beforeEach(() => {
  resetCalibration();
  probe.mockReset().mockResolvedValue(8192);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useSettingsStore.setState(originalSettings);
});

describe('context recovery through the real request budget', () => {
  it('raises Ollama num_ctx to a window that covers the actual input and output reserve', async () => {
    const { chat, conversationId } = setup();
    const result = await runAgentLoop(conversationId, 'hello', { orchestration });
    expect(result.reason).toBe('completed');
    expect(chat).toHaveBeenCalledTimes(1);
    const options = chat.mock.calls[0][1];
    expect(options.requestedContextLength).toBeGreaterThan(8192);
    expect(options.requestedContextLength).toBeLessThanOrEqual(65536);
    const fixed = estimateTokens(options.systemPrompt) + estimateToolSchemaTokens(options.tools ?? []);
    expect(computeInputBudget(options.requestedContextLength, options.maxTokens).inputBudget).toBeGreaterThan(fixed);
  });

  it('keeps a user configured window and resumes with the explicitly selected model', async () => {
    const { chat, conversationId } = setup(8192);
    const selected = buildRunModelBinding(useSettingsStore.getState(), { providerId: 'ollama', modelId: 'large-model' }, 1);
    const waitForSelection = vi.fn().mockResolvedValueOnce(selected);
    const result = await runAgentLoop(conversationId, 'hello', { orchestration, modelRecovery: { waitForSelection } });
    expect(waitForSelection).toHaveBeenCalledExactlyOnceWith('context-window');
    expect(result.reason).toBe('completed');
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].model).toBe('large-model');
    expect(useSettingsStore.getState().providers.find((provider) => provider.id === 'ollama')?.models[0].declaredCapabilities?.maxInputTokens).toBe(8192);
  });

  it('reports the context limit when no interactive recovery is available', async () => {
    const { chat, conversationId } = setup(8192);
    const result = await runAgentLoop(conversationId, 'hello', { orchestration });
    expect(result.reason).toBe('error');
    expect(chat).not.toHaveBeenCalled();
    expect(useChatStore.getState().conversations[conversationId].messages.some((message) =>
      typeof message.content === 'string' && message.content.includes('tokens'))).toBe(true);
  });

  it('recovers a quota error from the real automatic compaction request', async () => {
    const { chat, conversationId } = setup(8192);
    useSettingsStore.setState({ maxOutputTokens: 512 });
    const store = useChatStore.getState();
    for (let index = 0; index < 16; index++) {
      store.addMessage(conversationId, { id: `prior-user-${index}`, role: 'user', content: `step ${index}`, timestamp: index * 2 });
      store.addMessage(conversationId, { id: `prior-assistant-${index}`, role: 'assistant', content: 'Analysis retained for the next task. '.repeat(1500), timestamp: index * 2 + 1 });
    }
    chat.mockImplementationOnce(async (_messages, options) => {
      expect(options.accounting?.source).toBe('compaction');
      throw new LLMError('quota spent', 'quota_exceeded', { retryable: false });
    });
    const binding = buildRunModelBinding(useSettingsStore.getState(), { providerId: 'ollama', modelId: 'large-model' }, 1);
    const waitForSelection = vi.fn().mockResolvedValueOnce(binding);
    const result = await runAgentLoop(conversationId, 'continue', {
      orchestration: { ...orchestration, systemPromptSections: [] }, modelRecovery: { waitForSelection },
    });
    expect(waitForSelection).toHaveBeenCalledExactlyOnceWith('quota');
    expect(result.reason).toBe('completed');
    expect(chat.mock.calls.slice(1).every(([, options]) => options.model === 'large-model')).toBe(true);
  });

  it('preserves partial text and marks unexecuted tool calls when model selection resumes a stream', async () => {
    const { chat, conversationId } = setup();
    chat.mockImplementationOnce(async (_messages, _options, event) => {
      event({ type: 'text', text: 'Partial answer remains available.' });
      event({ type: 'tool_use', id: 'unfinished-read', name: 'read_file', input: { path: '/workspace/report.txt' } });
      throw new LLMError('quota spent', 'quota_exceeded', { retryable: false });
    });
    const binding = buildRunModelBinding(useSettingsStore.getState(), { providerId: 'ollama', modelId: 'large-model' }, 1);
    const waitForSelection = vi.fn().mockResolvedValueOnce(binding);
    const result = await runAgentLoop(conversationId, 'hello', { orchestration, modelRecovery: { waitForSelection } });
    expect(result.reason).toBe('completed');
    const interrupted = useChatStore.getState().conversations[conversationId].messages.find(message => message.toolCalls?.some(call => call.id === 'unfinished-read'))!;
    expect(interrupted.content).toContain('Partial answer remains available.');
    expect(interrupted.toolCalls?.[0]).toMatchObject({ isExecuting: false, isError: true, result: expect.stringContaining('before this tool could run') });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('preserves a completed real tool result across a later model quota error', async () => {
    const { chat, conversationId } = setup();
    const existing = toolRegistry.get(manageGoalTool.name);
    toolRegistry.register(manageGoalTool);
    const executed = vi.spyOn(manageGoalTool, 'execute');
    chat.mockImplementationOnce(async (_messages, _options, event) => {
      event({ type: 'tool_use', id: 'completed-read', name: manageGoalTool.name, input: { action: 'get' } });
      event({ type: 'done', stopReason: 'tool_use' });
    }).mockImplementationOnce(async () => { throw new LLMError('quota spent', 'quota_exceeded', { retryable: false }); });
    const binding = buildRunModelBinding(useSettingsStore.getState(), { providerId: 'ollama', modelId: 'large-model' }, 1);
    try {
      const result = await runAgentLoop(conversationId, 'hello', { orchestration, modelRecovery: { waitForSelection: async () => binding } });
      expect(result.reason).toBe('completed');
      expect(executed).toHaveBeenCalledTimes(1);
      const completed = useChatStore.getState().conversations[conversationId].messages.flatMap(message => message.toolCalls ?? []).find(call => call.id === 'completed-read');
      expect(completed?.isError).not.toBe(true);
      expect(completed?.result).toBeTruthy();
      expect(chat).toHaveBeenCalledTimes(3);
    } finally {
      if (existing) toolRegistry.register(existing);
      else toolRegistry.remove(manageGoalTool.name);
    }
  });

  it('probes the newly selected local model without retaining the original probe result', async () => {
    const { chat, conversationId } = setup();
    useSettingsStore.setState({ providers: useSettingsStore.getState().providers.map(provider => provider.id === 'ollama'
      ? { ...provider, models: provider.models.map(model => ({ ...model, declaredCapabilities: undefined })) } : provider) });
    probe.mockResolvedValueOnce(8192).mockResolvedValueOnce(65536);
    chat.mockImplementationOnce(async () => { throw new LLMError('quota spent', 'quota_exceeded', { retryable: false }); });
    const binding = buildRunModelBinding(useSettingsStore.getState(), { providerId: 'ollama', modelId: 'large-model' }, 1);
    const result = await runAgentLoop(conversationId, 'hello', { orchestration, modelRecovery: { waitForSelection: async () => binding } });
    expect(result.reason).toBe('completed');
    expect(probe.mock.calls.map(call => call[1])).toEqual(['qwen3:32b', 'large-model']);
    expect(chat.mock.calls[1][1].requestedContextLength).toBeUndefined();
  });
});
