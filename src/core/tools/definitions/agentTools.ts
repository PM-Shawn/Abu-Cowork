import { writeTextFile } from '@tauri-apps/plugin-fs';
import type { ToolDefinition, Conversation, SubagentDefinition } from '../../../types';
import { skillLoader } from '../../skill/loader';
import { agentRegistry } from '../../agent/registry';
import { getCurrentLoopContext, requestWorkspace } from '../../agent/agentLoop';
import { runSubagentLoop, extractParentConversationSummary } from '../../agent/subagentLoop';
import type { SubagentProgressEvent } from '../../agent/subagentLoop';
import { createSubagentController } from '../../agent/subagentAbort';
import { useChatStore } from '../../../stores/chatStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useDiscoveryStore } from '../../../stores/discoveryStore';
import { joinPath, ensureParentDir } from '../../../utils/pathUtils';
import { ITEM_NAME_RE } from '../../../utils/validation';
import { getSystemInfoData } from '../helpers/toolHelpers';

// Module-level map to track skill hook cleanup functions.
// Exported for cleanup on conversation delete/switch.
const skillHookCleanups = new Map<string, () => void>();

/** Clear all active skill hooks (called on conversation delete/switch) */
export function clearAllSkillHooks(): void {
  for (const cleanup of skillHookCleanups.values()) {
    cleanup();
  }
  skillHookCleanups.clear();
}

/**
 * use_skill tool - allows Claude to load and use a skill when it determines it's relevant
 * This mimics Claude Code's behavior where Claude decides when to use skills
 */
export const useSkillTool: ToolDefinition = {
  name: 'use_skill',
  description: '加载技能来辅助当前任务。技能指令会注入本轮系统提示（任务结束后自动释放）。当用户请求匹配某个技能的 TRIGGER 条件时使用。返回加载确认。',
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: {
        type: 'string',
        description: 'The name of the skill to use (e.g., "explain-code", "write-tests")'
      },
      context: {
        type: 'string',
        description: 'Additional context or arguments to pass to the skill'
      },
    },
    required: ['skill_name'],
  },
  execute: async (input) => {
    const skillName = (input.skill_name as string).replace(/^\/+/, '');
    const context = input.context as string | undefined;

    // Check if skill is disabled by user
    const { disabledSkills } = useSettingsStore.getState();
    if (disabledSkills?.includes(skillName)) {
      return `Error: 技能 "${skillName}" 已被用户禁用。请直接使用工具完成任务，不要调用此技能。`;
    }

    const skill = skillLoader.getSkill(skillName);
    if (!skill) {
      const available = skillLoader.getAvailableSkills().map(s => s.name).join(', ');
      return `Error: Skill "${skillName}" not found. Available skills: ${available}`;
    }

    // Store the skill activation and arguments — the agentLoop will pick this up
    // and inject it into the system prompt via orchestrator

    const state = useChatStore.getState();
    const activeId = state.activeConversationId;
    if (activeId) {
      useChatStore.setState((draft: { conversations: Record<string, Conversation> }) => {
        const conv = draft.conversations[activeId];
        if (conv) {
          if (!conv.activeSkills) conv.activeSkills = [];
          if (!conv.activeSkills.includes(skillName)) {
            conv.activeSkills.push(skillName);
          }
          // Store arguments for variable substitution
          if (context) {
            if (!conv.activeSkillArgs) conv.activeSkillArgs = {};
            conv.activeSkillArgs[skillName] = context;
          }
        }
      });
    }

    // Activate skill-scoped hooks
    if (skill.hooks) {
      const { activateSkillHooks } = await import('../../skill/skillHooks');
      const cleanup = activateSkillHooks(skill);
      // Store cleanup on the module-level map for deactivation
      skillHookCleanups.set(skillName, cleanup);
    }

    // Also load chain skills if defined
    if (skill.chain) {
      for (const chainedName of skill.chain) {
        const chainedSkill = skillLoader.getSkill(chainedName);
        if (chainedSkill && activeId) {
          useChatStore.setState((draft: { conversations: Record<string, Conversation> }) => {
            const conv = draft.conversations[activeId];
            if (conv) {
              if (!conv.activeSkills) conv.activeSkills = [];
              if (!conv.activeSkills.includes(chainedName)) {
                conv.activeSkills.push(chainedName);
              }
            }
          });
        }
      }
    }

    let result = `已加载技能 "${skill.name}": ${skill.description}`;
    if (context) {
      result += `\n用户上下文: ${context}`;
    }
    result += '\n技能指令已注入本轮系统提示，任务结束后自动释放。';
    return result;
  },
};

