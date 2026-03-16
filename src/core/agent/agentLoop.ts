import type { StreamEvent, ToolCall, TokenUsage, ImageAttachment, MessageContent, ToolExecutionContext } from '../../types';
import type { LLMAdapter } from '../llm/adapter';
import { LLMError } from '../llm/adapter';
import { ClaudeAdapter } from '../llm/claude';
import { OpenAICompatibleAdapter } from '../llm/openai-compatible';
import { getAllTools, executeAnyTool, toolResultToString, type ConfirmationInfo, type FilePermissionCallback } from '../tools/registry';
import type { ToolResult, ToolResultContent, ToolDefinition } from '../../types';
import { useChatStore, flushTokenBuffer } from '../../stores/chatStore';
import { useSettingsStore, getEffectiveModel, resolveAgentModel } from '../../stores/settingsStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import { usePermissionStore } from '../../stores/permissionStore';
import { authorizeWorkspace } from '../tools/pathSafety';
import { createEventRouter } from './eventRouter';
import { routeInput, buildSystemPrompt, type RouteResult, type IMContext } from './orchestrator';
import { skillLoader } from '../skill/loader';
import { substituteVariables } from '../skill/preprocessor';
import { joinPath } from '../../utils/pathUtils';
import { matchesToolName, parseToolPatterns } from '../skill/toolFilter';
import { notifyTaskCompleted, notifyTaskError } from '../../utils/notifications';
import { prepareContextMessages, trimOldScreenshots } from '../context/contextManager';
import { compressContextIfNeeded } from '../context/contextCompressor';
import { identifyRounds, RECENT_ROUNDS_TO_KEEP } from '../context/contextUtils';
import { withRetry } from './retry';
import { runSubagentLoop, extractParentConversationSummary } from './subagentLoop';
import type { SubagentProgressEvent } from './subagentLoop';
import { createSubagentController } from './subagentAbort';
import { drainQueuedInputs, clearInputQueue } from './userInputQueue';
import { snapshotExecutionSteps } from './executionSnapshot';
import { emitHook } from './lifecycleHooks';
import type { PreToolCallEvent } from './lifecycleHooks';
import { invoke } from '@tauri-apps/api/core';
import { setComputerUseBatchMode, setSkipAutoScreenshot, clearAllSkillHooks } from '../tools/builtins';
import { formatTodosForPrompt } from './todoManager';
import { isWindows } from '../../utils/platform';
import { getBuiltinSearchConfig } from '../capabilities';
import { resolveCapabilities } from '../llm/modelCapabilities';

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

// Module-level: current loop's context for delegate_to_agent tool
let currentLoopContext: {
  commandConfirmCallback: (info: ConfirmationInfo) => Promise<boolean>;
  filePermissionCallback: FilePermissionCallback;
  signal: AbortSignal;
  eventRouter: import('./eventRouter').EventRouter;
  loopId: string;
  conversationId: string;
  toolCallToStepId: Map<string, string>;
} | null = null;

export function getCurrentLoopContext() {
  return currentLoopContext;
}

// Global state for pending command confirmation
let pendingConfirmation: {
  info: ConfirmationInfo;
  conversationId: string;
  resolve: (confirmed: boolean) => void;
} | null = null;

// Queue for command confirmations — prevents overwriting when multiple dangerous commands fire in sequence
const confirmationQueue: Array<{
  info: ConfirmationInfo;
  conversationId: string;
  resolve: (confirmed: boolean) => void;
}> = [];

// Subscribers for command confirmation state changes
// NOTE: Listeners are auto-cleaned via the unsubscribe function returned by subscribeToCommandConfirmation,
// which is used as the cleanup callback in useSyncExternalStore. No manual cleanup needed.
const confirmationListeners = new Set<() => void>();

function notifyConfirmationListeners() {
  confirmationListeners.forEach(listener => listener());
}

/**
 * Subscribe to command confirmation state changes
 * For use with useSyncExternalStore
 */
export function subscribeToCommandConfirmation(callback: () => void): () => void {
  confirmationListeners.add(callback);
  return () => confirmationListeners.delete(callback);
}

/**
 * Get the current pending command confirmation request
 */
export function getPendingCommandConfirmation() {
  return pendingConfirmation;
}

/**
 * Resolve the pending command confirmation and process next in queue
 */
export function resolveCommandConfirmation(confirmed: boolean) {
  if (pendingConfirmation) {
    pendingConfirmation.resolve(confirmed);
    pendingConfirmation = null;

    // Process next queued confirmation
    processNextConfirmation();
  }
}

