import { writeTextFile } from '@tauri-apps/plugin-fs';
import type { ToolDefinition, Conversation, SubagentDefinition } from '../../../types';
import { skillLoader } from '../../skill/loader';
import { agentRegistry } from '../../agent/registry';
import { getCurrentLoopContext, getLoopContext, requestWorkspace } from '../../agent/permissionBridge';
import { runSubagentLoop, extractParentConversationSummary } from '../../agent/subagentLoop';
import type { SubagentProgressEvent } from '../../agent/subagentLoop';
import { createSubagentController } from '../../agent/subagentAbort';
import { useChatStore } from '../../../stores/chatStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useDiscoveryStore } from '../../../stores/discoveryStore';
import { joinPath, ensureParentDir } from '../../../utils/pathUtils';
import { ITEM_NAME_RE } from '../../../utils/validation';
import { getSystemInfoData } from '../helpers/toolHelpers';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';

// Module-level map to track skill hook cleanup functions.
// Key format: "conversationId:skillName" for per-conversation scoping.
const skillHookCleanups = new Map<string, () => void>();

/** Clear all active skill hooks (called on agent loop end) */
export function clearAllSkillHooks(): void {
  for (const cleanup of skillHookCleanups.values()) {
    cleanup();
  }
  skillHookCleanups.clear();
}

/** Clear skill hooks for a specific conversation only */
export function clearSkillHooksByConversation(conversationId: string): void {
  const prefix = `${conversationId}:`;
  for (const [key, cleanup] of skillHookCleanups) {
    if (key.startsWith(prefix)) {
      cleanup();
      skillHookCleanups.delete(key);
    }
  }
}

/**
 * use_skill tool - allows Claude to load and use a skill when it determines it's relevant
 * This mimics Claude Code's behavior where Claude decides when to use skills
 */
export const useSkillTool: ToolDefinition = {
  name: TOOL_NAMES.USE_SKILL,
  description: 'Load a skill to assist with the current task. The skill instructions are injected into the system prompt for this turn (automatically released when the task ends). Use when the user request matches a skill\'s TRIGGER condition. Returns a load confirmation.',
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

    // Auto-enable skill if disabled — user intent to use it takes precedence
    const { disabledSkills, toggleSkillEnabled } = useSettingsStore.getState();
    if (disabledSkills?.includes(skillName)) {
      toggleSkillEnabled(skillName);
    }

    const skill = skillLoader.getSkill(skillName);
    if (!skill) {
      const available = skillLoader.getAvailableSkills().map(s => s.name).join(', ');
      return `Error: Skill "${skillName}" not found. Available skills: ${available}`;
    }

    // Dedup: if already active in this conversation, short-circuit to prevent
    // wasted tool calls. Skill instructions are already in the system prompt.
    const state = useChatStore.getState();
    const activeId = state.activeConversationId;
    if (activeId) {
      const existing = state.conversations[activeId]?.activeSkills;
      if (existing?.includes(skillName)) {
        const t = getI18n().toolResult.agent;
        return format(t.skillAlreadyActive, { skillName });
      }
    }

    // Store the skill activation and arguments — the agentLoop will pick this up
    // and inject it into the system prompt via orchestrator

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
      // Store cleanup keyed by conversation:skill for per-conversation scoping
      const hookKey = activeId ? `${activeId}:${skillName}` : skillName;
      skillHookCleanups.set(hookKey, cleanup);
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

    const t = getI18n().toolResult.agent;
    let result = format(t.skillLoaded, { name: skill.name, description: skill.description });
    if (context) {
      result += format(t.skillContextLine, { context });
    }
    result += t.skillInjected;
    return result;
  },
  isConcurrencySafe: false,
};

