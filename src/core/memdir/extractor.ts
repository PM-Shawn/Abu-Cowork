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
import { useSettingsStore, getActiveApiKey, getActiveProvider, getEffectiveModel } from '../../stores/settingsStore';
import { ClaudeAdapter } from '../llm/claude';
import { OpenAICompatibleAdapter } from '../llm/openai-compatible';
import type { LLMAdapter } from '../llm/adapter';
import type { StreamEvent } from '../../types';
import type { Message } from '../../types';
import type { MemoryType } from '../memdir/types';

interface ExtractedMemory {
  name: string;
  content: string;
  type: MemoryType;
  /**
   * Optional. When set, the writer will delete the referenced filename before
   * writing the new entry — used to atomically replace an outdated/conflicting
   * memory rather than producing a near-duplicate alongside it.
   */
  _replaces?: string;
}

const EXTRACTION_SYSTEM_PROMPT = `你是一个记忆提取助手。分析给定的对话，提取值得长期记忆的信息。

## 类型说明（4 类）
- user: 用户习惯、偏好、角色、知识水平、工作流
- feedback: 用户对 AI 行为的纠正或确认（重点关注），格式：规则 + 原因（Why）+ 适用场景（How to apply）
- project: 项目动态、关键决策、重要结论、待办事项（注意：技术栈/架构/文件路径属于"可派生信息"，不要保存）
- reference: 外部系统指针（文档链接、看板地址、频道名）

## feedback 类型说明
当以下情况出现时，提取为 feedback：
- 用户纠正 AI 做法："不要这样"、"别用这个"、"下次先..."
- 用户确认非常规做法："对就这样"、"这个方式不错"
- 工具反复失败后，用户或 AI 总结了规避方法
feedback content 必须包含：规则本身 + Why（用户为什么这么要求）+ How to apply（什么场景下生效）

## ❌ 不要保存（重要：宁缺毋滥）

### 一次性任务结果（绝对不要）
反面教材（来自真实违规案例）：
- "claude_code 实践教程已整理"、"翻译完成"、"路线已规划"、"PPT 已导出"
- "整理了 N 个文件"、"X 已生成完成"、"Y 已成功"
判断标准：用过去时描述某件已完成的事 → 跳过。

### 临时状态（绝对不要）
反面教材：
- "API 密钥无效"、"端口被占用"、"服务连不上"
- "持久化功能测试成功"、"并发写入测试完成"、"X 测试通过"
判断标准：描述当前某个状态/系统是否正常 → 状态会变 → 跳过。

### 可派生信息（绝对不要）
反面教材：
- "项目位于 /Users/X"、"应用名叫 Y"、"项目用 Tauri/React"
- "代码在 N 处用了 Z 模式"、"用户电脑上安装了 X 应用"
判断标准：从工作区路径、package.json、grep 都能查到 → 跳过。

### 工具/接口/技能信息（绝对不要）
反面教材：
- "数易平台报表下载接口"、"数易平台报表下载任务状态"
- "数易平台定时下载报表列表"、"X 平台 Y 接口"
- "abu-browser-bridge 扩展用于获取浏览器标签页"（重复 3 次）
判断标准：描述某个工具/平台的接口/功能/用法 → 这属于 skill 系统职责 → 跳过。

### 索引中已有的内容
对话中如果出现的信息与"已有记忆索引"中某条相同或表达相同概念（即便用词不同），**不要重复提取**。

### 闲聊、问候、一次性查询
"你好"、"谢谢"、"今天天气如何"、"帮我算 1+1"、一般性新闻时事 —— 无持久价值。

## 三问筛查

对每条候选信息提问，三个都"是"才保存：
1. 这条信息**下次对话还有用**吗？（不是当前任务的临时事实）
2. 这条信息**无法从代码/工作区路径/项目配置文件推断**吗？
3. 这条信息**与索引中现有记忆不重复**吗？

任一个"否" → 跳过。

## 工具上下文
对话中 [工具] 标记表示工具调用及结果。工具偶发错误不提取；但失败导致用户纠正或 AI 总结了规避方法，应提取为 feedback。

## 处理冲突或更新（重要）

如果对话中有信息**与已有记忆索引冲突或更新**（如索引有"用户名为小包"，
对话里用户改口"我叫小白"；或索引有"用 npm"，用户改口"以后用 bun"），
输出时附 \`_replaces\` 字段引用要替换的 **filename**（来自已有索引）：

\`\`\`json
{
  "name": "用户名为小白",
  "content": "用户名为小白，希望被这样称呼",
  "type": "user",
  "_replaces": "user_用户名为_小包.md"
}
\`\`\`

写入逻辑会自动 **删除旧条 + 写入新条**，避免冲突的两条并存。

判断"是否冲突"：
- 同一事实不同值（名字、偏好、决策被推翻）→ 冲突，要 _replaces
- feedback 缺 Why/How，新对话补全了 → 替换为完整版本，要 _replaces
- 完全独立的新事实 → 普通 append（**不**要 _replaces）
- 近义但没新信息 → 跳过（**不**要输出）

## 规则
- 宁可返回 [] 也不要保存可疑内容
- 高质量 1 条胜于平庸 5 条
- 每条记忆必须独立、自包含
- 冲突时主动用 _replaces，**不要**留两条值矛盾的记忆并存
- 如果没有值得记忆的内容，返回空数组

输出格式：JSON 数组，每个元素：
{"name":"简短标题","content":"详细内容","type":"分类","_replaces":"可选-旧 filename"}

type 可选值: user, feedback, project, reference`;

