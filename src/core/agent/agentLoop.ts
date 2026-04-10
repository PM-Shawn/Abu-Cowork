import type { StreamEvent, ToolCall, TokenUsage, ImageAttachment, MessageContent, ToolExecutionContext, LLMProvider } from '../../types';
import type { LLMAdapter } from '../llm/adapter';
import { LLMError } from '../llm/adapter';
import { ClaudeAdapter } from '../llm/claude';
import { OpenAICompatibleAdapter } from '../llm/openai-compatible';
import { getAllTools, type ConfirmationInfo, type FilePermissionCallback } from '../tools/registry';
import type { ToolDefinition } from '../../types';
import { useChatStore, flushTokenBuffer } from '../../stores/chatStore';
import { useSettingsStore, getEffectiveModel, getActiveApiKey, getActiveProvider, resolveAgentModel, providerRequiresApiKey } from '../../stores/settingsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import { createEventRouter } from './eventRouter';
import { routeInput, buildSystemPromptSections, type RouteResult, type IMContext } from './orchestrator';
import type { PromptSection } from '../llm/promptSections';
import { sectionsToString, mergeSections } from '../llm/promptSections';
import { skillLoader } from '../skill/loader';
import { substituteVariables } from '../skill/preprocessor';
import { joinPath } from '../../utils/pathUtils';
import { matchesToolName, parseToolPatterns } from '../skill/toolFilter';
import { notifyTaskCompleted, notifyTaskError } from '../../utils/notifications';
import { prepareContextMessages, trimOldScreenshots } from '../context/contextManager';
import { compressContextIfNeeded } from '../context/contextCompressor';
import { applyMicroCompaction } from '../context/microCompactor';
import { AutoCompactTracker, getUsagePercent } from '../context/autoCompact';
import { estimateToolSchemaTokens, estimateTokens, estimateMessageTokens, calibrateFromUsage, setActiveModel } from '../context/tokenEstimator';
import { identifyRounds, RECENT_ROUNDS_TO_KEEP } from '../context/contextUtils';
import { withRetry } from './retry';
import { runSubagentLoop, extractParentConversationSummary } from './subagentLoop';
import type { SubagentProgressEvent } from './subagentLoop';
import { createSubagentController } from './subagentAbort';
import { drainQueuedInputs, clearInputQueue } from './userInputQueue';
import { snapshotExecutionSteps } from './executionSnapshot';
import { emitHook } from './lifecycleHooks';
import { getI18n, format } from '../../i18n';
import { clearAllSkillHooks } from '../tools/builtins';
import { executeToolBatch } from './toolExecutor';
import { formatTodosForPrompt } from './todoManager';
import { isWindows } from '../../utils/platform';
import { getBuiltinSearchConfig } from '../capabilities';
import { resolveCapabilities } from '../llm/modelCapabilities';
import { TOOL_NAMES } from '../tools/toolNames';
import { prefetchTools } from '../tools/toolPrefetch';
import { classifyTools, buildDeferredToolsSummary } from '../tools/toolSearch';
import { getRunningAgents } from './backgroundAgentRegistry';
import { hasQueuedInputs } from './userInputQueue';
import { createLogger } from '../logging/logger';

const logger = createLogger('agentLoop');

/** MIME type to file extension mapping */
const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Check whether any message in the conversation contains image content (user images or tool result images). */
function conversationHasImages(messages: import('../../types').Message[]): boolean {
  for (const msg of messages) {
    // User-attached images
    if (Array.isArray(msg.content) && msg.content.some(c => c.type === 'image')) return true;
    // Tool result images
    if (msg.toolCalls?.some(tc =>
      tc.resultContent?.some(rc => rc.type === 'image')
    )) return true;
  }
  return false;
}

/**
 * Save user-pasted images to disk so they survive localStorage persistence.
 * Returns array of file paths (one per image). On failure, returns undefined for that slot.
 */