// System preset agent definitions — used by delegate_to_agent type parameter
// These are internal roles, not visible to users in the toolbox
const PRESET_AGENTS: Record<string, { description: string; systemPrompt: string; tools: string[] }> = {
  research: {
    description: '信息搜索和调研',
    systemPrompt: '你是一个专业的调研助手。专注于搜索、阅读和分析信息，输出结构化的调研结果。',
    tools: ['read_file', 'list_directory', 'find_files', 'search_files', 'web_search', 'http_fetch'],
  },
  writer: {
    description: '内容创作和文档撰写',
    systemPrompt: '你是一个专业的写作助手。擅长撰写文档、报告、邮件等各类文字内容。',
    tools: ['read_file', 'write_file', 'edit_file', 'list_directory', 'find_files', 'search_files', 'web_search'],
  },
  executor: {
    description: '执行复杂操作任务',
    systemPrompt: '你是一个高效的执行助手。能够使用各种工具完成文件操作、命令执行等任务。',
    tools: [], // Empty = all tools allowed (except delegate_to_agent which is always blocked)
  },
};

function buildPresetAgent(type: string, _task: string): SubagentDefinition {
  const preset = PRESET_AGENTS[type];
  return {
    name: `preset-${type}`,
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    filePath: '__preset__',
    tools: preset.tools.length > 0 ? preset.tools : undefined,
    maxTurns: type === 'research' ? 15 : 20,
  };
}