/** Summarize tool calls on an assistant message for extraction context */
function summarizeToolCalls(message: Message): string {
  if (!message.toolCalls || message.toolCalls.length === 0) return '';
  return message.toolCalls
    .map(tc => {
      if (tc.isError) {
        const snippet = (tc.result ?? '').slice(0, 100);
        return `  [工具] ${tc.name} → 失败: ${snippet}`;
      }
      return `  [工具] ${tc.name} → 成功`;
    })
    .join('\n');
}

/**
 * Extract memories from a conversation.
 * Best-effort: failures are silently ignored.
 */
export async function extractMemoriesFromConversation(
  conversationId: string,
  workspacePath?: string | null,
): Promise<void> {
  try {
    const conv = useChatStore.getState().conversations[conversationId];
    const messages = conv?.messages ?? await (async () => {
      const { loadMessages } = await import('../session/conversationStorage');
      return loadMessages(conversationId);
    })();
    if (messages.length < 4) return; // too short to extract

    // Build transcript from recent messages (last 20)
    const recentMsgs = messages.slice(-20);
    const transcript = recentMsgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        const text = typeof m.content === 'string'
          ? m.content
          : (m.content as { type: string; text?: string }[])
              .filter(c => c.type === 'text')
              .map(c => c.text ?? '')
              .join('\n');
        const role = m.role === 'user' ? '用户' : 'AI';
        const toolSummary = m.role === 'assistant' ? summarizeToolCalls(m) : '';
        const line = `${role}: ${text.slice(0, 500)}`;
        return toolSummary ? `${line}\n${toolSummary}` : line;
      })
      .join('\n');

    if (transcript.length < 50) return; // too little content

    // Create adapter
    const settings = useSettingsStore.getState();
    const activeApiKey = getActiveApiKey(settings);
    if (!activeApiKey) {
      console.warn('[Memory] Auto-extraction skipped: no API key configured');
      return;
    }

    const adapter: LLMAdapter = getActiveProvider(settings)?.apiFormat === 'openai-compatible'
      ? new OpenAICompatibleAdapter()
      : new ClaudeAdapter();

    // Inject existing memory manifest so the extractor can deduplicate against
    // what's already stored. Best-effort: failures fall through to extraction
    // without a manifest (worse dedup, but extraction still happens).
    const MAX_MANIFEST_LINES = 50;
    let manifestSection = '';
    try {
      const { scanMemoryFiles } = await import('./scan');
      const [globalHeaders, wsHeaders] = await Promise.all([
        scanMemoryFiles(null),
        workspacePath ? scanMemoryFiles(workspacePath) : Promise.resolve([]),
      ]);
      const allHeaders = [...globalHeaders, ...wsHeaders];
      if (allHeaders.length > 0) {
        // Include filename so the extractor can reference it in _replaces
        // when emitting a conflict-resolving update.
        const lines = allHeaders
          .slice(0, MAX_MANIFEST_LINES)
          .map(h => `- ${h.filename} [${h.type}]: ${h.description}`)
          .join('\n');
        manifestSection = `## 已有记忆索引（用于去重 + 引用 _replaces）\n${lines}\n\n`;
      }
    } catch {
      // Manifest is best-effort; skip if scan fails
    }

    // Make extraction call
    const extractionMessage: Message = {
      id: 'mem-extract',
      role: 'user',
      content: `${manifestSection}## 对话\n${transcript}\n\n请分析上面对话并提取值得长期记忆的信息。先核对"已有记忆索引"避免重复，再按 system prompt 中的"三问筛查"判断是否值得保存。`,
      timestamp: Date.now(),
    };

    let responseText = '';
    await adapter.chat(
      [extractionMessage],
      {
        model: getEffectiveModel(settings),
        apiKey: activeApiKey,
        baseUrl: getActiveProvider(settings)?.baseUrl || undefined,
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

    // Write to memdir as .md files
    const { writeMemory, deleteMemory } = await import('../memdir/write');
    const { ContentSafetyError } = await import('../safety/contentGuard');
    let written = 0;
    let safetyBlocked = 0;
    let replaced = 0;
    for (const mem of extracted.slice(0, 5)) { // max 5 entries per extraction
      if (!mem.name || !mem.content || !mem.type) continue;

      // Handle _replaces: delete the conflicting old entry before writing
      // the new one. If delete fails (e.g. already gone) we still write the
      // new entry — best-effort. Skipping the new write would leave the user
      // worse off than before.
      if (mem._replaces && typeof mem._replaces === 'string') {
        try {
          await deleteMemory(mem._replaces, workspacePath);
          replaced++;
          console.log(`[Memory] Replaced ${mem._replaces} with new entry "${mem.name}"`);
        } catch (err) {
          console.warn(`[Memory] Failed to delete ${mem._replaces} (proceeding with new entry):`, err);
        }
      }

      // Each write is independent: if one entry trips the scanner, skip it
      // and continue with the rest. Auto-extraction is best-effort — we
      // never abort the whole flush on a single bad entry.
      try {
        await writeMemory({
          name: mem.name,
          description: mem.content.slice(0, 80),
          type: mem.type,
          content: mem.content,
          source: 'auto_flush',
          workspacePath,
        });
        written++;
      } catch (err) {
        if (err instanceof ContentSafetyError) {
          safetyBlocked++;
          console.warn(
            `[Memory] Auto-extraction skipped "${mem.name}" — content safety block:`,
            err.scan.findings.map((f) => f.patternId).join(', '),
          );
        } else {
          // Unexpected error — rethrow to outer catch for logging
          throw err;
        }
      }
    }

    if (written > 0) {
      const parts = [];
      if (replaced > 0) parts.push(`${replaced} replaced`);
      if (safetyBlocked > 0) parts.push(`${safetyBlocked} blocked by safety scan`);
      const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      console.log(`[Memory] Extracted ${written} memories from conversation ${conversationId}${suffix}`);
    } else if (safetyBlocked > 0) {
      console.log(`[Memory] All ${safetyBlocked} extracted entries blocked by safety scan for ${conversationId}`);
    }
  } catch (err) {
    // Best-effort — never block session flow
    console.warn('[Memory] Extraction failed (non-critical):', err);
  }
}
