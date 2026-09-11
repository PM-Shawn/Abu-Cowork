import { exists, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { readAgentIdentity, wantedAgentIdentity, withAgentIdentity } from '@/core/agent/agentIdentityCarry';
import { isTeamRosterMember } from '../../team/leaderRoute';
import { admitDispatches, recordDispatchOutcome } from '../../team/teamRunBounds';
import { findMissingExpectedFiles, parseExpectedFiles } from '../../team/expectedFiles';
import { createParentStepResolver } from '../../agent/delegateParentStep';
import type { ToolDefinition, Conversation, SubagentDefinition, SkillSource } from '../../../types';
import { skillLoader, parseSkillFile } from '../../skill/loader';
import { agentRegistry, parseAgentFile, getBuiltinAgentNames } from '../../agent/registry';
import { getCurrentLoopContext, getLoopContext, requestWorkspace } from '../../agent/permissionBridge';
import { resolveParentConversationSummary } from '../../agent/parentConversationSummary';
import { getSubagentRunInheritance, runSubagent } from '../../agent/subagentRunner';
import { materializeDelegatedUserTurn } from '../../subagent/delegatedUserTurnMaterializer';
import type { SubagentProgressEvent } from '../../agent/subagentLoop';
import { createSubagentController } from '../../agent/subagentAbort';
import { takeDispatchInstructionReport } from '../../agent/dispatchInstructionReport';
import { useChatStore } from '../../../stores/chatStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { getSettingsReader } from '../../agent/ports/settingsReader';
import { useDiscoveryStore } from '../../../stores/discoveryStore';
import { joinPath, ensureParentDir } from '../../../utils/pathUtils';
import { ITEM_NAME_RE, AGENT_NAME_RE, isItemNameTaken } from '../../../utils/validation';
import { isPluginOwnedAgent } from '../../../utils/agentSource';
import { getSystemInfoData } from '../helpers/toolHelpers';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';

interface SkillHookCleanupEntry {
  cleanup: () => void;
  conversationId?: string;
  loopId?: string;
}

// Hook authority belongs to the run that activated it. Conversation-only
// ownership is insufficient because a force-finalized sidecar run may still
// unwind after a newer run for the same conversation has already started.
const skillHookCleanups = new Set<SkillHookCleanupEntry>();

function clearSkillHooksWhere(predicate: (entry: SkillHookCleanupEntry) => boolean): void {
  for (const entry of skillHookCleanups) {
    if (!predicate(entry)) continue;
    entry.cleanup();
    skillHookCleanups.delete(entry);
  }
}

/** Clear all active skill hooks (called on agent loop end) */
export function clearAllSkillHooks(): void {
  clearSkillHooksWhere(() => true);
}

/** Clear skill hooks for a specific conversation only */
export function clearSkillHooksByConversation(conversationId: string): void {
  clearSkillHooksWhere((entry) => entry.conversationId === conversationId);
}

/** Clear only hooks activated by one exact loop/run owner. */
export function clearSkillHooksByLoop(loopId: string): void {
  clearSkillHooksWhere((entry) => entry.loopId === loopId);
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
  execute: async (input, toolExecContext) => {
    const skillName = (input.skill_name as string).replace(/^\/+/, '');
    const context = input.context as string | undefined;

    const skill = skillLoader.getSkill(skillName);
    if (!skill) {
      const available = skillLoader.getAvailableSkills().map(s => s.name).join(', ');
      return `Error: Skill "${skillName}" not found. Available skills: ${available}`;
    }

    // Auto-enable skill if disabled — only after resolving through the plugin gate
    const { disabledSkills, toggleSkillEnabled } = useSettingsStore.getState();
    if (disabledSkills?.includes(skillName)) {
      toggleSkillEnabled(skillName);
    }

    // Dedup: if already active in this conversation, short-circuit to prevent
    // wasted tool calls. Skill instructions are already in the system prompt.
    const state = useChatStore.getState();
    // Tool execution context owns the activation. A scheduled/IM/sidecar run
    // may execute while an unrelated desktop tab is active; borrowing the
    // global activeConversationId would attach its skill state and hooks to the
    // wrong conversation. Keep the fallback only for legacy callers that pass
    // no context at all.
    const contextConversationId = toolExecContext?.conversationId;
    const activeId = contextConversationId && state.conversations[contextConversationId]
      ? contextConversationId
      : (toolExecContext === undefined ? state.activeConversationId : undefined);
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
      const cleanup = activateSkillHooks(skill, toolExecContext);
      skillHookCleanups.add({
        cleanup,
        conversationId: activeId ?? undefined,
        loopId: toolExecContext?.loopId,
      });
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
    tools: [], // Empty = all tools allowed except nested delegation and user prompts.
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
      type: { type: 'string', description: 'Built-in role with a fixed tool boundary: research (lookup-focused: file reads, search, web and general HTTP requests), writer (content authoring: read/write/edit files plus web search), executor (full toolset — includes browser, image and MCP tools, except nested delegation and user prompts). Mutually exclusive with agent_name', enum: ['research', 'writer', 'executor'] },
      task: { type: 'string', description: 'Task description to delegate' },
      context: { type: 'string', description: 'Additional context (optional)' },
      expected_files: { type: 'array', items: { type: 'string' }, description: 'Files this step must produce (absolute, or relative to the workspace). Checked after the agent finishes: a missing file fails the step.' },
    },
    required: ['task'],
  },
  execute: async (input, toolExecContext) => {
    const agentName = input.agent_name as string | undefined;
    const agentType = input.type as string | undefined;
    const task = input.task as string;
    const context = input.context as string | undefined;
    const expectedFiles = parseExpectedFiles(input.expected_files);

    // 1. Resolve agent: by name (user-defined) or by type (system preset)
    let agent: SubagentDefinition | undefined;

    // In-conversation team mode: only roster members may be dispatched (presets included).
    if (toolExecContext?.teamRoster && !isTeamRosterMember(toolExecContext.teamRoster, agentName)) {
      const t = getI18n().toolResult.agent;
      return format(t.errNotTeamMember, { agentName: agentName ?? (agentType ? `type:${agentType}` : getI18n().toolResult.valueNone), roster: toolExecContext.teamRoster.join(', ') });
    }
    // Hard bounds for the run (teamRunBounds.ts): refuse loudly so the leader
    // stops dispatching and reports instead of looping.
    const boundsLoopId = toolExecContext?.teamRoster && agentName && toolExecContext.loopId ? toolExecContext.loopId : undefined;
    if (boundsLoopId && agentName) {
      const admission = admitDispatches(boundsLoopId, [agentName]);
      if (!admission.ok) {
        const t = getI18n().toolResult.agent;
        return admission.reason === 'run_cap'
          ? format(t.errDispatchCapReached, { max: admission.max })
          : format(t.errMemberBlocked, { agentName: admission.member, n: admission.failures });
      }
    }
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
      const { disabledAgents } = getSettingsReader().getSnapshot();
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
    const materializerLoopCtx = toolExecContext?.conversationId !== undefined
      && toolExecContext.loopId !== undefined
      ? getLoopContext(toolExecContext.loopId)
      : undefined;
    const ownerConversationId = toolExecContext?.conversationId ?? loopCtx?.conversationId;

    // 4. Set agent status indicator
    if (ownerConversationId) {
      useChatStore.getState().setAgentStatus(ownerConversationId, 'tool-calling', TOOL_NAMES.DELEGATE_TO_AGENT, effectiveAgentName);
    }

    // 5. Build onProgress callback for subagent visualization
    let onProgress: ((event: SubagentProgressEvent) => void) | undefined;

    if (loopCtx?.eventRouter && typeof loopCtx.eventRouter.addChildStepToDelegate === 'function') {
      // Parent step resolved lazily, by this call's tool_use id — see
      // delegateParentStep.ts (eager lookup lost the member process when the
      // leader loop ran in the sidecar).
      const resolveParentStepId = createParentStepResolver(loopCtx, toolExecContext?.toolCallId);
      const childIdMap = new Map<string, string>(); // subagent toolCallId -> childStepId

      onProgress = (event) => {
        const parentStepId = resolveParentStepId();
        if (!parentStepId) return;
        if (event.type === 'tool-start') {
          const childStepId = loopCtx.eventRouter.addChildStepToDelegate(
            loopCtx.loopId,
            parentStepId,
            { toolName: event.toolName, toolInput: event.toolInput, toolCallId: event.id }
          );
          if (childStepId) {
            childIdMap.set(event.id, childStepId);
          }
        } else if (event.type === 'tool-end') {
          const childStepId = childIdMap.get(event.id);
          childIdMap.delete(event.id);
          if (childStepId) {
            loopCtx.eventRouter.completeChildStep(
              loopCtx.loopId,
              parentStepId,
              childStepId,
              event.result,
              event.error,
              event.resultContent
            );
          }
        }
      };
    }

    // 6. Extract parent conversation summary for context injection
    const parentConversationSummary = resolveParentConversationSummary(toolExecContext);

    // 7. Create per-subagent AbortController (linked to parent)
    const dispatchKey = toolExecContext?.toolCallId ? `${toolExecContext.toolCallId}:0` : undefined;
    const { signal: subagentSignal, cleanup: subagentCleanup } = createSubagentController(
      effectiveAgentName,
      loopCtx?.signal,
      dispatchKey,
    );

    // 8. Sync mode: blocking await
    let outcomeRecorded = false;
    try {
      // A model tool call may describe its task, but it never chooses the
      // source message. The active shell loop owns both ids. Refuse to
      // delegate when the tool context cannot be proved to refer to it.
      if (!materializerLoopCtx
        || toolExecContext?.conversationId !== materializerLoopCtx.conversationId
        || toolExecContext.loopId !== materializerLoopCtx.loopId) {
        throw new Error('Cannot delegate user turn: missing or mismatched trusted loop context');
      }
      const delegatedUserTurn = await materializeDelegatedUserTurn({
        conversationId: materializerLoopCtx.conversationId,
        loopId: materializerLoopCtx.loopId,
        signal: subagentSignal,
      });
      const result = await runSubagent({
        agent,
        task,
        context,
        parentConversationSummary,
        delegatedUserTurn,
        parentLoopId: delegatedUserTurn.origin.loopId,
        parentConversationId: delegatedUserTurn.origin.conversationId,
        parentUserMessageId: delegatedUserTurn.origin.messageId,
        signal: subagentSignal,
        commandConfirmCallback: loopCtx?.commandConfirmCallback,
        filePermissionCallback: loopCtx?.filePermissionCallback,
        allowedTools: loopCtx?.allowedTools,
        blockedTools: loopCtx?.blockedTools,
        imContext: loopCtx?.imContext,
        persistParentToolImages: true,
        ...(dispatchKey ? { dispatchKey } : {}),
        ...getSubagentRunInheritance(loopCtx, toolExecContext?.authorizationScopeId, toolExecContext?.workspacePath),
        onProgress,
      });

      // Clear this agent from tracking and cleanup
      subagentCleanup();
      if (ownerConversationId) {
        useChatStore.getState().removeActiveAgent(ownerConversationId, effectiveAgentName);
      }
      // Define-done check: declared artifacts must exist, whatever the text says.
      const missingFiles = expectedFiles.length > 0
        ? await findMissingExpectedFiles(expectedFiles, toolExecContext?.workspacePath)
        : [];
      toolExecContext?.reportMetadata?.({ subagentStopReason: missingFiles.length > 0 ? 'error' : result.stopReason });
      if (boundsLoopId && agentName) {
        recordDispatchOutcome(boundsLoopId, agentName, result.stopReason === 'completed' && missingFiles.length === 0);
        outcomeRecorded = true;
      }
      if (missingFiles.length > 0) {
        throw new Error(format(getI18n().toolResult.agent.errExpectedFilesMissing, {
          agentName: effectiveAgentName,
          files: missingFiles.join(', '),
          text: result.text,
        }));
      }
      let text = result.text;
      // The stop reason must survive the hand-off in the BODY, not only in
      // `reportMetadata`: OpenAI-compatible providers carry no `is_error`
      // channel, so a metadata-only signal reaches Claude and nobody else —
      // and the leader then reads a truncated answer as a finished one.
      if (result.stopReason !== 'completed') {
        const labels = getI18n().toolResult.agent.stopReasonLabel;
        text += `\n\n${format(getI18n().toolResult.agent.delegateStoppedNote, { reason: labels[result.stopReason] })}`;
      }
      // No tool call at all = nothing the member could have checked; flag it for the leader.
      if (result.toolCallCount === 0 && toolExecContext?.teamRoster) {
        text += `\n\n${getI18n().toolResult.agent.delegateNoToolCallsNote}`;
      }
      // The user spoke to this member mid-run: say so structurally, with the
      // verbatim instructions, so the leader treats them as the user's.
      const instructionReport = takeDispatchInstructionReport(dispatchKey, effectiveAgentName);
      if (instructionReport) text += `\n\n${instructionReport}`;
      return text;
    } catch (err) {
      subagentCleanup();
      if (boundsLoopId && agentName && !outcomeRecorded) recordDispatchOutcome(boundsLoopId, agentName, false);
      if (ownerConversationId) {
        useChatStore.getState().removeActiveAgent(ownerConversationId, effectiveAgentName);
      }
      const instructionReport = takeDispatchInstructionReport(dispatchKey, effectiveAgentName);
      if (instructionReport) {
        const error = new Error(`${err instanceof Error ? err.message : String(err)}\n\n${instructionReport}`, { cause: err });
        if (err instanceof Error) error.name = err.name;
        throw error;
      }
      throw err;
    }
  },
  // true (not the fail-closed default): before toolExecutor.ts's scheduler
  // consumed isConcurrencySafe, EVERY multi-call batch ran fully in parallel
  // unconditionally — so a turn that fanned out several delegate_to_agent
  // calls to independent sub-agents already ran them concurrently. Each call
  // spawns its OWN subagent run with its own AbortController/conversation
  // context (createSubagentController above) — concurrent calls don't share
  // mutable state the way write_file/run_command do, so there's no new
  // correctness risk. Leaving this at the fail-closed default would silently
  // serialize multi-agent fan-out, a flagship-path product behavior change
  // this batch never intended to make.
  isConcurrencySafe: true,
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

/**
 * The AGENT.md to write for the model's `content`, or null when nothing may be
 * written.
 *
 * The model writes the whole file, but the agent's identity is not its to
 * change: overwriting an existing agent keeps that file's role-id / created
 * stamp, a new agent is stamped now and never gets an invented role-id.
 *
 * Fail closed with the registry's own reader: the result must load through
 * `parseAgentFile` with exactly that identity. `withAgentIdentity` edits the
 * YAML syntax tree, while the registry reads the resolved JS object — alias
 * or merge keys, directives, or content the registry cannot load at all make
 * the two disagree, and such a file is refused rather than written.
 */
function agentMdWithIdentity(
  filePath: string,
  existingRaw: string | null,
  content: string,
): { md: string; name: string } | null {
  const existing = existingRaw === null ? null : readAgentIdentity(existingRaw);
  const now = Date.now();
  const md = withAgentIdentity(content, existing, now);
  const wanted = wantedAgentIdentity(existing, now);
  const readBack = parseAgentFile(md, filePath);
  if (!readBack || readBack.roleId !== wanted.roleId || readBack.createdAt !== wanted.createdAt) return null;
  return { md, name: readBack.name };
}

/**
 * Skill sources a user skill must never take the name of: the loader scans
 * `~/.abu/skills` before them, so a user SKILL.md under that name would hide
 * the builtin / plugin / enterprise skill everywhere it is referenced.
 */
const RESERVED_SKILL_SOURCES: ReadonlySet<SkillSource | undefined> = new Set<SkillSource>(['builtin', 'plugin', 'enterprise']);

/**
 * Names the registry already resolves, split into `reserved` (never the user's
 * to write: built-in, plugin-provided including disabled plugins, managed) and
 * `listed` (every name it resolves, the user's own included).
 */
function registeredItemNames(isSkill: boolean): { reserved: string[]; listed: string[] } {
  if (isSkill) {
    const skills = skillLoader.getAvailableSkills({ includeDrafts: true, includeDisabledPlugins: true });
    return {
      reserved: skills.filter((s) => RESERVED_SKILL_SOURCES.has(s.source)).map((s) => s.name),
      listed: skills.map((s) => s.name),
    };
  }
  // Builtins come from the static list, not the registry: they must be refused
  // even before discovery ran. The registry prefers a local file over a
  // builtin (`registerBuiltins` then `scanDirectory`, same map key), so a user
  // `abu/AGENT.md` would replace the default assistant.
  const agents = agentRegistry.getAvailableAgents({ includeDisabledPlugins: true });
  return {
    reserved: [
      ...getBuiltinAgentNames(),
      ...agents.filter((a) => isPluginOwnedAgent(a) || a.managed !== undefined).map((a) => a.name),
    ],
    listed: agents.map((a) => a.name),
  };
}

async function folderNames(dir: string): Promise<string[]> {
  try {
    return (await readDir(dir)).filter((entry) => entry.isDirectory).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * May `name` be written to `filePath` (`<itemsDir>/<name>/<manifest>`)?
 *
 * - `in-use`: a built-in / plugin item owns the name, another item's name
 *   differs from it only in letter case (the same folder on macOS / Windows),
 *   or the registry resolves it to an item that does not live at `filePath`
 *   (project-level, …) — writing would replace or hide that item. Refused
 *   whatever `overwrite` says.
 * - `exists`: the manifest is already there and the caller did not say
 *   `overwrite` — creating must never silently replace an existing item.
 *
 * On success, `existingRaw` is the manifest being replaced (null for a new
 * item), read once here so the identity carry needs no second read.
 */
async function checkSaveTarget(
  isSkill: boolean,
  name: string,
  itemsDir: string,
  filePath: string,
  overwrite: boolean,
): Promise<{ refused: 'in-use' | 'exists' } | { refused: null; existingRaw: string | null }> {
  const { reserved, listed } = registeredItemNames(isSkill);
  if (isItemNameTaken(name, null, reserved)) return { refused: 'in-use' };
  if (isItemNameTaken(name, name, [...listed, ...(await folderNames(itemsDir))])) return { refused: 'in-use' };

  if (!(await exists(filePath))) {
    return listed.includes(name) ? { refused: 'in-use' } : { refused: null, existingRaw: null };
  }
  const existingRaw = await readTextFile(filePath);
  // A plugin's AGENT.md the registry has not listed (yet): still the plugin's.
  const existingAgent = isSkill ? null : parseAgentFile(existingRaw, filePath);
  if (existingAgent && isPluginOwnedAgent(existingAgent)) return { refused: 'in-use' };
  return overwrite ? { refused: null, existingRaw } : { refused: 'exists' };
}

/**
 * Exported for tests. Only the agent variant is registered (`saveAgentTool`
 * below); `save_skill` was replaced by `skill_manage`.
 */
export function createSaveItemTool(kind: 'skill' | 'agent'): ToolDefinition {
  const isSkill = kind === 'skill';
  const folder = isSkill ? 'skills' : 'agents';
  const fileName = isSkill ? 'SKILL.md' : 'AGENT.md';

  return {
    name: isSkill ? TOOL_NAMES.SAVE_SKILL : TOOL_NAMES.SAVE_AGENT,
    description: `Save a custom ${kind} file to ~/.abu/${folder}/{name}/${fileName}. Use when the user asks to create or modify a ${kind}. Only provide the name and content — the path is computed automatically; the name in the content's frontmatter must equal name. A name used by a built-in or plugin ${kind}, or by another ${kind} whose name differs only in letter case, is refused. If a ${kind} with this name already exists, nothing is written unless overwrite is true: pass overwrite: true only when the user asked to change that existing ${kind}; when creating a new one, choose another name instead. Optionally pass a files array to also save supporting files such as scripts and reference documents.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: `${kind} name (lowercase, hyphens allowed, e.g. "${isSkill ? 'git-commit' : 'doc-writer'}")` },
        content: { type: 'string', description: `Full ${fileName} content including YAML frontmatter` },
        overwrite: {
          type: 'boolean',
          description: `Replace the existing ${kind} with this name. Only when the user asked to modify that ${kind}; omit when creating a new one.`,
        },
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

      // Agents allow unicode names (数据分析师); skills keep the strict slug.
      const nameRe = isSkill ? ITEM_NAME_RE : AGENT_NAME_RE;
      if (!nameRe.test(name)) {
        return format(t.errInvalidName, { label, name });
      }

      const info = await getSystemInfoData();
      const itemsDir = joinPath(info.home, '.abu', folder);
      const itemDir = joinPath(itemsDir, name);
      const filePath = joinPath(itemDir, fileName);

      const target = await checkSaveTarget(isSkill, name, itemsDir, filePath, input.overwrite === true);
      if (target.refused !== null) {
        return format(target.refused === 'in-use' ? t.errNameInUse : t.errItemExists, { label, name });
      }

      let mainContent = content;
      let manifestName: string | undefined;
      if (isSkill) {
        manifestName = parseSkillFile(content, filePath)?.name;
      } else {
        const agent = agentMdWithIdentity(filePath, target.existingRaw, content);
        if (agent === null) return format(t.errAgentFrontmatterInvalid, { name });
        mainContent = agent.md;
        manifestName = agent.name;
      }
      // The registry keys an item by its frontmatter name, not its folder: a
      // mismatch would file it under a name this call never checked.
      if (manifestName !== name) {
        return format(t.errManifestNameMismatch, { label, name, found: manifestName ?? '', fileName });
      }

      await ensureParentDir(filePath);
      await writeTextFile(filePath, mainContent);

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