function processNextConfirmation() {
  if (confirmationQueue.length > 0) {
    pendingConfirmation = confirmationQueue.shift()!;
  }
  notifyConfirmationListeners();
}

/**
 * Drain the confirmation queue — reject all pending confirmations.
 * Called on abort to prevent stale confirmation dialogs.
 */
export function drainConfirmationQueue() {
  while (confirmationQueue.length > 0) {
    const req = confirmationQueue.shift()!;
    req.resolve(false);
  }
  if (pendingConfirmation) {
    pendingConfirmation.resolve(false);
    pendingConfirmation = null;
    notifyConfirmationListeners();
  }
}

/**
 * Request confirmation for a dangerous command
 * Returns a promise that resolves when user confirms or cancels.
 * If another confirmation is already pending, this request is queued.
 */
async function requestCommandConfirmation(info: ConfirmationInfo): Promise<boolean> {
  const convId = currentLoopContext?.conversationId ?? '';
  return new Promise((resolve) => {
    if (pendingConfirmation) {
      // Queue instead of overwriting
      confirmationQueue.push({ info, conversationId: convId, resolve });
    } else {
      pendingConfirmation = { info, conversationId: convId, resolve };
      notifyConfirmationListeners();
    }
  });
}

// ── File Permission Request Infrastructure ──

export interface FilePermissionRequest {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
  conversationId: string;
  resolve: (granted: boolean) => void;
}

let pendingFilePermission: FilePermissionRequest | null = null;
const filePermissionQueue: FilePermissionRequest[] = [];
let isProcessingFilePermission = false;

// NOTE: Listeners are auto-cleaned via the unsubscribe function returned by subscribeToFilePermission,
// which is used as the cleanup callback in useSyncExternalStore. No manual cleanup needed.
const filePermissionListeners = new Set<() => void>();

function notifyFilePermissionListeners() {
  filePermissionListeners.forEach(listener => listener());
}

/**
 * Subscribe to file permission state changes (for useSyncExternalStore)
 */
export function subscribeToFilePermission(callback: () => void): () => void {
  filePermissionListeners.add(callback);
  return () => filePermissionListeners.delete(callback);
}

/**
 * Get the current pending file permission request
 */
export function getPendingFilePermission(): FilePermissionRequest | null {
  return pendingFilePermission;
}

/**
 * Resolve the pending file permission request
 */
export function resolveFilePermission(
  granted: boolean,
  path?: string,
  capabilities?: ('read' | 'write' | 'execute')[],
  duration?: import('../../stores/permissionStore').PermissionDuration
) {
  if (pendingFilePermission) {
    if (granted && path && capabilities && duration) {
      // Grant permission via permissionStore (which syncs to pathSafety)
      usePermissionStore.getState().grantPermission(path, capabilities, duration);
    }
    pendingFilePermission.resolve(granted);
    pendingFilePermission = null;
    notifyFilePermissionListeners();

    // Process next queued request
    processNextFilePermission();
  }
}

function processNextFilePermission() {
  while (filePermissionQueue.length > 0) {
    const next = filePermissionQueue.shift()!;

    // Re-check if permission was already granted (another tool may have triggered it)
    const permStore = usePermissionStore.getState();
    if (permStore.hasPermission(next.path, next.capability)) {
      next.resolve(true);
      continue;
    }

    pendingFilePermission = next;
    notifyFilePermissionListeners();
    return;
  }

  isProcessingFilePermission = false;
}

/**
 * Drain the file permission queue — reject all pending requests.
 * Called on abort to prevent stale permission dialogs.
 */
export function drainFilePermissionQueue() {
  // Reject all queued requests
  while (filePermissionQueue.length > 0) {
    const req = filePermissionQueue.shift()!;
    req.resolve(false);
  }
  // Clear current pending request
  if (pendingFilePermission) {
    pendingFilePermission.resolve(false);
    pendingFilePermission = null;
    notifyFilePermissionListeners();
  }
  isProcessingFilePermission = false;
}

/**
 * Request file permission — checks permissionStore first, then queues for UI
 */
async function requestFilePermission(request: {
  path: string;
  capability: 'read' | 'write';
  toolName: string;
}): Promise<boolean> {
  const permStore = usePermissionStore.getState();

  // Already has permission → auto-allow
  if (permStore.hasPermission(request.path, request.capability)) {
    // Also sync to pathSafety in case it wasn't already
    authorizeWorkspace(request.path);
    return true;
  }

  const convId = currentLoopContext?.conversationId ?? '';
  return new Promise((resolve) => {
    const filePermReq: FilePermissionRequest = { ...request, conversationId: convId, resolve };

    if (!isProcessingFilePermission) {
      isProcessingFilePermission = true;
      pendingFilePermission = filePermReq;
      notifyFilePermissionListeners();
    } else {
      // Queue for later processing
      filePermissionQueue.push(filePermReq);
    }
  });
}

