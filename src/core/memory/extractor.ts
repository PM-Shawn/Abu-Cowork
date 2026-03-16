/**
 * Memory Extractor — automatically extract durable memories from conversations.
 *
 * Triggered when an IM session switches (timeout or "新对话").
 * Makes a lightweight LLM call to identify key facts worth remembering,
 * then writes them as structured memory entries.
 *
 * Inspired by OpenClaw's pre-compaction memory flush, but uses a dedicated
 * extraction prompt instead of a full agent turn (cheaper and more controlled).
 */

import { useChatStore } from '../../stores/chatStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { ClaudeAdapter } from '../llm/claude';
import { OpenAICompatibleAdapter } from '../llm/openai-compatible';
import type { LLMAdapter } from '../llm/adapter';
import type { StreamEvent } from '../../types';
import type { Message } from '../../types';
import { getMemoryBackend } from './router';
import type { MemoryCategory } from './types';

interface ExtractedMemory {
  summary: string;
  content: string;
  category: MemoryCategory;
  keywords: string[];
}

const EXTRACTION_SYSTEM_PROMPT = `你是一个记忆提取助手。分析给定的对话，提取值得长期记忆的信息。

规则：
- 只提取有持久价值的信息（用户偏好、项目知识、重要决策、待办事项）
- 忽略临时性内容（问候、闲聊、一次性查询）
- 每条记忆必须是独立的、自包含的
- 如果没有值得记忆的内容，返回空数组

输出格式：JSON 数组，每个元素：
{"summary":"一句话摘要","content":"详细内容","category":"分类","keywords":["关键词"]}

category 可选值: user_preference, project_knowledge, conversation_fact, decision, action_item`;

/**
 * Extract memories from a conversation.
 * Best-effort: failures are silently ignored.
 */
export async function extractMemoriesFromConversation(
  conversationId: string,
  scope: 'user' | 'project' = 'user',
  projectPath?: string,
): Promise<void> {
  try {
    const conv = useChatStore.getState().conversations[conversationId];
    if (!conv || conv.messages.length < 4) return; // too short to extract

    // Build transcript from recent messages (last 20)
    const recentMsgs = conv.messages.slice(-20);
    const transcript = recentMsgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const text = typeof m.content === 'string'
          ? m.content
          : (m.content as { type: string; text?: string }[])
              .filter(c => c.type === 'text')
              .map(c => c.text ?? '')
              .join('\n');
        return `${m.role === 'user' ? '用户' : 'AI'}: ${text.slice(0, 500)}`;
      })
      .join('\n');

    if (transcript.length < 50) return; // too little content

    // Create adapter
    const settings = useSettingsStore.getState();
    if (!settings.apiKey) {
      console.warn('[Memory] Auto-extraction skipped: no API key configured');
      return;
    }

    const adapter: LLMAdapter = settings.apiFormat === 'openai-compatible'
      ? new OpenAICompatibleAdapter()
      : new ClaudeAdapter();

    // Make extraction call
    const extractionMessage: Message = {
      id: 'mem-extract',
      role: 'user',
      content: `请分析以下对话并提取值得长期记忆的信息：\n\n${transcript}`,
      timestamp: Date.now(),
    };

    let responseText = '';
    await adapter.chat(
      [extractionMessage],
      {
        model: settings.model,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl || undefined,
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
        maxTokens: 1024,
      },
      (event: StreamEvent) => {
        if (event.type === 'text') {
          responseText += event.text;
        }
      },
    );

    if (!responseText.trim()) return;

    // Parse JSON from response (may be wrapped in ```json```)
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    let extracted: ExtractedMemory[];
    try {
      extracted = JSON.parse(jsonMatch[0]);
    } catch {
      return; // malformed JSON
    }

    if (!Array.isArray(extracted) || extracted.length === 0) return;

    // Write to memory backend
    const backend = getMemoryBackend();
    for (const mem of extracted.slice(0, 5)) { // max 5 entries per extraction
      if (!mem.summary || !mem.content || !mem.category) continue;

      await backend.add({
        category: mem.category,
        summary: mem.summary,
        content: mem.content,
        keywords: mem.keywords ?? [],
        sourceType: 'auto_flush',
        scope,
        projectPath,
      });
    }

    console.log(`[Memory] Extracted ${Math.min(extracted.length, 5)} memories from conversation ${conversationId}`);
  } catch (err) {
    // Best-effort — never block session flow
    console.warn('[Memory] Extraction failed (non-critical):', err);
  }
}
