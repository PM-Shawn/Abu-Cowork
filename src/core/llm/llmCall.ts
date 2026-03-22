/**
 * Standalone LLM call — equivalent to `claude -p`.
 *
 * Makes a single-turn, stateless call to the user's configured LLM.
 * Model-agnostic: works with Claude, GPT, DeepSeek, Qwen, or any provider.
 *
 * Used by internal tools (test_skill_trigger, improve_skill_description)
 * that need LLM reasoning without going through the full agent loop.
 */

import type { StreamEvent, Message, ToolDefinition } from '../../types';
import type { LLMAdapter } from './adapter';
import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { useSettingsStore, getActiveApiKey, getEffectiveModel } from '../../stores/settingsStore';

export interface LLMCallOptions {
  /** System prompt */
  system?: string;
  /** Conversation messages */
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Optional tools for function calling */
  tools?: ToolDefinition[];
  /** Max response tokens (default: 4096) */
  maxTokens?: number;
  /** Abort signal */
  signal?: AbortSignal;
}

export interface LLMCallToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface LLMCallResult {
  /** Text response from the model */
  text: string;
  /** Tool calls made by the model (if tools were provided) */
  toolCalls: LLMCallToolCall[];
}

/**
 * Make a single-turn LLM call using the user's configured model.
 *
 * This is Abu's equivalent of `claude -p` — a headless, stateless LLM invocation
 * that any tool or script can use without going through the agent loop.
 */
export async function llmCall(options: LLMCallOptions): Promise<LLMCallResult> {
  const settings = useSettingsStore.getState();
  const adapter: LLMAdapter = settings.apiFormat === 'openai-compatible'
    ? new OpenAICompatibleAdapter()
    : new ClaudeAdapter();

  const messages: Message[] = options.messages.map((m, i) => ({
    id: `llmcall-${i}`,
    role: m.role,
    content: m.content,
    timestamp: Date.now(),
  }));

  let text = '';
  const toolCalls: LLMCallToolCall[] = [];

  const eventHandler = (event: StreamEvent) => {
    switch (event.type) {
      case 'text':
        text += event.text;
        break;
      case 'tool_use':
        toolCalls.push({
          name: event.name,
          input: event.input as Record<string, unknown>,
        });
        break;
    }
  };

  await adapter.chat(messages, {
    model: getEffectiveModel(settings),
    apiKey: getActiveApiKey(settings),
    baseUrl: settings.baseUrl || undefined,
    systemPrompt: options.system,
    tools: options.tools,
    maxTokens: options.maxTokens ?? 4096,
    signal: options.signal,
  }, eventHandler);

  return { text, toolCalls };
}