// ── Workspace Request Infrastructure ──

export interface WorkspaceRequest {
  reason: string;
  conversationId: string;
  suggestedPath?: string;
  resolve: (path: string | null) => void;
}

let pendingWorkspaceRequest: WorkspaceRequest | null = null;
const workspaceRequestListeners = new Set<() => void>();

function notifyWorkspaceRequestListeners() {
  workspaceRequestListeners.forEach(listener => listener());
}

/**
 * Subscribe to workspace request state changes (for useSyncExternalStore)
 */
export function subscribeToWorkspaceRequest(callback: () => void): () => void {
  workspaceRequestListeners.add(callback);
  return () => workspaceRequestListeners.delete(callback);
}

/**
 * Get the current pending workspace request
 */
export function getPendingWorkspaceRequest(): WorkspaceRequest | null {
  return pendingWorkspaceRequest;
}

/**
 * Resolve the pending workspace request (called from UI)
 */
export function resolveWorkspaceRequest(path: string | null): void {
  if (pendingWorkspaceRequest) {
    pendingWorkspaceRequest.resolve(path);
    pendingWorkspaceRequest = null;
    notifyWorkspaceRequestListeners();
  }
}

/**
 * Drain workspace request — reject pending request on abort
 */
export function drainWorkspaceRequest(): void {
  if (pendingWorkspaceRequest) {
    pendingWorkspaceRequest.resolve(null);
    pendingWorkspaceRequest = null;
    notifyWorkspaceRequestListeners();
  }
}

/** Timeout for workspace selection — auto-resolve(null) if user doesn't respond */
const WORKSPACE_REQUEST_TIMEOUT_MS = 60_000; // 60 seconds

/**
 * Request the user to select a workspace folder.
 * Called from the request_workspace tool.
 * Auto-resolves to null after timeout to prevent indefinite hangs.
 */
export async function requestWorkspace(reason: string, conversationId?: string, suggestedPath?: string): Promise<string | null> {
  const convId = conversationId ?? currentLoopContext?.conversationId ?? '';
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingWorkspaceRequest?.resolve === wrappedResolve) {
        console.warn('[AgentLoop] Workspace request timed out, auto-cancelling');
        pendingWorkspaceRequest = null;
        notifyWorkspaceRequestListeners();
        resolve(null);
      }
    }, WORKSPACE_REQUEST_TIMEOUT_MS);

    const wrappedResolve = (path: string | null) => {
      clearTimeout(timer);
      resolve(path);
    };

    pendingWorkspaceRequest = { reason, conversationId: convId, suggestedPath, resolve: wrappedResolve };
    notifyWorkspaceRequestListeners();
  });
}