async function saveUserImagesToDisk(
  conversationId: string,
  images: ImageAttachment[],
): Promise<(string | undefined)[]> {
  try {
    const { getSessionOutputDir } = await import('../session/sessionDir');
    const { writeFile, mkdir, exists } = await import('@tauri-apps/plugin-fs');
    const outputDir = await getSessionOutputDir(conversationId);
    const imagesDir = joinPath(outputDir, 'images');
    if (!(await exists(imagesDir))) {
      await mkdir(imagesDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return await Promise.all(
      images.map(async (img, index) => {
        try {
          const ext = MIME_TO_EXT[img.mediaType] || 'png';
          const fileName = `${timestamp}_${index}.${ext}`;
          const filePath = joinPath(imagesDir, fileName);
          const binaryStr = atob(img.data);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          await writeFile(filePath, bytes);
          return filePath;
        } catch {
          return undefined;
        }
      }),
    );
  } catch {
    // Graceful degradation: images still work in current session, just won't persist
    return images.map(() => undefined);
  }
}
import {
  clearLoopContext,
  requestCommandConfirmation,
  requestFilePermission,
  drainConfirmationQueue,
  drainFilePermissionQueue,
  drainWorkspaceRequest,
} from './permissionBridge';

/** Persist execution steps onto the last assistant message for the given loop, then evict from memory */
function persistExecutionSnapshot(conversationId: string, loopId: string): void {
  const store = useTaskExecutionStore.getState();
  const exec = store.getExecutionByLoopId(loopId);
  if (exec && exec.steps.length > 0) {
    useChatStore.getState().setExecutionStepsSnapshot(conversationId, loopId, snapshotExecutionSteps(exec.steps));
    // Evict completed execution from memory — data now lives on the persisted message
    store.evictExecution(exec.id);
  }
}

/**
 * Abu's default soul — factory personality.
 * Used when ~/.abu/SOUL.md is empty or doesn't exist.
 * Exported so orchestrator can use it as fallback.
 */
export function getDefaultSoul(): string {
  return `你叫阿布，是一个专业、靠谱、好沟通的桌面 AI 助手。你的职责是帮用户高效地完成各种工作——文件管理、信息查找、内容创作、日常办公，什么都能搭把手。

## 核心原则
- 语气自然、口语化，像一个靠谱的朋友在帮忙：不端着，但也不卖萌
- 态度积极务实：出了问题给方案，完成任务简要汇报，不需要过度安慰或夸赞
- 自称"阿布"或"我"，不使用颜文字、kaomoji 或 emoji 表情
- 回复简洁、清晰、有重点：不要高冷，也不要啰嗦

## 回复风格 - 简洁直接
- **专注结果，不说过程**：工具调用过程在 UI 中已有展示，文字中不要重复描述
- **禁止技术术语**：不要提及操作系统类型、编程语言、命令行、API 名称、工具名称
- **禁止实现细节**：不要说"我用 Python 来..."、"让我先获取系统信息..."、"在 xxx 系统上..."
- **简短回复示例**：
  - 打开网站 → "小红书帮你打开了"
  - 执行完成 → "搞定了"
  - 读取文件 → "看了一下，这个文件是..."
  - 出错了 → "没成功，[简短原因]，要再试试吗？"
- **例外情况**（可以详细）：用户明确问"你怎么做的"、任务失败需解释、复杂任务需确认步骤`;
}

/**
 * Abu's capability prompt — always injected, cannot be overridden by SOUL.md.
 * Contains operational rules: visualization, work style, permissions, extensions.
 */
export function getCapabilityPrompt(): string {
  const win = isWindows();
  const dangerousCmd = win ? 'del /s /q' : 'rm -rf';
  const abuDir = win ? '%USERPROFILE%\\.abu\\' : '~/.abu/';
  const skillPathTmpl = win ? '%USERPROFILE%\\.abu\\skills\\{技能名}\\' : '~/.abu/skills/{技能名}/';
  const agentPathTmpl = win ? '%USERPROFILE%\\.abu\\agents\\{代理名}\\' : '~/.abu/agents/{代理名}/';

  return `## 可视化输出 — 生成式 UI（重要！）
当用户需要图表、可视化、交互式演示、动画、UI 原型、数据展示、流程解释等视觉内容时，
**必须直接在回复中输出 \`\`\`html 代码块**。前端会自动将其渲染为可交互的内联组件。

**严禁**：
- ❌ 不要调用 generate_image 工具 — html 代码块就能画图表和可视化
- ❌ 不要调用 write_file 工具写 HTML 文件 — 这是对话内的临时可视化，不是文件
- ❌ 不要调用 todo_write 工具 — 直接输出代码块
- ❌ 不写 DOCTYPE/html/head/body 标签 — 只写 HTML 片段（style + HTML + script）

**可以**：
- ✅ 从 CDN 加载外部库（Chart.js、D3 等）：cdn.jsdelivr.net / cdnjs.cloudflare.com / unpkg.com
- ✅ 只在用户明确要求"保存为文件"或"导出"时才调用 write_file

**样式要求**：使用浅色/白色背景，禁止深色/黑色背景。与阿布界面风格保持一致。

## 工作方式 - 主动出击！
你是一个**主动型助手**。当用户给你任务时：
1. **先行动，再汇报** - 不要问用户"你要不要我帮你做X"，直接用工具去做
2. **自主获取信息** - 如果需要知道路径、文件内容等信息，直接用工具获取，不要问用户
3. **遇到问题再沟通** - 只有在真正遇到障碍（权限不够、路径不存在、需要用户做选择）时才问用户

### 常见场景处理
- 用户说"看看桌面" → 直接用工具获取桌面路径并列出内容
- 用户说"帮我整理文件" → 先看看有什么，然后制定计划并执行
- 遇到不确定的专有名词、品牌名、项目名时，先用 web_search 搜索再回答，不要猜测
- 如果在执行任务过程中发现缺少某种工具能力（如操作 GitHub、Slack、数据库），可以用 search_mcp_server 搜索对应的 MCP 服务
- 用户要求安装某个软件/工具/应用（如"帮我安装 xxx"）→ 这是普通软件安装需求，用 web_search 搜索安装方法后告诉用户步骤，或用 run_command 执行安装命令，不要用 search_mcp_server

### 权限与安全
以下操作需要先告知用户并获得确认后再执行：
- **删除文件/目录** - 告诉用户要删什么，等用户说"好/可以/删吧"再执行
- **覆盖已有文件** - 告诉用户文件已存在，等确认再覆盖
- **执行可能有风险的命令** - 如 ${dangerousCmd}、格式化等

**首次访问新目录时需要用户授权**。当你要读取、列出或写入一个新目录的文件时，系统会自动弹出授权对话框。用户授权后，该目录下所有操作都可以正常进行。敏感目录（如 .ssh、.aws 等）会被直接拒绝，无法授权。
普通命令（run_command）可以直接执行，事后汇报结果即可。

## 扩展能力目录结构
阿布的扩展能力存放在用户主目录的 ${abuDir} 文件夹下：
- **skills/** - 技能目录，每个技能包含 SKILL.md 文件，路径：${skillPathTmpl}SKILL.md
- **agents/** - 代理目录，每个代理包含 AGENT.md 文件，路径：${agentPathTmpl}AGENT.md

用 save_skill / save_agent 工具可以创建新的技能或代理。

## 并行代理能力
当用户的任务可以拆分为多个**独立子任务**时，可以使用 delegate_to_agent 的 async 参数并行执行：
- 调用 delegate_to_agent(task: "子任务描述", type: "research", async: true) 会立即返回，代理在后台运行
- 可以同时派出多个代理（最多 5 个），各自独立工作
- 所有代理完成后，结果会自动回传，你再综合输出给用户

### 何时使用并行代理
- 用户要求"同时"、"并行"、"分别"做多件事
- 多个子任务之间没有依赖关系（如调研 A、B、C 三个话题）
- 每个子任务需要多步操作（搜索+整理+总结）

### 何时不使用
- 单个简单问题直接回答即可
- 子任务之间有先后依赖
- 只需要一次工具调用就能完成

### 收到代理结果后
- 你会收到 <agent-result> 格式的代理回传结果
- **综合精简输出**：提炼关键信息和对比，不要逐份罗列原始内容
- 如果多个代理做了类似调研，用对比表格或要点列表呈现差异
- 用自己的话总结，不要复制粘贴代理的原始输出

## 大文件读取策略
- 读取文本文件时，如果文件超过 256KB，read_file 会提示你使用 offset/limit 参数分段读取
- 收到"File is too large"提示后，根据需求决定策略：
  - 需要了解文件整体结构：先读前 200 行（offset=0, limit=200）了解大致内容
  - 需要查找特定内容：用 search_files 按关键词搜索定位，再用 offset/limit 读取对应区域
  - 需要全面分析：分多次读取，每次 2000 行，逐段处理
- 不要尝试一次性读取大文件的全部内容

## 多轮对话管理
- 长对话中如果发现之前的信息可能已过时（比如文件内容可能已变），主动重新获取而不是依赖旧数据
- 当用户的问题明显与之前的上下文无关（换了话题），简洁回应即可，不需要联系之前的上下文
- 如果上下文被系统压缩，继续正常工作，不要提及"上下文被截断"等技术细节

## 错误恢复策略
- 工具调用失败时：分析错误原因，尝试换一种方式（换参数、换工具、换路径），不要简单重试相同操作
- 连续两次失败：停下来告诉用户遇到了什么问题，给出建议
- 网络相关错误：告知用户"网络不太稳定"，建议稍后再试
- 权限错误：明确告诉用户需要什么权限，不要反复尝试

## MCP 工具使用
- 当有已连接的 MCP 服务提供的工具时，优先使用 MCP 工具而非内置工具的替代方案
- 使用 MCP 工具前不需要解释来源，直接调用即可
- MCP 工具如果失败，可以回退到内置工具`;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}



/**
 * Resolve and filter tools for current turn — called per-turn inside the while loop.
 * Supports advanced allowed-tools patterns (wildcards, constraints).
 * Returns { tools, inputValidators } where inputValidators are used at execution time.
 */
function resolveTools(
  route: RouteResult,
  hasBuiltinWebSearch: boolean,
  blockedTools?: string[],
  prefetchContext?: { userInput: string; computerUseEnabled: boolean; activeSkills: import('../../types').Skill[]; turnCount: number },
): { tools: ToolDefinition[]; deferredTools: ToolDefinition[]; inputValidators: Map<string, (input: Record<string, unknown>) => boolean> } {
  let tools = getAllTools();
  let inputValidators = new Map<string, (input: Record<string, unknown>) => boolean>();
  let deferredTools: ToolDefinition[] = [];

  // Conditional tool loading: filter to core + prefetched tools
  // Non-core tools become "deferred" — name + description only in system prompt
  if (prefetchContext && !route.skill?.allowedTools) {
    const additionalToolNames = prefetchTools(prefetchContext);
    const prefetchedSet = new Set(additionalToolNames);
    const classified = classifyTools(tools, prefetchedSet);
    tools = classified.coreTools;
    deferredTools = classified.deferredTools;
  }

  if (route.type === 'skill' && route.skill?.allowedTools) {
    const patterns = route.skill.allowedTools;
    const { inputValidators: validators } = parseToolPatterns(patterns);
    inputValidators = validators;

    // Filter tools: a tool is allowed if any pattern matches its name
    tools = tools.filter(t =>
      patterns.some(pattern => matchesToolName(t.name, pattern)),
    );
    // Skills with explicit allowedTools don't use deferred tools
    deferredTools = [];
  }
  // Skill blocked-tools: blacklist mode (softer than allowedTools whitelist)
  if (route.type === 'skill' && route.skill?.blockedTools) {
    const blockedPatterns = route.skill.blockedTools;
    tools = tools.filter(t =>
      !blockedPatterns.some(pattern => matchesToolName(t.name, pattern)),
    );
    deferredTools = deferredTools.filter(t =>
      !blockedPatterns.some(pattern => matchesToolName(t.name, pattern)),
    );
  }
  if (route.type === 'agent' && route.definition) {
    const def = route.definition;
    if (def.tools && def.tools.length > 0) {
      const allowed = new Set(def.tools);
      tools = tools.filter(t => allowed.has(t.name));
      deferredTools = [];  // Agents with explicit tool lists don't use deferred
    }
    if (def.disallowedTools && def.disallowedTools.length > 0) {
      const blocked = new Set(def.disallowedTools);
      tools = tools.filter(t => !blocked.has(t.name));
      deferredTools = deferredTools.filter(t => !blocked.has(t.name));
    }
  }
  if (hasBuiltinWebSearch) {
    tools = tools.filter(t => t.name !== TOOL_NAMES.WEB_SEARCH);
    deferredTools = deferredTools.filter(t => t.name !== TOOL_NAMES.WEB_SEARCH);
  }
  // Headless / IM mode: block specific tools that require UI interaction
  if (blockedTools && blockedTools.length > 0) {
    const blocked = new Set(blockedTools);
    tools = tools.filter(t => !blocked.has(t.name));
    deferredTools = deferredTools.filter(t => !blocked.has(t.name));
  }
  return { tools, deferredTools, inputValidators };
}

/** Build dynamic capabilities text describing currently available MCP tools */
function buildDynamicCapabilities(tools: ToolDefinition[]): string {
  const mcpTools = tools.filter(t => t.name.includes('__'));
  if (mcpTools.length === 0) return '';

  const byServer = new Map<string, string[]>();
  for (const t of mcpTools) {
    const [server, toolName] = t.name.split('__', 2);
    if (!byServer.has(server)) byServer.set(server, []);
    byServer.get(server)!.push(toolName);
  }
  const lines = Array.from(byServer.entries()).map(
    ([server, toolNames]) => `- ${server}: ${toolNames.join(', ')}`
  );
  return `## 当前已连接的 MCP 工具\n${lines.join('\n')}`;
}

/** Load active skill contents for dynamic system prompt injection, with variable substitution */
async function loadActiveSkillContent(
  activeSkills: string[] | undefined,
  activeSkillArgs?: Record<string, string>,
  conversationId?: string,
): Promise<string> {
  if (!activeSkills || activeSkills.length === 0) return '';
  const skillContents: string[] = [];
  for (const name of activeSkills) {
    const s = skillLoader.getSkill(name);
    if (!s) continue;
    const args = activeSkillArgs?.[name] ?? '';
    const processed = substituteVariables(s.content, args, s.skillDir, conversationId ?? '');
    let block = `### ${s.name}\n${processed}`;

    // SK-5: List supporting files for progressive disclosure
    const supportingFiles = await skillLoader.listSupportingFiles(name);
    if (supportingFiles.length > 0) {
      block += '\n\n**Available reference files** (use `read_skill_file` tool to load when needed):\n';
      block += supportingFiles.map(f => {
        if (f.startsWith('scripts/') || f.startsWith('scripts\\')) {
          const absPath = joinPath(s.skillDir, f);
          return `- ${f} (path: ${absPath})`;
        }
        return `- ${f}`;
      }).join('\n');
    }

    skillContents.push(block);
  }
  if (skillContents.length === 0) return '';
  return `## Active Skill Instructions\n${skillContents.join('\n\n')}`;
}

/**
 * Deactivate all active skills for a conversation (single-turn lifecycle).
 * Called when the agent loop ends (complete, abort, or error).
 */
function deactivateAllSkills(conversationId: string): void {
  const conv = useChatStore.getState().conversations[conversationId];
  if (!conv?.activeSkills || conv.activeSkills.length === 0) return;

  useChatStore.setState((draft: { conversations: Record<string, import('@/types').Conversation> }) => {
    const c = draft.conversations[conversationId];
    if (c) {
      c.activeSkills = [];
      c.activeSkillArgs = {};
    }
  });

  // Clean up skill-scoped hooks
  clearAllSkillHooks();
}

export interface AgentLoopOptions {
  /** Override the command confirmation callback (e.g. auto-deny for scheduled tasks) */
  commandConfirmCallback?: (info: ConfirmationInfo) => Promise<boolean>;
  /** Override the file permission callback (e.g. auto-deny for scheduled tasks) */
  filePermissionCallback?: FilePermissionCallback;
  /** Images attached by the user (paste/drag) */
  images?: ImageAttachment[];
  /** Tool names to block from this run (e.g. 'request_workspace' in headless/IM mode) */
  blockedTools?: string[];
  /** IM headless context — injected into system prompt to replace UI-dependent workspace logic */
  imContext?: IMContext;
}

/**
 * Calculate escalated maxOutputTokens after a max_tokens hit.
 * Doubles the limit (capped by context window) on first recovery attempt.
 * Pure function, exported for testing.
 */
export function escalateMaxOutputTokens(
  currentMax: number,
  contextWindowSize: number,
  recoveryCount: number,
  alreadyEscalated: boolean,
): { maxOutputTokens: number; changed: boolean } {
  if (recoveryCount <= 0 || alreadyEscalated) {
    return { maxOutputTokens: currentMax, changed: false };
  }
  const escalated = Math.min(currentMax * 2, contextWindowSize - 1000);
  if (escalated > currentMax) {
    return { maxOutputTokens: escalated, changed: true };
  }
  return { maxOutputTokens: currentMax, changed: false };
}

export async function runAgentLoop(conversationId: string, userMessage: string, options?: AgentLoopOptions): Promise<void> {
  const chatStore = useChatStore.getState();
  const settings = useSettingsStore.getState();
  const taskExecutionStore = useTaskExecutionStore.getState();

  // Generate a unique loopId for this agent loop - all messages in this loop share it
  const loopId = generateId();

  // Create EventRouter for this execution
  const eventRouter = createEventRouter({
    executionStore: taskExecutionStore,
    appendToolCallContext: (loopId, context) => {
      useChatStore.getState().appendToolCallContext(conversationId, loopId, context);
    },
  });

  if (providerRequiresApiKey(settings) && !getActiveApiKey(settings)) {
    chatStore.addMessage(conversationId, {
      id: generateId(),
      role: 'assistant',
      content: '请先在设置中配置你的 API Key。',
      timestamp: Date.now(),
      loopId,
    });
    return;
  }

  // Create TaskExecution for this agent loop (after apiKey check to avoid leaking executions)
  const execution = taskExecutionStore.createExecution(conversationId, loopId);

  logger.info('Agent loop started', { conversationId, loopId });

  // Get abort controller for this conversation.
  // Force-clear any stale controller first to avoid inheriting aborted state from a previous run.
  chatStore.clearAbortController(conversationId);
  const abortController = chatStore.getAbortController(conversationId);

  // Set conversation status to running
  chatStore.setConversationStatus(conversationId, 'running');

  // Route the input through the orchestrator
  const route = routeInput(userMessage);

  // Refresh skill content from disk to ensure latest version
  if (route.type === 'skill' && route.skill?.filePath) {
    const fresh = await skillLoader.refreshSkill(route.skill.name);
    if (fresh) {
      route.skill = fresh;
      route.skillContent = fresh.content;
    }
  }

  // Build static system prompt sections once (active skills are injected dynamically per-turn)
  const systemPromptSections = await buildSystemPromptSections(route, getCapabilityPrompt(), conversationId, options?.imContext, 0);

  // Build tool execution context — provides resolved workspace for tools like update_memory
  const toolContext: ToolExecutionContext = {
    workspacePath: options?.imContext?.workspacePath ?? useWorkspaceStore.getState().currentPath,
    loopId,
  };

  // Determine effective model — agent can override (with provider compatibility check)
  let effectiveModelId = getEffectiveModel(settings);
  if (route.type === 'agent' && route.definition?.model) {
    effectiveModelId = resolveAgentModel(route.definition.model, settings);
  }
  // Set active model for per-model token calibration
  setActiveModel(effectiveModelId);

  // Add user message with loopId (use cleanInput for display)
  // Include skill info if a skill was triggered
  // Build multimodal content if images are attached
  const userImages = options?.images;
  let userContent: string | MessageContent[];
  if (userImages && userImages.length > 0) {
    // Save images to disk so they survive localStorage persistence
    const savedPaths = await saveUserImagesToDisk(conversationId, userImages);
    const blocks: MessageContent[] = userImages.map((img, i) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: img.mediaType,
        data: img.data,
      },
      filePath: savedPaths[i],
    }));
    if (route.cleanInput) {
      blocks.push({ type: 'text' as const, text: route.cleanInput });
    }
    userContent = blocks;
  } else {
    userContent = route.cleanInput;
  }

  chatStore.addMessage(conversationId, {
    id: generateId(),
    role: 'user',
    content: userContent,
    timestamp: Date.now(),
    loopId,
    skill: route.type === 'skill' && route.skill ? {
      name: route.skill.name,
      description: route.skill.description,
    } : undefined,
    delegateAgent: route.type === 'delegate' && route.delegateAgent ? {
      name: route.delegateAgent.name,
      description: route.delegateAgent.description,
    } : undefined,
  });

  const adapter: LLMAdapter = getActiveProvider(settings)?.apiFormat === 'openai-compatible'
    ? new OpenAICompatibleAdapter()
    : new ClaudeAdapter();

  // Validate required tools are available (blocking check — one-time at start)
  if (route.type === 'skill' && route.skill?.requiredTools) {
    const initialTools = getAllTools();
    const availableNames = new Set(initialTools.map(t => t.name));
    const missing = route.skill.requiredTools.filter(t => !availableNames.has(t));
    if (missing.length > 0) {
      chatStore.addMessage(conversationId, {
        id: generateId(),
        role: 'assistant',
        content: `这个技能需要一些工具但当前不可用哦：${missing.join(', ')}。检查一下相关 MCP 服务器是否已连接～`,
        timestamp: Date.now(),
        loopId,
      });
      chatStore.setConversationStatus(conversationId, 'idle');
      taskExecutionStore.cancelExecution(execution.id);
      return;
    }
  }

  // builtinWebSearch config — refreshed per-turn below (user may change settings mid-conversation)

  // ── Handle @agent direct delegation ──
  if (route.type === 'delegate' && route.delegateAgent) {
    const delegateAgent = route.delegateAgent;
    const taskText = route.cleanInput;

    chatStore.setAgentStatus('tool-calling', TOOL_NAMES.DELEGATE_TO_AGENT, delegateAgent.name);

    // Create a delegate step in the execution
    const delegateStepId = eventRouter.createStepForToolUse(loopId, {
      toolName: TOOL_NAMES.DELEGATE_TO_AGENT,
      toolInput: { agent_name: delegateAgent.name, task: taskText },
    });

    // Build onProgress to visualize subagent tools
    const childIdMap = new Map<string, string>();
    let onProgress: ((event: SubagentProgressEvent) => void) | undefined;
    if (delegateStepId) {
      onProgress = (event) => {
        if (event.type === 'tool-start') {
          const childStepId = eventRouter.addChildStepToDelegate(
            loopId,
            delegateStepId,
            { toolName: event.toolName, toolInput: event.toolInput }
          );
          if (childStepId) childIdMap.set(event.id, childStepId);
        } else if (event.type === 'tool-end') {
          const childStepId = childIdMap.get(event.id);
          if (childStepId) {
            eventRouter.completeChildStep(loopId, delegateStepId, childStepId, event.result, event.error);
          }
        }
      };
    }

    const confirmCb = options?.commandConfirmCallback ?? requestCommandConfirmation;
    const filePermCb = options?.filePermissionCallback ?? requestFilePermission;

    // Extract parent conversation context for the subagent
    const existingMessages = useChatStore.getState().conversations[conversationId]?.messages ?? [];
    const parentConversationSummary = extractParentConversationSummary(existingMessages);

    // Create per-subagent AbortController (linked to parent)
    const { signal: subagentSignal, cleanup: subagentCleanup } = createSubagentController(
      delegateAgent.name,
      abortController.signal
    );

    try {
      const result = await runSubagentLoop({
        agent: delegateAgent,
        task: taskText,
        parentConversationSummary: parentConversationSummary || undefined,
        signal: subagentSignal,
        commandConfirmCallback: confirmCb,
        filePermissionCallback: filePermCb,
        onProgress,
        imContext: options?.imContext,
      });

      // Complete the delegate step
      subagentCleanup();
      chatStore.removeActiveAgent(delegateAgent.name);
      if (delegateStepId) {
        eventRouter.route({ type: 'step-end', loopId, stepId: delegateStepId, result: result.text });
      }

      // Add result as assistant message
      chatStore.addMessage(conversationId, {
        id: generateId(),
        role: 'assistant',
        content: result.text,
        timestamp: Date.now(),
        loopId,
      });

      chatStore.finishStreaming(conversationId);
      chatStore.clearAbortController(conversationId);
      eventRouter.route({ type: 'done', loopId, reason: 'delegate_complete' });
      persistExecutionSnapshot(conversationId, loopId);
      chatStore.setAgentStatus('idle');
      chatStore.setConversationStatus(conversationId, 'completed');

      const convTitle = useChatStore.getState().conversationIndex[conversationId]?.title ?? '任务';
      notifyTaskCompleted(convTitle);
    } catch (err) {
      subagentCleanup();
      chatStore.removeActiveAgent(delegateAgent.name);
      chatStore.setAgentStatus('idle');
      if (err instanceof Error && (err.name === 'AbortError' || abortController.signal.aborted)) {
        chatStore.cancelStreaming(conversationId);
        chatStore.clearAbortController(conversationId);
        taskExecutionStore.cancelExecution(execution.id);
        chatStore.setConversationStatus(conversationId, 'idle');
        return;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      chatStore.addMessage(conversationId, {
        id: generateId(),
        role: 'assistant',
        content: `**Error:** ${errorMessage}`,
        timestamp: Date.now(),
        loopId,
      });
      chatStore.finishStreaming(conversationId);
      chatStore.clearAbortController(conversationId);
      eventRouter.route({ type: 'error', loopId, error: errorMessage });
      persistExecutionSnapshot(conversationId, loopId);
      chatStore.setConversationStatus(conversationId, 'error');
      const convTitle = useChatStore.getState().conversationIndex[conversationId]?.title ?? '任务';
      notifyTaskError(convTitle);
    }
    return;
  }

  // Emit agentStart hook
  await emitHook({
    type: 'agentStart',
    timestamp: Date.now(),
    conversationId,
    agentName: route.name ?? 'abu',
    loopId,
  });

  let continueLoop = true;
  // maxTurns priority: skill > agent definition > global setting > undefined (unlimited)
  const globalMaxTurns = useSettingsStore.getState().agentMaxTurns;
  const maxTurns = route.skill?.maxTurns ?? route.definition?.maxTurns ?? globalMaxTurns;
  let turnCount = 0;
  const autoCompactTracker = new AutoCompactTracker();
  let maxOutputTokensRecoveryCount = 0;
  const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;
  let maxOutputTokensEscalated = false;

  while (continueLoop) {
    // Check if cancelled before starting new turn
    if (abortController.signal.aborted) {
      chatStore.cancelStreaming(conversationId);
      chatStore.clearAbortController(conversationId);
      taskExecutionStore.cancelExecution(execution.id);
      deactivateAllSkills(conversationId);
      chatStore.setConversationStatus(conversationId, 'idle');
      break;
    }

    continueLoop = false;
    turnCount++;

    logger.info('Turn started', { turnCount, maxTurns });

    // Write checkpoint for crash recovery — if app crashes during this turn,
    // we can detect and offer to resume on next launch.
    import('../session/checkpoint').then(({ writeCheckpoint }) => {
      writeCheckpoint({
        conversationId,
        loopId,
        turnCount,
        lastMessageId: useChatStore.getState().conversations[conversationId]?.messages.slice(-1)[0]?.id ?? '',
        status: 'llm_calling',
        timestamp: Date.now(),
      });
    }).catch(() => {});

    // Check for mid-task user input (already added to UI by ChatInput)
    // Regular messages are already in the conversation store — just drain.
    // System messages (e.g. background agent results) need to be added to chatStore here.
    const queuedInputs = drainQueuedInputs(conversationId);
    for (const qi of queuedInputs) {
      if (qi.isSystem) {
        useChatStore.getState().addMessage(conversationId, {
          id: generateId(),
          role: 'user',
          content: qi.text,
          timestamp: qi.timestamp,
          loopId,
          isSystem: true,
        });
      }
    }

    // Emit turnStart hook
    await emitHook({
      type: 'turnStart',
      timestamp: Date.now(),
      conversationId,
      turnNumber: turnCount,
      maxTurns,
    });

    if (maxTurns !== undefined && turnCount > maxTurns) {
      chatStore.addMessage(conversationId, {
        id: generateId(),
        role: 'assistant',
        content: format(getI18n().chat.maxTurnsReached, { n: maxTurns }),
        timestamp: Date.now(),
        loopId,
      });
      chatStore.finishStreaming(conversationId);
      chatStore.clearAbortController(conversationId);
      eventRouter.route({ type: 'done', loopId, reason: 'max_turns' });
      persistExecutionSnapshot(conversationId, loopId);
      chatStore.setConversationStatus(conversationId, 'completed');
      break;
    }

    // Create a placeholder assistant message for streaming with loopId
    const assistantMsgId = generateId();
    chatStore.addMessage(conversationId, {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
      loopId,
    });

    chatStore.setAgentStatus('thinking');

    const collectedToolCalls: ToolCall[] = [];
    const toolCallToStepId: Map<string, string> = new Map();  // Map toolCallId -> stepId
    let collectedThinking = '';
    let finalUsage: TokenUsage | undefined;
    let thinkingEndTime: number | undefined;  // Track when thinking ends
    let lastStopReason = '';

    try {
      // ── Per-turn: refresh tools and dynamic prompt sections ──
      const freshSettings = useSettingsStore.getState();
      const activeProvider = getActiveProvider(freshSettings);
      const builtinWebSearch = activeProvider
        ? getBuiltinSearchConfig(activeProvider.id as LLMProvider, true)
        : undefined;
      // Build prefetch context for conditional tool loading
      const conv = useChatStore.getState().conversations[conversationId];
      const activeSkillObjects = (conv?.activeSkills ?? [])
        .map(name => skillLoader.getSkill(name))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
      const prefetchCtx = {
        userInput: userMessage,
        computerUseEnabled: freshSettings.computerUseEnabled ?? false,
        activeSkills: activeSkillObjects,
        turnCount,
      };
      const { tools, deferredTools, inputValidators } = resolveTools(route, !!builtinWebSearch, options?.blockedTools, prefetchCtx);
      const toolTokens = estimateToolSchemaTokens(tools);
      const dynamicCapabilities = buildDynamicCapabilities(tools);
      const deferredToolsSummary = buildDeferredToolsSummary(deferredTools);
      const activeSkillContent = await loadActiveSkillContent(
        conv?.activeSkills,
        conv?.activeSkillArgs,
        conversationId,
      );

      // Get current messages for this conversation
      const messages = useChatStore.getState().conversations[conversationId]?.messages ?? [];
      // Exclude the last empty assistant message we just added
      const historyMessages = messages.slice(0, -1);

      // Resolve model capabilities from registry
      const modelCaps = resolveCapabilities(effectiveModelId);

      // Determine dynamic maxTokens — use model caps as default, user settings as override
      let maxOutputTokens = freshSettings.enableThinking && modelCaps.thinking
        ? Math.max(freshSettings.maxOutputTokens ?? modelCaps.maxOutputTokens, 16384)
        : (freshSettings.maxOutputTokens ?? modelCaps.maxOutputTokens);
      const contextWindowSize = freshSettings.contextWindowSize ?? modelCaps.contextWindow;

      // Escalate maxOutputTokens on first max_tokens recovery (CC pattern: 8k→64k)
      const escalation = escalateMaxOutputTokens(maxOutputTokens, contextWindowSize, maxOutputTokensRecoveryCount, maxOutputTokensEscalated);
      if (escalation.changed) {
        logger.info('Escalating maxOutputTokens', { from: maxOutputTokens, to: escalation.maxOutputTokens });
        maxOutputTokens = escalation.maxOutputTokens;
        maxOutputTokensEscalated = true;
      }

      // Build effective system prompt: static cached sections + dynamic per-turn sections
      const todoState = formatTodosForPrompt(conversationId);
      const dynamicSections: PromptSection[] = [];
      if (dynamicCapabilities) {
        dynamicSections.push({ name: 'mcp-capabilities', text: dynamicCapabilities, cacheable: false });
      }
      if (activeSkillContent) {
        dynamicSections.push({ name: 'active-skills', text: activeSkillContent, cacheable: false });
      }
      if (todoState) {
        dynamicSections.push({ name: 'todos', text: todoState, cacheable: false });
      }
      if (deferredToolsSummary) {
        dynamicSections.push({ name: 'deferred-tools', text: deferredToolsSummary, cacheable: false });
      }
      let allSections = mergeSections([...systemPromptSections, ...dynamicSections]);
      // String form for token estimation and context management
      let effectiveSystemPrompt = sectionsToString(allSections);

      // Compute context warning level for UI feedback and compression decisions
      const preCompressionTokens = estimateTokens(effectiveSystemPrompt) + estimateMessageTokens(historyMessages) + toolTokens;
      const maxInputTokens = contextWindowSize - maxOutputTokens;
      const warningLevel = autoCompactTracker.updateLevel(preCompressionTokens, maxInputTokens);

      // Update chatStore with warning level so UI can display context indicators
      useChatStore.getState().setContextWarningLevel(conversationId, warningLevel);

      // Step 1: Semantic compression — use cached summary or auto-compact based on warning level
      // Compression triggers when: enough turns AND (cached result available OR warning level triggers compaction)
      let messagesForContext = historyMessages;
      let compressionApplied = false;
      if (turnCount >= 3) {
        const convForCache = useChatStore.getState().conversations[conversationId];
        const cache = convForCache?.contextCache;

        if (cache && cache.messageCountAtCompression <= historyMessages.length) {
          // Reuse cached compression: firstRound + summary + messages after summarized range
          const rounds = identifyRounds(historyMessages);
          const firstRound = rounds[0] ?? [];
          const newMessages = historyMessages.slice(cache.summarizedRange[1]);
          messagesForContext = [...firstRound, cache.summaryMessage, ...newMessages];
          compressionApplied = true;
        } else {
          // No valid cache — attempt compression
          try {
            const compressionResult = await compressContextIfNeeded(
              historyMessages,
              effectiveSystemPrompt,
              contextWindowSize,
              maxOutputTokens,
              {
                adapter,
                model: effectiveModelId,
                apiKey: getActiveApiKey(freshSettings),
                baseUrl: getActiveProvider(freshSettings)?.baseUrl || undefined,
                signal: abortController.signal,
              },
              toolTokens
            );
            if (compressionResult.compressed) {
              messagesForContext = compressionResult.messages;
              compressionApplied = true;
              autoCompactTracker.recordSuccess();
              // Cache the compression result for future turns
              const summaryMsg = compressionResult.messages.find(m => m.id.startsWith('context-summary-'));
              if (summaryMsg) {
                const rounds = identifyRounds(historyMessages);
                const recentMsgCount = rounds.slice(-RECENT_ROUNDS_TO_KEEP).flat().length;
                const endIdx = historyMessages.length - recentMsgCount;
                useChatStore.getState().setContextCache(conversationId, {
                  summaryMessage: summaryMsg,
                  summarizedRange: [rounds[0].length, endIdx],
                  messageCountAtCompression: historyMessages.length,
                });
              }
            }
          } catch {
            // Compression failed — record for circuit breaker
            autoCompactTracker.recordFailure();
          }
        }
      }

      // Step 1.5: Micro-compaction — truncate oversized tool results from older messages
      // This prevents single large tool outputs (e.g. grep returning 10KB) from bloating context.
      // Only affects toolCallsForContext (sent to LLM), not toolCalls (shown in UI).
      messagesForContext = applyMicroCompaction(messagesForContext);

      // Inject compression hint into volatile system prompt so Abu can naturally acknowledge it
      if (compressionApplied) {
        const compressionHint: PromptSection = {
          name: 'compression-hint',
          text: '\n[本轮对话历史经过压缩，较早的细节已摘要化。如果用户提到你不确定的早期细节，坦诚告知并请用户确认，不要编造。]',
          cacheable: false,
        };
        allSections = mergeSections([...allSections, compressionHint]);
        effectiveSystemPrompt = sectionsToString(allSections);
      }

      // Step 2: Trim old screenshots dynamically based on context usage
      const postCompressionTokens = estimateTokens(effectiveSystemPrompt) + estimateMessageTokens(messagesForContext) + toolTokens;
      const usagePercent = getUsagePercent(postCompressionTokens, maxInputTokens);
      const trimmedMessages = trimOldScreenshots(messagesForContext, usagePercent);

      // Step 3: Hard truncation as safety net
      let preparedMessages = prepareContextMessages(
        trimmedMessages,
        effectiveSystemPrompt,
        contextWindowSize,
        maxOutputTokens,
        toolTokens
      );

      const chatOptions = {
        model: effectiveModelId,
        apiKey: getActiveApiKey(freshSettings),
        baseUrl: getActiveProvider(freshSettings)?.baseUrl || undefined,
        systemPrompt: effectiveSystemPrompt,
        systemPromptSections: allSections,
        tools: tools.length > 0 ? tools : undefined,
        maxTokens: maxOutputTokens,
        signal: abortController.signal,
        temperature: freshSettings.temperature,
        enableThinking: freshSettings.enableThinking && modelCaps.thinking !== false,
        thinkingBudget: freshSettings.thinkingBudget,
        supportsVision: modelCaps.vision,
        builtinWebSearch,
      };

      const chatFn = () => adapter.chat(preparedMessages, chatOptions, eventHandler);

      // Periodic flush during streaming — write current assistant message to disk every 5s
      // so crash during long streaming doesn't lose all content
      let lastStreamFlushTime = Date.now();
      const STREAM_FLUSH_INTERVAL = 5000;

      const eventHandler = (event: StreamEvent) => {
          switch (event.type) {
            case 'text':
              // Record thinking end time when we transition from thinking to streaming.
              // Also flush thinkingDuration to the store immediately so the UI can mark
              // the thinking step as completed without waiting for the 'done' event at
              // end-of-turn — otherwise the spinning circle stays next to "思考中..."
              // while the body text is already streaming, which looks broken.
              if (!thinkingEndTime && collectedThinking) {
                thinkingEndTime = Date.now();
                const thinkingStartTime = useChatStore.getState().thinkingStartTime;
                if (thinkingStartTime) {
                  const thinkingDuration = Math.max(1, Math.round((thinkingEndTime - thinkingStartTime) / 1000));
                  useChatStore.getState().updateMessageThinkingDuration(conversationId, thinkingDuration, assistantMsgId);
                }
              }
              chatStore.setAgentStatus('streaming');
              chatStore.appendToLastMessage(conversationId, event.text, assistantMsgId);
              // Periodic disk flush for crash safety — must look up by id, not "last",
              // because the user may have sent another message mid-stream.
              if (Date.now() - lastStreamFlushTime > STREAM_FLUSH_INTERVAL) {
                lastStreamFlushTime = Date.now();
                const currentMsg = useChatStore.getState().conversations[conversationId]
                  ?.messages.find((m) => m.id === assistantMsgId);
                if (currentMsg) {
                  import('../session/conversationStorage').then(({ replaceMessageById }) => {
                    replaceMessageById(conversationId, currentMsg).catch(() => {});
                  }).catch(() => {});
                }
              }
              break;

            case 'thinking':
              collectedThinking += event.thinking;
              useChatStore.getState().updateMessageThinking(conversationId, collectedThinking, assistantMsgId);
              break;

            case 'tool_use': {
              // Flush any buffered streaming tokens before processing tool calls
              flushTokenBuffer(conversationId);
              // Record thinking end time when we transition from thinking to tool-calling
              // and immediately push thinkingDuration so the UI's thinking step flips to
              // completed (same reason as the 'text' branch above).
              if (!thinkingEndTime && collectedThinking) {
                thinkingEndTime = Date.now();
                const thinkingStartTime = useChatStore.getState().thinkingStartTime;
                if (thinkingStartTime) {
                  const thinkingDuration = Math.max(1, Math.round((thinkingEndTime - thinkingStartTime) / 1000));
                  useChatStore.getState().updateMessageThinkingDuration(conversationId, thinkingDuration, assistantMsgId);
                }
              }

              // Special handling for report_plan - save to store, hide from UI
              if (event.name === TOOL_NAMES.REPORT_PLAN) {
                const steps = (event.input as { steps?: string[] }).steps;
                if (steps && steps.length > 0) {
                  // Convert to PlannedStep format and save
                  const plannedSteps = steps.map((desc, i) => ({
                    index: i + 1,
                    description: desc,
                    status: 'pending' as const,
                  }));
                  taskExecutionStore.setPlannedSteps(execution.id, plannedSteps);
                }
                // Add to tool calls but mark as hidden
                collectedToolCalls.push({
                  id: event.id,
                  name: event.name,
                  input: event.input,
                  isExecuting: true,
                  startTime: Date.now(),
                  hidden: true,
                });
                break;
              }

              chatStore.setAgentStatus('tool-calling', event.name);

              // Create step in TaskExecutionStore via EventRouter
              const stepId = eventRouter.createStepForToolUse(loopId, {
                toolName: event.name,
                toolInput: event.input,
              });

              // Store the mapping for later result update
              if (stepId) {
                toolCallToStepId.set(event.id, stepId);

                // Auto-link to next pending planned step
                // Only advance when no planned step is currently running,
                // so multiple tool calls in one turn don't consume all steps at once
                const currentExec = useTaskExecutionStore.getState().executions[execution.id];
                if (currentExec) {
                  const hasRunning = currentExec.plannedSteps.some(s => s.status === 'running');
                  if (!hasRunning) {
                    const nextPending = currentExec.plannedSteps.find(s => s.status === 'pending');
                    if (nextPending) {
                      useTaskExecutionStore.getState().linkPlannedStep(execution.id, nextPending.index, stepId);
                      useTaskExecutionStore.getState().updatePlannedStepStatus(execution.id, nextPending.index, 'running');
                    }
                  }
                }
              }

              collectedToolCalls.push({
                id: event.id,
                name: event.name,
                input: event.input,
                isExecuting: true,
                startTime: Date.now(),
              });

              break;
            }

            case 'usage':
              // Merge into finalUsage so cost tracking and token calibration work.
              // Claude: message_start has cache fields, message_delta has output tokens.
              // OpenAI-compatible: single usage chunk has both input and output.
              finalUsage = finalUsage
                ? { ...finalUsage, ...event.usage }
                : { ...event.usage };
              chatStore.setCurrentUsage(finalUsage);
              break;

            case 'done':
              // Record thinking end time if not already done
              if (!thinkingEndTime && collectedThinking) {
                thinkingEndTime = Date.now();
              }
              // Calculate and save thinking duration
              if (collectedThinking && thinkingEndTime) {
                const thinkingStartTime = useChatStore.getState().thinkingStartTime;
                if (thinkingStartTime) {
                  const thinkingDuration = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
                  useChatStore.getState().updateMessageThinkingDuration(conversationId, thinkingDuration, assistantMsgId);
                }
              }
              // Track stop reason for max_tokens recovery
              lastStopReason = event.stopReason;
              // Continue if there are tool calls
              if (event.stopReason === 'tool_use' && collectedToolCalls.length > 0) {
                continueLoop = true;
                maxOutputTokensRecoveryCount = 0; // Reset on normal tool_use continuation
              }
              if (event.usage) {
                finalUsage = event.usage;
                chatStore.setCurrentUsage(event.usage);
              }
              break;

            case 'error':
              chatStore.appendToLastMessage(conversationId, `\n\n**Error:** ${event.error}`, assistantMsgId);
              break;
          }
        };

      // Execute with retry and context-too-long recovery
      try {
        await withRetry(
          chatFn,
          { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
          abortController.signal,
          (attempt, error, delayMs) => {
            // Show rate-limited status in UI when it's a rate limit error
            if (error.code === 'rate_limit') {
              chatStore.setAgentStatus('rate-limited', `${Math.round(delayMs / 1000)}s`);
            }
            chatStore.appendToLastMessage(
              conversationId,
              `\n*${error.code === 'rate_limit' ? 'API 限流' : '重试'}中 (${attempt})... ${Math.round(delayMs / 1000)}s 后重试*`,
              assistantMsgId
            );
          }
        );
      } catch (retryErr) {
        // Handle context_too_long with two-stage recovery:
        // Stage 1: Semantic compression → retry
        // Stage 2: Hard truncation → retry
        // Stage 3: Surface error to user
        if (retryErr instanceof LLMError && retryErr.code === 'context_too_long') {
          chatStore.appendToLastMessage(
            conversationId,
            '\n*上下文过长，正在优化上下文...*',
            assistantMsgId
          );

          let recovered = false;

          // Stage 1: Try semantic compression (if not already attempted this turn)
          if (!autoCompactTracker.isDisabled()) {
            try {
              const compressionResult = await compressContextIfNeeded(
                historyMessages,
                effectiveSystemPrompt,
                contextWindowSize,
                maxOutputTokens,
                {
                  adapter,
                  model: effectiveModelId,
                  apiKey: getActiveApiKey(freshSettings),
                  baseUrl: getActiveProvider(freshSettings)?.baseUrl || undefined,
                  signal: abortController.signal,
                },
                toolTokens
              );
              if (compressionResult.compressed) {
                preparedMessages = prepareContextMessages(
                  compressionResult.messages,
                  effectiveSystemPrompt,
                  contextWindowSize,
                  maxOutputTokens,
                  toolTokens
                );
                autoCompactTracker.recordSuccess();
                recovered = true;
                logger.info('Context recovered via semantic compression');
              }
            } catch {
              autoCompactTracker.recordFailure();
            }
          }

          // Stage 2: Hard truncation as fallback
          if (!recovered) {
            logger.info('Attempting hard truncation recovery');
            const emergencyRounds = identifyRounds(historyMessages);
            if (emergencyRounds.length > 3) {
              const firstRound = emergencyRounds[0];
              const lastTwoRounds = emergencyRounds.slice(-2);
              preparedMessages = [...firstRound, ...lastTwoRounds.flat()];
            } else {
              const lastTwoRounds = emergencyRounds.slice(-2);
              preparedMessages = lastTwoRounds.flat();
            }
            recovered = true;
          }

          // Retry with recovered messages
          try {
            await adapter.chat(preparedMessages, chatOptions, eventHandler);
          } catch (retryErr2) {
            // Stage 3: Even after truncation, still too long — surface error
            if (retryErr2 instanceof LLMError && retryErr2.code === 'context_too_long') {
              logger.error('Context recovery failed after both compression and truncation');
              throw retryErr2;
            }
            throw retryErr2;
          }
        } else {
          throw retryErr;
        }
      }

      // Update usage on message if available
      if (finalUsage) {
        useChatStore.getState().updateMessageUsage(conversationId, finalUsage, assistantMsgId);
        // Calibrate token estimator with actual API usage
        const estimatedInput = estimateTokens(effectiveSystemPrompt) + estimateMessageTokens(preparedMessages) + toolTokens;
        calibrateFromUsage(estimatedInput, finalUsage.inputTokens);
        // Record cost for fee tracking
        const usageSnapshot = { ...finalUsage };
        import('../llm/costTracker').then(({ recordTurnCost }) => {
          recordTurnCost(conversationId, effectiveModelId, {
            inputTokens: usageSnapshot.inputTokens,
            outputTokens: usageSnapshot.outputTokens,
            cacheReadInputTokens: usageSnapshot.cacheReadInputTokens,
            cacheCreationInputTokens: usageSnapshot.cacheCreationInputTokens,
          });
        }).catch(() => {});
      }

      // If there are tool calls, execute them via toolExecutor
      if (collectedToolCalls.length > 0) {
        const confirmCb = options?.commandConfirmCallback ?? requestCommandConfirmation;
        const filePermCb = options?.filePermissionCallback ?? requestFilePermission;

        const batchResult = await executeToolBatch({
          collectedToolCalls,
          toolCallToStepId,
          conversationId,
          assistantMsgId,
          loopId,
          abortController,
          eventRouter,
          executionId: execution.id,
          inputValidators,
          confirmCb,
          filePermCb,
          toolContext,
          continueLoop,
          contextUsagePercent: usagePercent,
        });

        // ★ Persist this turn's full message state (including completed tool calls)
        // to disk RIGHT NOW. We must use replaceMessageById (not updateLastMessage)
        // because by the time the next turn's addMessage races with our write, the
        // "last line" may already have shifted to the next turn's placeholder, and
        // updateLastMessage would either clobber the new placeholder or update the
        // wrong line. Awaiting here adds a few ms of latency but guarantees disk
        // state matches in-memory state before the loop continues.
        const turnMsg = useChatStore.getState().conversations[conversationId]
          ?.messages.find((m) => m.id === assistantMsgId);
        if (turnMsg) {
          try {
            const { replaceMessageById } = await import('../session/conversationStorage');
            await replaceMessageById(conversationId, turnMsg);
          } catch {
            // Non-critical — message still lives in memory until next finishStreaming
          }
        }

        // Handle MCP tool changes — inject notification into conversation
        if (batchResult.mcpChanged) {
          const toolNames = new Set(tools.map(t => t.name));
          const { tools: freshTools } = resolveTools(route, !!builtinWebSearch, options?.blockedTools);
          const freshNames = new Set(freshTools.map(t => t.name));
          const added = freshTools.filter(t => !toolNames.has(t.name));
          const removed = tools.filter(t => !freshNames.has(t.name));

          if (added.length > 0 || removed.length > 0) {
            const parts: string[] = ['[系统通知] 可用工具已更新。'];
            if (added.length > 0) {
              parts.push(`新增: ${added.map(t => t.name).join(', ')}`);
            }
            if (removed.length > 0) {
              parts.push(`移除: ${removed.map(t => t.name).join(', ')}`);
            }
            parts.push('请根据最新的工具列表继续执行任务。');
            chatStore.addMessage(conversationId, {
              id: generateId(),
              role: 'user',
              content: parts.join('\n'),
              timestamp: Date.now(),
              loopId,
            });
          }
        }
      }

      // Max Output Tokens recovery: if LLM output was truncated (not tool_use),
      // inject a continuation prompt and retry, up to MAX_OUTPUT_TOKENS_RECOVERY_LIMIT times.
      // This matches Claude Code's max_output_tokens_recovery pattern.
      let maxTokensRecoveryExhausted = false;
      if (!continueLoop && lastStopReason === 'max_tokens' && collectedToolCalls.length === 0) {
        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          maxOutputTokensRecoveryCount++;
          logger.info('Max output tokens recovery', { attempt: maxOutputTokensRecoveryCount, limit: MAX_OUTPUT_TOKENS_RECOVERY_LIMIT });
          // Inject a system continuation message (not shown in UI)
          const recoveryMsg = {
            id: generateId(),
            role: 'user' as const,
            content: 'Output token limit reached. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.',
            timestamp: Date.now(),
            loopId,
            isSystem: true as const,
          };
          useChatStore.getState().addMessage(conversationId, recoveryMsg);
          continueLoop = true;
        } else {
          // Recovery exhausted: surface a visible error so the user knows the
          // conversation didn't silently complete. Without this, the loop would
          // fall through to the normal end_turn path and mark status='completed',
          // hiding the failure (this used to happen before the openai-compatible
          // length-branch fix made the escalation reachable at all).
          maxTokensRecoveryExhausted = true;
          logger.warn('Max output tokens recovery exhausted', {
            attempts: MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
            finalMaxTokens: maxOutputTokens,
          });
          chatStore.appendToLastMessage(
            conversationId,
            `\n\n**Error:** 模型连续 ${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT} 次输出达到 token 上限仍未完成。建议：\n` +
            `1. 缩短当前对话或开启新会话\n` +
            `2. 把任务拆分成更小的步骤\n` +
            `3. 切换到上下文更大的模型\n` +
            `4. 写入大文件时让模型用 \`run_command\` + heredoc 追加（\`>>\`）而非单次 \`write_file\``,
            assistantMsgId
          );
        }
      }

      // If the user enqueued additional input mid-stream (handled by ChatInput when
      // a message is sent while a turn is still running), and the current turn ended
      // with plain text rather than tool_use, run another turn so the LLM actually
      // responds to that follow-up. Without this, mid-stream user messages get added
      // to the conversation but never receive a reply.
      if (!continueLoop && hasQueuedInputs(conversationId) && !abortController.signal.aborted) {
        // Flush any buffered tokens and finalize the previous assistant message
        // (toolExecutor normally does this between tool_use turns; we have to do it
        // ourselves on the no-tool path).
        flushTokenBuffer(conversationId, assistantMsgId);
        useChatStore.setState((state) => {
          const msg = state.conversations[conversationId]?.messages.find(
            (m) => m.id === assistantMsgId
          );
          if (msg) msg.isStreaming = false;
        });
        continueLoop = true;
      }

      // If there are running background agents, wait for them to complete before ending
      if (!continueLoop && getRunningAgents().length > 0) {
        logger.info('Waiting for background agents to complete', { count: getRunningAgents().length });
        chatStore.setAgentStatus('thinking');
        // Poll until all background agents finish or user aborts
        while (getRunningAgents().length > 0 && !abortController.signal.aborted) {
          await new Promise(r => setTimeout(r, 1000));
        }
        // Background agents injected results via userInputQueue — continue loop to process them
        if (hasQueuedInputs(conversationId) && !abortController.signal.aborted) {
          continueLoop = true;
        }
      }

      if (!continueLoop) {
        chatStore.finishStreaming(conversationId, assistantMsgId);
        chatStore.clearAbortController(conversationId);
        const endReason = maxTokensRecoveryExhausted ? 'max_tokens_exhausted' : 'end_turn';
        logger.info('Agent loop ended', { conversationId, loopId, turnCount, reason: endReason });
        // Complete the TaskExecution
        eventRouter.route({ type: 'done', loopId, reason: endReason });
        persistExecutionSnapshot(conversationId, loopId);
        // Emit agentEnd hook
        await emitHook({
          type: 'agentEnd',
          timestamp: Date.now(),
          conversationId,
          agentName: route.name ?? 'abu',
          loopId,
          reason: endReason,
        });
        // Auto-deactivate skills after loop completes (single-turn lifecycle)
        deactivateAllSkills(conversationId);
        // Clean up Computer Use session (restore window, hide overlay)
        import('./computerUseStatus').then(({ setComputerUseActive }) => {
          setComputerUseActive(false);
        }).catch(() => {});
        // Clear crash recovery checkpoint — loop completed normally
        import('../session/checkpoint').then(({ clearCheckpoint }) => {
          clearCheckpoint(conversationId);
        }).catch(() => {});
        // Mark conversation status — error if recovery exhausted, otherwise completed
        chatStore.setConversationStatus(conversationId, maxTokensRecoveryExhausted ? 'error' : 'completed');
  
        // Auto-extract memories from desktop conversations (non-blocking)
        // IM conversations have their own extraction in channelRouter.ts
        if (!options?.imContext) {
          const wsPath = useWorkspaceStore.getState().currentPath;
          import('../memdir/extractor').then(({ extractMemoriesFromConversation }) =>
            extractMemoriesFromConversation(conversationId, wsPath)
          ).catch(() => {});
        }
        const convTitle = useChatStore.getState().conversationIndex[conversationId]?.title ?? '任务';
        notifyTaskCompleted(convTitle);
      }
    } catch (err) {
      // Handle abort errors gracefully
      if (err instanceof Error && (err.name === 'AbortError' || abortController.signal.aborted)) {
        logger.warn('Agent loop aborted', { conversationId, loopId });

        // Backfill missing tool results for interrupted tool calls.
        // Without this, orphaned tool_use blocks cause API 400 errors on the next turn.
        for (const tc of collectedToolCalls) {
          const existing = useChatStore.getState().conversations[conversationId]
            ?.messages.find((m) => m.id === assistantMsgId)
            ?.toolCalls?.find((t) => t.id === tc.id);
          if (existing && existing.result === undefined) {
            chatStore.updateToolCall(conversationId, assistantMsgId, tc.id,
              '[Tool execution interrupted by user]', undefined, true);
            chatStore.appendToolCallContext(conversationId, loopId, {
              name: tc.name,
              input: tc.input,
              result: '[Tool execution interrupted by user]',
            });
          }
        }

        // Clear loop context and any pending confirmation/permission dialogs
        clearLoopContext(loopId);
        clearInputQueue(conversationId);
        drainConfirmationQueue();
        drainFilePermissionQueue();
        drainWorkspaceRequest();

        chatStore.cancelStreaming(conversationId);
        chatStore.clearAbortController(conversationId);
        // Cancel the TaskExecution
        taskExecutionStore.cancelExecution(execution.id);
        // Auto-deactivate skills on abort
        deactivateAllSkills(conversationId);
        // Clear crash recovery checkpoint — loop aborted by user
        import('../session/checkpoint').then(({ clearCheckpoint }) => {
          clearCheckpoint(conversationId);
        }).catch(() => {});
        // Set status back to idle on cancel
        chatStore.setConversationStatus(conversationId, 'idle');
  
        continueLoop = false;
        return;
      }

      clearLoopContext(loopId);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof LLMError ? err.code : undefined;
      logger.error('LLM call failed', { error: errorMessage, code: errorCode });
      logger.info('Agent loop ended', { conversationId, loopId, turnCount, reason: 'error' });

      // Friendly message when a 400 error is likely caused by image content
      // sent to a model that doesn't support vision
      const isLikelyVisionError = errorCode === 'invalid_request'
        && err instanceof LLMError && err.statusCode === 400
        && conversationHasImages(useChatStore.getState().conversations[conversationId]?.messages ?? []);
      const displayError = isLikelyVisionError
        ? '当前模型可能不支持图片/视觉输入，请尝试移除图片或切换到支持视觉的模型（如 Claude、GPT-4o）。'
        : errorMessage;

      chatStore.appendToLastMessage(
        conversationId,
        `\n\n**Error:** ${displayError}`,
        assistantMsgId
      );
      chatStore.finishStreaming(conversationId, assistantMsgId);
      chatStore.clearAbortController(conversationId);
      // Error the TaskExecution
      eventRouter.route({ type: 'error', loopId, error: errorMessage });
      persistExecutionSnapshot(conversationId, loopId);
      // Auto-deactivate skills on error
      deactivateAllSkills(conversationId);
      // Clean up Computer Use session
      import('./computerUseStatus').then(({ setComputerUseActive }) => {
        setComputerUseActive(false);
      }).catch(() => {});
      // Clear crash recovery checkpoint — loop ended with error
      import('../session/checkpoint').then(({ clearCheckpoint }) => {
        clearCheckpoint(conversationId);
      }).catch(() => {});
      // Mark conversation as error and send notification
      chatStore.setConversationStatus(conversationId, 'error');

      const convTitle = useChatStore.getState().conversationIndex[conversationId]?.title ?? '任务';
      notifyTaskError(convTitle);
      continueLoop = false;
    }
  }
}