export const delegateToAgentTool: ToolDefinition = {
  name: 'delegate_to_agent',
  description: '将任务委派给代理独立执行。可指定 agent_name（用户自定义代理）或 type（系统内置角色：research 调研/writer 写作/executor 执行）。',
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: '用户自定义代理名称（与 type 二选一）' },
      type: { type: 'string', description: '系统内置角色：research（只读调研）、writer（读写创作）、executor（全能执行）。与 agent_name 二选一', enum: ['research', 'writer', 'executor'] },
      task: { type: 'string', description: '委派的任务描述' },
      context: { type: 'string', description: '附加上下文（可选）' },
    },
    required: ['task'],
  },
  execute: async (input) => {
    const agentName = input.agent_name as string | undefined;
    const agentType = input.type as string | undefined;
    const task = input.task as string;
    const context = input.context as string | undefined;

    // 1. Resolve agent: by name (user-defined) or by type (system preset)
    let agent: SubagentDefinition | undefined;

    if (agentType && PRESET_AGENTS[agentType]) {
      // System preset role
      agent = buildPresetAgent(agentType, task);
    } else if (agentName) {
      // User-defined agent
      agent = agentRegistry.getAgent(agentName);
      if (!agent) {
        const available = agentRegistry.getAvailableAgents()
          .filter((a) => a.name !== 'abu')
          .map((a) => `${a.name} (${a.description})`)
          .join(', ');
        const presetList = Object.keys(PRESET_AGENTS).join(', ');
        return `Error: 代理 "${agentName}" 未找到。可用代理: ${available || '无'}。也可使用系统角色 type: ${presetList}`;
      }

      // Check if disabled
      const { disabledAgents } = useSettingsStore.getState();
      if (disabledAgents.includes(agentName)) {
        return `Error: 代理 "${agentName}" 已被停用。`;
      }
    } else {
      return 'Error: 必须指定 agent_name（用户代理）或 type（系统角色：research/writer/executor）';
    }

    const effectiveAgentName = agent.name;

    // 3. Get parent loop context
    const loopCtx = getCurrentLoopContext();

    // 4. Set agent status indicator
    useChatStore.getState().setAgentStatus('tool-calling', 'delegate_to_agent', effectiveAgentName);

    // 5. Build onProgress callback for subagent visualization
    let onProgress: ((event: SubagentProgressEvent) => void) | undefined;

    if (loopCtx) {
      // Find the parent delegate step ID from toolCallToStepId
      // The tool call ID for this execution should be the last entry mapped
      let parentStepId: string | undefined;
      for (const [, sId] of loopCtx.toolCallToStepId) {
        parentStepId = sId; // Will end up as last entry
      }
      // More precise: find step with toolName=delegate_to_agent and status=running
      if (!parentStepId) {
        const exec = loopCtx.eventRouter.getCurrentStepId(loopCtx.loopId);
        if (exec) parentStepId = exec;
      }

      if (parentStepId) {
        const childIdMap = new Map<string, string>(); // subagent toolCallId -> childStepId
        const capturedParentStepId = parentStepId;

        onProgress = (event) => {
          if (event.type === 'tool-start') {
            const childStepId = loopCtx.eventRouter.addChildStepToDelegate(
              loopCtx.loopId,
              capturedParentStepId,
              { toolName: event.toolName, toolInput: event.toolInput }
            );
            if (childStepId) {
              childIdMap.set(event.id, childStepId);
            }
          } else if (event.type === 'tool-end') {
            const childStepId = childIdMap.get(event.id);
            if (childStepId) {
              loopCtx.eventRouter.completeChildStep(
                loopCtx.loopId,
                capturedParentStepId,
                childStepId,
                event.result,
                event.error
              );
            }
          }
        };
      }
    }

    // 6. Extract parent conversation summary for context injection
    let parentConversationSummary: string | undefined;
    try {
      const chatState = useChatStore.getState();
      const activeConvId = chatState.activeConversationId;
      if (activeConvId) {
        const messages = chatState.conversations[activeConvId]?.messages ?? [];
        parentConversationSummary = extractParentConversationSummary(messages);
      }
    } catch {
      // Non-critical: proceed without parent context
    }

    // 7. Create per-subagent AbortController (linked to parent)
    const { signal: subagentSignal, cleanup: subagentCleanup } = createSubagentController(
      effectiveAgentName,
      loopCtx?.signal
    );

    // 8. Execute subagent
    try {
      const result = await runSubagentLoop({
        agent,
        task,
        context,
        parentConversationSummary,
        signal: subagentSignal,
        commandConfirmCallback: loopCtx?.commandConfirmCallback,
        filePermissionCallback: loopCtx?.filePermissionCallback,
        onProgress,
      });

      // Clear this agent from tracking and cleanup
      subagentCleanup();
      useChatStore.getState().removeActiveAgent(effectiveAgentName);
      return result;
    } catch (err) {
      subagentCleanup();
      useChatStore.getState().removeActiveAgent(effectiveAgentName);
      throw err;
    }
  },
};

/**
 * read_skill_file tool — reads supporting files from a skill's directory
 */
export const readSkillFileTool: ToolDefinition = {
  name: 'read_skill_file',
  description: '读取已激活技能目录中的辅助文件（参考文档、模板、示例等）。当技能的 SKILL.md 中引用了支持文件时使用。',
  inputSchema: {
    type: 'object',
    properties: {
      skill_name: { type: 'string', description: 'Name of the skill' },
      path: { type: 'string', description: 'Relative path within the skill directory, e.g. "reference.md" or "examples/api.md"' },
    },
    required: ['skill_name', 'path'],
  },
  execute: async (input) => {
    const skillName = input.skill_name as string;
    const relativePath = input.path as string;

    // Security: reject path traversal
    if (relativePath.includes('..')) {
      return 'Error: Path must not contain ".." (path traversal not allowed).';
    }

    const content = await skillLoader.loadSupportingFile(skillName, relativePath);
    if (content === null) {
      // Try listing available files to help
      const files = await skillLoader.listSupportingFiles(skillName);
      if (files.length > 0) {
        return `Error: File "${relativePath}" not found in skill "${skillName}".\nAvailable files:\n${files.map(f => `- ${f}`).join('\n')}`;
      }
      return `Error: File "${relativePath}" not found in skill "${skillName}", or skill does not exist.`;
    }

    return content;
  },
};