// System preset agent definitions — used by delegate_to_agent type parameter
// These are internal roles, not visible to users in the toolbox
const PRESET_AGENTS: Record<string, { description: string; systemPrompt: string; tools: string[] }> = {
  research: {
    description: 'Information search and research',
    systemPrompt: 'You are a professional research assistant. Focus on searching, reading, and analyzing information, and output structured research results.',
    tools: [TOOL_NAMES.READ_FILE, TOOL_NAMES.LIST_DIRECTORY, TOOL_NAMES.FIND_FILES, TOOL_NAMES.SEARCH_FILES, TOOL_NAMES.WEB_SEARCH, TOOL_NAMES.HTTP_FETCH],
  },
  writer: {
    description: 'Content creation and document writing',
    systemPrompt: 'You are a professional writing assistant. Skilled at writing documents, reports, emails, and other text content.',
    tools: [TOOL_NAMES.READ_FILE, TOOL_NAMES.WRITE_FILE, TOOL_NAMES.EDIT_FILE, TOOL_NAMES.LIST_DIRECTORY, TOOL_NAMES.FIND_FILES, TOOL_NAMES.SEARCH_FILES, TOOL_NAMES.WEB_SEARCH],
  },
  executor: {
    description: 'Executing complex operational tasks',
    systemPrompt: 'You are an efficient execution assistant. Able to use various tools to complete file operations, command execution, and other tasks.',
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
  name: TOOL_NAMES.DELEGATE_TO_AGENT,
  description: 'Delegate a task to a single agent (synchronously waits for the result). Can specify agent_name (user-defined agent) or type (built-in role: research/writer/executor). When parallel processing of multiple independent sub-tasks is needed, use run_agent_batch instead (more reliable).',
  inputSchema: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'User-defined agent name (mutually exclusive with type)' },
      type: { type: 'string', description: 'Built-in role: research (read-only research), writer (read/write content creation), executor (all-purpose execution). Mutually exclusive with agent_name', enum: ['research', 'writer', 'executor'] },
      task: { type: 'string', description: 'Task description to delegate' },
      context: { type: 'string', description: 'Additional context (optional)' },
    },
    required: ['task'],
  },
  execute: async (input, toolExecContext) => {
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
        const t = getI18n().toolResult.agent;
        return format(t.errAgentNotFound, { agentName, available: available || getI18n().toolResult.valueNone, presetList });
      }

      // Check if disabled
      const { disabledAgents } = useSettingsStore.getState();
      if (disabledAgents.includes(agentName)) {
        const t = getI18n().toolResult.agent;
        return format(t.errAgentDisabled, { agentName });
      }
    } else {
      return getI18n().toolResult.agent.errMustSpecifyAgent;
    }

    const effectiveAgentName = agent.name;

    // 3. Get parent loop context (prefer loopId from ToolExecutionContext for multi-agent support)
    const loopCtx = toolExecContext?.loopId
      ? getLoopContext(toolExecContext.loopId)
      : getCurrentLoopContext();

    // 4. Set agent status indicator
    useChatStore.getState().setAgentStatus('tool-calling', TOOL_NAMES.DELEGATE_TO_AGENT, effectiveAgentName);

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

    // 8. Sync mode: blocking await
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
      return result.text;
    } catch (err) {
      subagentCleanup();
      useChatStore.getState().removeActiveAgent(effectiveAgentName);
      throw err;
    }
  },
  isConcurrencySafe: false,
};

/**
 * read_skill_file tool — reads supporting files from a skill's directory
 */
export const readSkillFileTool: ToolDefinition = {
  name: TOOL_NAMES.READ_SKILL_FILE,
  description: 'Read supporting files (reference documents, templates, examples, etc.) from an activated skill\'s directory. Use when the skill\'s SKILL.md references supporting files.',
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
  isConcurrencySafe: false,
};

// --- save_skill / save_agent: bypass pathSafety for ~/.abu/ writes ---