function getBaseSystemPrompt(): string {
  const win = isWindows();
  const dangerousCmd = win ? 'del /s /q' : 'rm -rf';
  const abuDir = win ? '%USERPROFILE%\\.abu\\' : '~/.abu/';
  const skillPathTmpl = win ? '%USERPROFILE%\\.abu\\skills\\{技能名}\\' : '~/.abu/skills/{技能名}/';
  const agentPathTmpl = win ? '%USERPROFILE%\\.abu\\agents\\{代理名}\\' : '~/.abu/agents/{代理名}/';

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
- **例外情况**（可以详细）：用户明确问"你怎么做的"、任务失败需解释、复杂任务需确认步骤

## 可视化输出 — 生成式 UI（重要！）
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
): { tools: ToolDefinition[]; inputValidators: Map<string, (input: Record<string, unknown>) => boolean> } {
  let tools = getAllTools();
  let inputValidators = new Map<string, (input: Record<string, unknown>) => boolean>();

  if (route.type === 'skill' && route.skill?.allowedTools) {
    const patterns = route.skill.allowedTools;
    const { inputValidators: validators } = parseToolPatterns(patterns);
    inputValidators = validators;

    // Filter tools: a tool is allowed if any pattern matches its name
    tools = tools.filter(t =>
      patterns.some(pattern => matchesToolName(t.name, pattern)),
    );
  }
  if (route.type === 'agent' && route.definition) {
    const def = route.definition;
    if (def.tools && def.tools.length > 0) {
      const allowed = new Set(def.tools);
      tools = tools.filter(t => allowed.has(t.name));
    }
    if (def.disallowedTools && def.disallowedTools.length > 0) {
      const blocked = new Set(def.disallowedTools);
      tools = tools.filter(t => !blocked.has(t.name));
    }
  }
  if (hasBuiltinWebSearch) {
    tools = tools.filter(t => t.name !== 'web_search');
  }
  // Headless / IM mode: block specific tools that require UI interaction
  if (blockedTools && blockedTools.length > 0) {
    const blocked = new Set(blockedTools);
    tools = tools.filter(t => !blocked.has(t.name));
  }
  return { tools, inputValidators };
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

  if (!settings.apiKey) {
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

  // Build static system prompt once (active skills are injected dynamically per-turn)
  const systemPrompt = await buildSystemPrompt(route, getBaseSystemPrompt(), conversationId, options?.imContext);

  // Build tool execution context — provides resolved workspace for tools like update_memory
  const toolContext: ToolExecutionContext = {
    workspacePath: options?.imContext?.workspacePath ?? useWorkspaceStore.getState().currentPath,
  };

  // Determine effective model — agent can override (with provider compatibility check)
  let effectiveModelId = getEffectiveModel(settings);
  if (route.type === 'agent' && route.definition?.model) {
    effectiveModelId = resolveAgentModel(route.definition.model, settings);
  }

  // Add user message with loopId (use cleanInput for display)
  // Include skill info if a skill was triggered
  // Build multimodal content if images are attached
  const userImages = options?.images;
  let userContent: string | MessageContent[];
  if (userImages && userImages.length > 0) {
    const blocks: MessageContent[] = userImages.map((img) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: img.mediaType,
        data: img.data,
      },
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

  const adapter: LLMAdapter = settings.apiFormat === 'openai-compatible'
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

    chatStore.setAgentStatus('tool-calling', 'delegate_to_agent', delegateAgent.name);

    // Create a delegate step in the execution
    const delegateStepId = eventRouter.createStepForToolUse(loopId, {
      toolName: 'delegate_to_agent',
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
        eventRouter.route({ type: 'step-end', loopId, stepId: delegateStepId, result });
      }

      // Add result as assistant message
      chatStore.addMessage(conversationId, {
        id: generateId(),
        role: 'assistant',
        content: result,
        timestamp: Date.now(),
        loopId,
      });

      chatStore.finishStreaming(conversationId);
      chatStore.clearAbortController(conversationId);
      eventRouter.route({ type: 'done', loopId, reason: 'delegate_complete' });
      persistExecutionSnapshot(conversationId, loopId);
      chatStore.setAgentStatus('idle');
      chatStore.setConversationStatus(conversationId, 'completed');
      const convTitle = useChatStore.getState().conversations[conversationId]?.title ?? '任务';
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
      const convTitle = useChatStore.getState().conversations[conversationId]?.title ?? '任务';
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
  // Computer use needs more turns (each click/type/key is a separate turn)
  const defaultMaxTurns = useSettingsStore.getState().computerUseEnabled ? 50 : 20;
  const maxTurns = route.skill?.maxTurns ?? route.definition?.maxTurns ?? defaultMaxTurns;
  let turnCount = 0;

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

    // Check for mid-task user input (already added to UI by ChatInput)
    // Just drain the queue — messages are already in the conversation store
    drainQueuedInputs(conversationId);

    // Emit turnStart hook
    await emitHook({
      type: 'turnStart',
      timestamp: Date.now(),
      conversationId,
      turnNumber: turnCount,
      maxTurns,
    });

    if (turnCount > maxTurns) {
      chatStore.addMessage(conversationId, {
        id: generateId(),
        role: 'assistant',
        content: `已达到最大轮次限制 (${maxTurns})，停止执行。`,
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

    try {
      // ── Per-turn: refresh tools and dynamic prompt sections ──
      const freshSettings = useSettingsStore.getState();
      const builtinWebSearch = getBuiltinSearchConfig(freshSettings.provider, freshSettings.useBuiltinWebSearch);
      const { tools, inputValidators } = resolveTools(route, !!builtinWebSearch, options?.blockedTools);
      const dynamicCapabilities = buildDynamicCapabilities(tools);
      const conv = useChatStore.getState().conversations[conversationId];
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
      const maxOutputTokens = freshSettings.enableThinking && modelCaps.thinking
        ? Math.max(freshSettings.maxOutputTokens ?? modelCaps.maxOutputTokens, 16384)
        : (freshSettings.maxOutputTokens ?? modelCaps.maxOutputTokens);
      const contextWindowSize = freshSettings.contextWindowSize ?? modelCaps.contextWindow;

      // Build effective system prompt: static base + dynamic per-turn sections
      const todoState = formatTodosForPrompt(conversationId);
      const effectiveSystemPrompt = [
        systemPrompt,
        dynamicCapabilities,
        activeSkillContent,
        todoState,
      ].filter(Boolean).join('\n\n');

      // Step 1: Semantic compression — use cached summary or generate new one
      let messagesForContext = historyMessages;
      if (turnCount >= 3) {
        const convForCache = useChatStore.getState().conversations[conversationId];
        const cache = convForCache?.contextCache;

        if (cache && cache.messageCountAtCompression <= historyMessages.length) {
          // Reuse cached compression: firstRound + summary + messages after summarized range
          const rounds = identifyRounds(historyMessages);
          const firstRound = rounds[0] ?? [];
          const newMessages = historyMessages.slice(cache.summarizedRange[1]);
          messagesForContext = [...firstRound, cache.summaryMessage, ...newMessages];
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
                apiKey: freshSettings.apiKey,
                baseUrl: freshSettings.baseUrl || undefined,
                signal: abortController.signal,
              }
            );
            if (compressionResult.compressed) {
              messagesForContext = compressionResult.messages;
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
            // Compression failed — continue with uncompressed messages
          }
        }
      }

      // Step 2: Trim old screenshots to save context (keep only 3 most recent)
      const trimmedMessages = trimOldScreenshots(messagesForContext);

      // Step 3: Hard truncation as safety net
      let preparedMessages = prepareContextMessages(
        trimmedMessages,
        effectiveSystemPrompt,
        contextWindowSize,
        maxOutputTokens
      );

      const chatOptions = {
        model: effectiveModelId,
        apiKey: freshSettings.apiKey,
        baseUrl: freshSettings.baseUrl || undefined,
        systemPrompt: effectiveSystemPrompt,
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

      const eventHandler = (event: StreamEvent) => {
          switch (event.type) {
            case 'text':
              // Record thinking end time when we transition from thinking to streaming
              if (!thinkingEndTime && collectedThinking) {
                thinkingEndTime = Date.now();
              }
              chatStore.setAgentStatus('streaming');
              chatStore.appendToLastMessage(conversationId, event.text);
              break;

            case 'thinking':
              collectedThinking += event.thinking;
              useChatStore.getState().updateMessageThinking(conversationId, collectedThinking);
              break;

            case 'tool_use': {
              // Flush any buffered streaming tokens before processing tool calls
              flushTokenBuffer(conversationId);
              // Record thinking end time when we transition from thinking to tool-calling
              if (!thinkingEndTime && collectedThinking) {
                thinkingEndTime = Date.now();
              }

              // Special handling for report_plan - save to store, hide from UI
              if (event.name === 'report_plan') {
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
              chatStore.setCurrentUsage(event.usage);
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
                  useChatStore.getState().updateMessageThinkingDuration(conversationId, thinkingDuration);
                }
              }
              // Continue if there are tool calls
              if (event.stopReason === 'tool_use' && collectedToolCalls.length > 0) {
                continueLoop = true;
              }
              if (event.usage) {
                finalUsage = event.usage;
                chatStore.setCurrentUsage(event.usage);
              }
              break;

            case 'error':
              chatStore.appendToLastMessage(conversationId, `\n\n**Error:** ${event.error}`);
              break;
          }
        };

      // Execute with retry and context-too-long recovery
      try {
        await withRetry(
          chatFn,
          { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
          abortController.signal,
          (attempt, _error, delayMs) => {
            chatStore.appendToLastMessage(
              conversationId,
              `\n*重试中 (${attempt}/3)... ${Math.round(delayMs / 1000)}s 后重试*`
            );
          }
        );
      } catch (retryErr) {
        // Handle context_too_long by compression first, then aggressive truncation
        if (retryErr instanceof LLMError && retryErr.code === 'context_too_long') {
          chatStore.appendToLastMessage(
            conversationId,
            '\n*上下文过长，尝试压缩后重试...*'
          );

          // Step A: Try semantic compression first
          let compressed = false;
          try {
            const compressionResult = await compressContextIfNeeded(
              historyMessages,
              effectiveSystemPrompt,
              contextWindowSize,
              maxOutputTokens,
              {
                adapter,
                model: effectiveModelId,
                apiKey: freshSettings.apiKey,
                baseUrl: freshSettings.baseUrl || undefined,
                signal: abortController.signal,
              }
            );
            if (compressionResult.compressed) {
              preparedMessages = prepareContextMessages(
                compressionResult.messages,
                effectiveSystemPrompt,
                contextWindowSize,
                maxOutputTokens
              );
              compressed = true;
            }
          } catch {
            // Compression failed — fall through to hard truncation
          }

          // Step B: Hard truncation as last resort
          if (!compressed) {
            const emergencyRounds = identifyRounds(historyMessages);
            if (emergencyRounds.length > 3) {
              const firstRound = emergencyRounds[0];
              const lastTwoRounds = emergencyRounds.slice(-2);
              preparedMessages = [...firstRound, ...lastTwoRounds.flat()];
            } else {
              const lastTwoRounds = emergencyRounds.slice(-2);
              preparedMessages = lastTwoRounds.flat();
            }
          }

          await adapter.chat(preparedMessages, chatOptions, eventHandler);
        } else {
          throw retryErr;
        }
      }

      // Update usage on message if available
      if (finalUsage) {
        useChatStore.getState().updateMessageUsage(conversationId, finalUsage);
      }

      // If there are tool calls, execute them in parallel
      if (collectedToolCalls.length > 0) {
        // Update the assistant message with tool calls
        useChatStore.setState((state) => {
          const msg = state.conversations[conversationId]?.messages.find(
            (m) => m.id === assistantMsgId
          );
          if (msg) {
            msg.toolCalls = collectedToolCalls;
            msg.isStreaming = false;
          }
        });

        // Execute tools in parallel using Promise.allSettled
        chatStore.setAgentStatus('tool-calling', `${collectedToolCalls.length} tools`);

        // Expose loop context for delegate_to_agent tool
        const confirmCb = options?.commandConfirmCallback ?? requestCommandConfirmation;
        const filePermCb = options?.filePermissionCallback ?? requestFilePermission;
        currentLoopContext = {
          commandConfirmCallback: confirmCb,
          filePermissionCallback: filePermCb,
          signal: abortController.signal,
          eventRouter,
          loopId,
          conversationId,
          toolCallToStepId,
        };

        let completedCount = 0;
        const totalCount = collectedToolCalls.length;

        type ToolExecResult = { id: string; result: string; resultContent: ToolResultContent[] | undefined; error: boolean; duration: number };

        const executeSingleTool = async (tc: typeof collectedToolCalls[number]): Promise<ToolExecResult> => {
          // Check if cancelled before executing
          if (abortController.signal.aborted) {
            return { id: tc.id, result: '[已取消]', resultContent: undefined, error: false, duration: 0 };
          }

          // Emit preToolCall hook (can block or modify input)
          const preEvent = await emitHook({
            type: 'preToolCall' as const,
            timestamp: Date.now(),
            conversationId,
            toolName: tc.name,
            toolInput: tc.input,
          } as PreToolCallEvent);

          if (preEvent.blocked) {
            return { id: tc.id, result: '[被 hook 拦截]', resultContent: undefined, error: false, duration: 0 };
          }

          const effectiveInput = preEvent.modifiedInput ?? tc.input;

          // Enforce allowed-tools input constraints (e.g., run_command(npm *))
          const validator = inputValidators.get(tc.name);
          if (validator && !validator(effectiveInput)) {
            return { id: tc.id, result: `此操作被技能的 allowed-tools 限制拦截：工具 ${tc.name} 的输入不符合约束条件`, resultContent: undefined, error: true, duration: 0 };
          }

          const startTime = Date.now();
          try {
            // Race tool execution against abort signal so stop button works during long-running tools (e.g. MCP)
            const rawResult: ToolResult = await new Promise<ToolResult>((resolve, reject) => {
              if (abortController.signal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
              }
              let settled = false;
              const onAbort = () => {
                if (!settled) {
                  settled = true;
                  reject(new DOMException('Aborted', 'AbortError'));
                }
              };
              abortController.signal.addEventListener('abort', onAbort, { once: true });
              executeAnyTool(tc.name, effectiveInput, confirmCb, filePermCb, toolContext)
                .then((result) => {
                  if (!settled) {
                    settled = true;
                    abortController.signal.removeEventListener('abort', onAbort);
                    resolve(result);
                  }
                })
                .catch((err) => {
                  if (!settled) {
                    settled = true;
                    abortController.signal.removeEventListener('abort', onAbort);
                    reject(err);
                  }
                });
            });
            const durationMs = Date.now() - startTime;
            completedCount++;
            if (totalCount > 1) {
              chatStore.setAgentStatus('tool-calling', `${completedCount}/${totalCount}: ${tc.name}`);
            }
            // Extract string for display/hooks; keep rich content for LLM
            const resultStr = toolResultToString(rawResult);
            const resultContent: ToolResultContent[] | undefined =
              typeof rawResult !== 'string' ? rawResult : undefined;
            // Emit postToolCall hook
            await emitHook({
              type: 'postToolCall',
              timestamp: Date.now(),
              conversationId,
              toolName: tc.name,
              toolInput: effectiveInput,
              result: resultStr,
              error: false,
              durationMs,
            });
            return { id: tc.id, result: resultStr, resultContent, error: false, duration: durationMs / 1000 };
          } catch (err) {
            // Re-throw AbortError so outer catch handles cancellation properly
            if (err instanceof Error && err.name === 'AbortError') {
              throw err;
            }
            const durationMs = Date.now() - startTime;
            completedCount++;
            if (totalCount > 1) {
              chatStore.setAgentStatus('tool-calling', `${completedCount}/${totalCount}: ${tc.name}`);
            }
            const errorMsg = err instanceof Error ? err.message : String(err);
            // Emit postToolCall hook for errors too
            await emitHook({
              type: 'postToolCall',
              timestamp: Date.now(),
              conversationId,
              toolName: tc.name,
              toolInput: effectiveInput,
              result: `Error: ${errorMsg}`,
              error: true,
              durationMs,
            });
            return { id: tc.id, result: `Error: ${errorMsg}`, resultContent: undefined, error: true, duration: durationMs / 1000 };
          }
        };

        // If batch contains any computer tool call, execute ALL sequentially
        // (e.g. click → wait → type must run in order, not race each other)
        const hasComputerTool = collectedToolCalls.some(tc => tc.name === 'computer');

        let results: PromiseSettledResult<ToolExecResult>[];
        if (hasComputerTool) {
          // Sequential execution for computer use batches
          // Batch-level window management: hide once before, show once after
          try { await invoke('window_hide'); } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 200));
          setComputerUseBatchMode(true);

          const sequentialResults: PromiseSettledResult<ToolExecResult>[] = [];
          try {
            for (let i = 0; i < collectedToolCalls.length; i++) {
              const tc = collectedToolCalls[i];
              // Only auto-screenshot on the last computer tool in the batch
              const hasMoreComputerTools = collectedToolCalls.slice(i + 1).some(t => t.name === 'computer');
              setSkipAutoScreenshot(tc.name === 'computer' && hasMoreComputerTools);
              try {
                const value = await executeSingleTool(tc);
                sequentialResults.push({ status: 'fulfilled', value });
              } catch (err) {
                sequentialResults.push({ status: 'rejected', reason: err });
              }
            }
          } finally {
            setSkipAutoScreenshot(false);
            setComputerUseBatchMode(false);
            try { await invoke('window_show'); } catch { /* ignore */ }
          }
          results = sequentialResults;
        } else {
          // run_command may have implicit dependencies (e.g. npm install → npm build), serialize them
          const allRunCommand = collectedToolCalls.every(tc => tc.name === 'run_command');
          if (allRunCommand) {
            const sequentialResults: PromiseSettledResult<ToolExecResult>[] = [];
            for (const tc of collectedToolCalls) {
              if (abortController.signal.aborted) break;
              try {
                const value = await executeSingleTool(tc);
                sequentialResults.push({ status: 'fulfilled', value });
              } catch (err) {
                sequentialResults.push({ status: 'rejected', reason: err });
              }
            }
            results = sequentialResults;
          } else {
            // Parallel execution for non-command batches
            const toolPromises = collectedToolCalls.map(tc => executeSingleTool(tc));
            results = await Promise.allSettled(toolPromises);
          }
        }

        // Update tool call results via EventRouter (use index to match rejected results)
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') {
            const { id, result: toolResult, resultContent, error } = result.value;
            // Determine hideScreenshot for computer tool
            let hideScreenshot: boolean | undefined;
            const matchedTc = collectedToolCalls[i];
            if (matchedTc?.name === 'computer') {
              const showUser = matchedTc.input.show_user;
              const action = matchedTc.input.action as string;
              if (typeof showUser === 'boolean') {
                hideScreenshot = !showUser;
              } else {
                hideScreenshot = action !== 'screenshot';
              }
            }
            chatStore.updateToolCall(conversationId, assistantMsgId, id, toolResult, resultContent, error, hideScreenshot);

            // Update TaskExecutionStore via EventRouter
            const stepId = toolCallToStepId.get(id);
            if (stepId) {
              if (error) {
                eventRouter.route({ type: 'step-error', loopId, stepId, error: toolResult });
              } else {
                eventRouter.route({ type: 'step-end', loopId, stepId, result: toolResult, resultContent });
              }

              // Update linked planned step status and auto-advance to next
              const execState = useTaskExecutionStore.getState().executions[execution.id];
              if (execState) {
                const linkedPlanned = execState.plannedSteps.find(s => s.linkedStepId === stepId);
                if (linkedPlanned) {
                  useTaskExecutionStore.getState().updatePlannedStepStatus(
                    execution.id,
                    linkedPlanned.index,
                    error ? 'error' : 'completed'
                  );
                  // Auto-advance: link the next pending planned step to the next
                  // tool call's execution step (using collectedToolCalls index for reliability)
                  const nextPending = useTaskExecutionStore.getState().executions[execution.id]
                    ?.plannedSteps.find(s => s.status === 'pending');
                  if (nextPending) {
                    for (let j = i + 1; j < collectedToolCalls.length; j++) {
                      const nextStepId = toolCallToStepId.get(collectedToolCalls[j].id);
                      if (nextStepId) {
                        useTaskExecutionStore.getState().linkPlannedStep(execution.id, nextPending.index, nextStepId);
                        useTaskExecutionStore.getState().updatePlannedStepStatus(execution.id, nextPending.index, 'running');
                        break;
                      }
                    }
                  }
                }
              }
            }
          } else {
            // Use index to find the corresponding tool call
            const tc = collectedToolCalls[i];
            if (tc) {
              chatStore.updateToolCall(conversationId, assistantMsgId, tc.id, `Error: ${result.reason}`, undefined, true);

              // Update TaskExecutionStore via EventRouter
              const stepId = toolCallToStepId.get(tc.id);
              if (stepId) {
                eventRouter.route({ type: 'step-error', loopId, stepId, error: String(result.reason) });

                // Update linked planned step status
                const execState = useTaskExecutionStore.getState().executions[execution.id];
                if (execState) {
                  const linkedPlanned = execState.plannedSteps.find(s => s.linkedStepId === stepId);
                  if (linkedPlanned) {
                    useTaskExecutionStore.getState().updatePlannedStepStatus(
                      execution.id,
                      linkedPlanned.index,
                      'error'
                    );
                  }
                }
              }
            }
          }
        });

        // Clear loop context after tool execution
        currentLoopContext = null;

        // Detect tool changes (e.g. install_mcp_server) and inject notification
        const mcpChanged = continueLoop && collectedToolCalls.some(tc =>
          tc.name === 'install_mcp_server' || tc.name === 'uninstall_mcp_server'
        );
        if (mcpChanged) {
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

      if (!continueLoop) {
        chatStore.finishStreaming(conversationId);
        chatStore.clearAbortController(conversationId);
        // Complete the TaskExecution
        eventRouter.route({ type: 'done', loopId, reason: 'end_turn' });
        persistExecutionSnapshot(conversationId, loopId);
        // Emit agentEnd hook
        await emitHook({
          type: 'agentEnd',
          timestamp: Date.now(),
          conversationId,
          agentName: route.name ?? 'abu',
          loopId,
          reason: 'end_turn',
        });
        // Auto-deactivate skills after loop completes (single-turn lifecycle)
        deactivateAllSkills(conversationId);
        // Mark conversation as completed and send notification
        chatStore.setConversationStatus(conversationId, 'completed');
        const convTitle = useChatStore.getState().conversations[conversationId]?.title ?? '任务';
        notifyTaskCompleted(convTitle);
      }
    } catch (err) {
      // Handle abort errors gracefully
      if (err instanceof Error && (err.name === 'AbortError' || abortController.signal.aborted)) {
        // Clear loop context and any pending confirmation/permission dialogs
        currentLoopContext = null;
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
        // Set status back to idle on cancel
        chatStore.setConversationStatus(conversationId, 'idle');
        continueLoop = false;
        return;
      }

      currentLoopContext = null;
      const errorMessage = err instanceof Error ? err.message : String(err);
      chatStore.appendToLastMessage(
        conversationId,
        `\n\n**Error:** ${errorMessage}`
      );
      chatStore.finishStreaming(conversationId);
      chatStore.clearAbortController(conversationId);
      // Error the TaskExecution
      eventRouter.route({ type: 'error', loopId, error: errorMessage });
      persistExecutionSnapshot(conversationId, loopId);
      // Auto-deactivate skills on error
      deactivateAllSkills(conversationId);
      // Mark conversation as error and send notification
      chatStore.setConversationStatus(conversationId, 'error');
      const convTitle = useChatStore.getState().conversations[conversationId]?.title ?? '任务';
      notifyTaskError(convTitle);
      continueLoop = false;
    }
  }
}