// --- save_skill / save_agent: bypass pathSafety for ~/.abu/ writes ---

function createSaveItemTool(kind: 'skill' | 'agent'): ToolDefinition {
  const isSkill = kind === 'skill';
  const folder = isSkill ? 'skills' : 'agents';
  const fileName = isSkill ? 'SKILL.md' : 'AGENT.md';
  const label = isSkill ? '技能' : '代理';

  return {
    name: isSkill ? 'save_skill' : 'save_agent',
    description: `保存自定义${label}文件到 ~/.abu/${folder}/{name}/${fileName}。当用户要求创建或修改${label}时使用。只需提供名称和内容，路径自动计算。`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `${kind} name (lowercase, hyphens allowed, e.g. "${isSkill ? 'git-commit' : 'doc-writer'}")` },
        content: { type: 'string', description: `Full ${fileName} content including YAML frontmatter` },
      },
      required: ['name', 'content'],
    },
    execute: async (input) => {
      const name = (input.name as string).trim();
      const content = input.content as string;

      if (!ITEM_NAME_RE.test(name)) {
        return `Error: ${label}名称不合法。仅允许小写字母、数字和连字符，且不能以连字符开头或结尾。收到: "${name}"`;
      }

      const info = await getSystemInfoData();
      const filePath = joinPath(info.home, '.abu', folder, name, fileName);

      await ensureParentDir(filePath);
      await writeTextFile(filePath, content);

      // Refresh discovery so the new item appears in UI immediately
      await useDiscoveryStore.getState().refresh();

      if (isSkill) {
        return `✅ ${label}「${name}」已保存到 ${filePath}\n\n你可以：\n- 到「工具箱 → 技能」查看和编辑\n- 使用 /${name} 调用此技能`;
      }
      return `✅ ${label}「${name}」已保存到 ${filePath}\n\n你可以到「工具箱 → 代理」查看和管理此代理。`;
    },
  };
}

export const saveSkillTool = createSaveItemTool('skill');
export const saveAgentTool = createSaveItemTool('agent');

// Mapping from user-friendly folder hints to system info keys
const FOLDER_HINT_MAP: Record<string, string> = {
  '下载': 'downloads', '下载文件夹': 'downloads', 'downloads': 'downloads',
  '桌面': 'desktop', 'desktop': 'desktop',
  '文档': 'documents', '文档文件夹': 'documents', 'documents': 'documents',
  '主目录': 'home', 'home': 'home',
};

export const requestWorkspaceTool: ToolDefinition = {
  name: 'request_workspace',
  description: '请求用户选择工作区文件夹。当用户的请求涉及文件操作但没有设置工作区时，调用此工具让用户选择工作目录。',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: '向用户解释为什么需要选择工作区，例如"你想整理文件，需要先选择一个工作目录"',
      },
      folder_hint: {
        type: 'string',
        description: '用户提到的文件夹名称，如"下载"、"桌面"、"文档"。工具会自动解析为完整路径',
      },
    },
    required: ['reason'],
  },
  execute: async (input) => {
    const reason = input.reason as string;
    const ctx = getCurrentLoopContext();
    const convId = ctx?.conversationId ?? '';

    // Resolve folder_hint to a full system path
    const hint = (input.folder_hint as string || '').toLowerCase();
    const key = FOLDER_HINT_MAP[hint];
    let suggestedPath: string | undefined;
    if (key) {
      try {
        const sysInfo = await getSystemInfoData();
        suggestedPath = sysInfo[key];
      } catch {
        // Ignore — will open generic folder picker
      }
    }

    const result = await requestWorkspace(reason, convId, suggestedPath);
    if (result) {
      return `用户已选择工作区：${result}`;
    }
    return '用户取消了工作区选择。请告知用户需要先选择工作目录才能进行文件操作。';
  },
};