function createSaveItemTool(kind: 'skill' | 'agent'): ToolDefinition {
  const isSkill = kind === 'skill';
  const folder = isSkill ? 'skills' : 'agents';
  const fileName = isSkill ? 'SKILL.md' : 'AGENT.md';

  return {
    name: isSkill ? TOOL_NAMES.SAVE_SKILL : TOOL_NAMES.SAVE_AGENT,
    description: `Save a custom ${kind} file to ~/.abu/${folder}/{name}/${fileName}. Use when the user asks to create or modify a ${kind}. Only provide the name and content — the path is computed automatically. Optionally pass a files array to also save supporting files such as scripts and reference documents.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `${kind} name (lowercase, hyphens allowed, e.g. "${isSkill ? 'git-commit' : 'doc-writer'}")` },
        content: { type: 'string', description: `Full ${fileName} content including YAML frontmatter` },
        files: {
          type: 'array',
          description: 'Optional supporting files (scripts, references, assets) to save alongside the main file.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative path within the skill/agent dir, e.g. "scripts/render.mjs" or "references/api-docs.md"' },
              content: { type: 'string', description: 'File text content' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['name', 'content'],
    },
    execute: async (input) => {
      const name = (input.name as string).trim();
      const content = input.content as string;
      const t = getI18n().toolResult.agent;
      const label = isSkill ? t.labelSkill : t.labelAgent;

      if (!ITEM_NAME_RE.test(name)) {
        return format(t.errInvalidName, { label, name });
      }

      const info = await getSystemInfoData();
      const itemDir = joinPath(info.home, '.abu', folder, name);
      const filePath = joinPath(itemDir, fileName);

      await ensureParentDir(filePath);
      await writeTextFile(filePath, content);

      // Write supporting files if provided
      const files = input.files as Array<{ path: string; content: string }> | undefined;
      const writtenFiles: string[] = [];

      if (files?.length) {
        for (const file of files) {
          const p = file.path;
          if (p.includes('..') || p.startsWith('/') || p.startsWith('\\')) {
            return format(t.errUnsafeFilePath, { p });
          }
          const targetPath = joinPath(itemDir, p);
          await ensureParentDir(targetPath);
          await writeTextFile(targetPath, file.content);
          writtenFiles.push(p);
        }
      }

      // Refresh discovery so the new item appears in UI immediately
      await useDiscoveryStore.getState().refresh();

      const fileList = writtenFiles.length
        ? format(t.savedFileList, { list: writtenFiles.map(f => `  - ${f}`).join('\n') })
        : '';

      if (isSkill) {
        return format(t.skillSaved, { label, name, filePath, fileList });
      }
      return format(t.agentSaved, { label, name, filePath, fileList });
    },
    isConcurrencySafe: false,
  };
}

// save_skill was removed in favor of skill_manage (Module E self-evolution).
// The factory below is retained because save_agent still uses it; once agent
// authoring gets its own workflow, both can be deleted.
export const saveAgentTool = createSaveItemTool('agent');

// Mapping from user-friendly folder hints to system info keys
const FOLDER_HINT_MAP: Record<string, string> = {
  '下载': 'downloads', '下载文件夹': 'downloads', 'downloads': 'downloads',
  '桌面': 'desktop', 'desktop': 'desktop',
  '文档': 'documents', '文档文件夹': 'documents', 'documents': 'documents',
  '主目录': 'home', 'home': 'home',
};

export const requestWorkspaceTool: ToolDefinition = {
  name: TOOL_NAMES.REQUEST_WORKSPACE,
  description: 'Ask the user to select a workspace folder. Call this tool to let the user choose a working directory when their request involves file operations but no workspace is set.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Explain to the user why a workspace selection is needed, e.g. "You want to organize files and need to select a working directory first"',
      },
      folder_hint: {
        type: 'string',
        description: 'Folder name mentioned by the user, e.g. "Downloads"/"下载", "Desktop"/"桌面", "Documents"/"文档". The tool will automatically resolve it to a full path.',
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
    const t = getI18n().toolResult.agent;
    if (result) {
      return format(t.workspaceSelected, { result });
    }
    return t.workspaceCancelled;
  },
  isConcurrencySafe: false,
};
