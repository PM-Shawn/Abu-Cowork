import type { StreamEvent, ToolCall, TokenUsage, ImageAttachment, MessageContent, ToolExecutionContext } from '../../types';
import type { LLMAdapter } from '../llm/adapter';
import { LLMError, formatLlmDisplayError } from '../llm/adapter';
import { recordProviderCallOutcome, isConfigFailureCode } from '../llm/providerCallHealth';
import { selectChatAdapter } from '../llm/selectChatAdapter';
import { getToolInvoker, type ToolInvoker, type FilePermissionCallback } from './ports/toolInvoker';
import type { ConfirmationInfo } from '../tools/commandSafety';
import type { ToolDefinition } from '../../types';
import { getActiveApiKey, getActiveProvider, providerRequiresApiKey } from '../../utils/settingsSelectors';
import { resolveEntryModel } from './resolveEntryModel';
import { getSettingsReader, type SettingsReader } from './ports/settingsReader';
import { getChatDelta } from './ports/chatDelta';
import { getConversationReader } from './ports/conversationReader';
import { getWorkspaceReader } from './ports/workspaceReader';
import { getCapsPort } from './ports/capsPort';
import { getExecutionPort } from './ports/executionPort';
import { getAbortRegistry } from './ports/abortRegistry';
import { getScratchpadPort } from './ports/scratchpadPort';
import { createEventRouter } from './eventRouter';
// Type-only import — the runtime routeInput/buildSystemPromptSections calls
// moved to entryOrchestration.ts (P1-3B-3A item 1, dynamically imported from
// runAgentLoop's fallback branch only). agentLoop.ts must never take a
// runtime dependency on orchestrator.ts (see entryOrchestration.ts's doc
// comment / design doc §2 "雷 1") — a type-only import erases at build time,
// so this line carries zero runtime edge into the orchestrator graph.
import type { RouteResult, IMContext } from './orchestrator';
import type { PromptSection } from '../llm/promptSections';
import { sectionsToString, mergeSections } from '../llm/promptSections';
import { skillLoader } from '../skill/loader';
import { substituteVariables } from '../skill/preprocessor';
import { joinPath } from '../../utils/pathUtils';
import { matchesToolName, parseToolPatterns } from '../skill/toolFilter';
import { notifyTaskCompleted, notifyTaskError } from '../../utils/notifications';
import {
  ContextBudgetError,
  enforceContextBudget,
  trimOldScreenshots,
} from '../context/contextManager';
import { compressContextIfNeeded, summarizeConversation } from '../context/contextCompressor';
import {
  buildContextFromBoundary,
  computeCompactionPlan,
  createCompactBoundaryMarker,
} from '../context/compactBoundary';
import { applyMicroCompaction } from '../context/microCompactor';
import { AutoCompactTracker, getUsagePercent } from '../context/autoCompact';
import { estimateToolSchemaTokens, estimateTokens, estimateMessageTokens, calibrateFromUsage, setActiveModel } from '../context/tokenEstimator';
import { identifyRounds, RECENT_ROUNDS_TO_KEEP } from '../context/contextUtils';
import { withRetry } from './retry';
import { extractParentConversationSummary } from './subagentLoop';
import { runSubagent } from './subagentRunner';
import type { SubagentProgressEvent } from './subagentLoop';
import { createSubagentController } from './subagentAbort';
import {
  allToolsUnparseable,
  MAX_NO_PROGRESS_TURNS,
  resolveMaxTurns,
  escalateMaxOutputTokens,
  shouldContinueTruncatedToolCalls,
  detectSemanticToolLoop,
  minimizeToolLoopObservation,
  SEMANTIC_TOOL_LOOP_WINDOW,
  type SemanticToolLoopReason,
  type ToolLoopObservation,
} from './loopGuards';
import { drainQueuedInputs, clearInputQueue, enqueueUserInput } from './userInputQueue';
import { snapshotExecutionSteps } from './executionSnapshot';
import { emitHook } from './lifecycleHooks';
import { getI18n, format } from '../../i18n';
import { clearAllSkillHooks } from '../tools/builtins';
import { executeToolBatch } from './toolExecutor';
import { startConversationTrace, endConversationTrace, startGeneration } from '../observability/langfuse';
import { calculateTurnCost } from '../llm/costTracker';
import { formatPlannedStepsForPrompt } from './plannedStepsPrompt';
import { getBuiltinSearchConfig } from '../capabilities';
import { resolveAgentModelCapabilities, resolveCapabilities, resolveEffectiveContextWindow, computeReasoningParams, type ModelCapabilities } from '../llm/modelCapabilities';
import { applyDeclaredCapabilities } from '../llm/applyDeclaredCapabilities';
import { resolveModelDeclared } from '../llm/resolveModelDeclared';
import { rehydrateForSend, type ImageBase64Cache } from '../llm/imageRehydration';
import { TOOL_NAMES, isDisplayHiddenStepBackedTool } from '../tools/toolNames';
import { prefetchTools } from '../tools/toolPrefetch';
import {
  classifyTools,
  buildDeferredToolsSummary,
  promoteSearchedDeferredTools,
} from '../tools/toolSearch';
import { hasQueuedInputs } from './userInputQueue';
import { resolveEffectiveLlmCreds, EnterpriseLlmUnavailableError } from '../enterprise/llm-resolver';
import { createLogger } from '../logging/logger';
import { reportError } from '@/utils/consoleError';
import {
  hashComputerUseTaskSummary,
  latestUserTaskSummary,
} from '../capabilityPlugins/computerUseResume';

const logger = createLogger('agentLoop');

// Persistent compaction (long-conversation Part A): when the post-compression
// payload is still this fraction of the input budget, land an append-only
// compact-boundary marker so future turns read a compact context from the
// marker (survives restart) instead of re-running the ephemeral 65% pass every
// turn. Higher than the 65% send-only trigger — the ephemeral pass fires first;
// only when it can't bring the payload down does a durable marker land.
const PERSISTENT_COMPACTION_THRESHOLD = 0.85;

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
 * Whether a request error is likely caused by sending image content to a model that
 * does NOT support vision. Gated on the current model's vision capability so that
 * unrelated 400s on a vision-capable model (bad tool schema, oversized payload, …) are
 * NOT mislabeled as "vision unsupported".
 */
export function isVisionUnsupportedError(
  errorCode: string | undefined,
  statusCode: number | undefined,
  hasImages: boolean,
  modelSupportsVision: boolean,
): boolean {
  return errorCode === 'invalid_request' && statusCode === 400 && hasImages && !modelSupportsVision;
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
    if (!outputDir) return images.map(() => undefined); // web / E2E: no disk storage
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

/**
 * Build a user message content (string or multimodal blocks) from raw text + optional images.
 * Persists images to disk so they survive localStorage stripping. Used by both the normal
 * agent loop path and the API-key-missing early-return path so user input is never dropped.
 */
export async function buildUserMessageContent(
  conversationId: string,
  text: string,
  images: ImageAttachment[] | undefined,
): Promise<string | MessageContent[]> {
  if (!images || images.length === 0) return text;
  const savedPaths = await saveUserImagesToDisk(conversationId, images);
  const blocks: MessageContent[] = images.map((img, i) => ({
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: img.mediaType,
      data: img.data,
    },
    filePath: savedPaths[i],
  }));
  if (text) {
    blocks.push({ type: 'text' as const, text });
  }
  return blocks;
}
import {
  clearLoopContext,
  requestCommandConfirmation,
  requestFilePermission,
  drainConfirmationQueue,
  drainFilePermissionQueue,
  drainWorkspaceRequest,
  drainUserQuestions,
} from './permissionBridge';
import { clearPlanMode } from './planMode';
import { drainCapabilitySetupRequests } from '../capabilityPlugins/setupBridge';

/** Persist execution steps onto the last assistant message for the given loop, then evict from memory */
export function persistExecutionSnapshot(conversationId: string, loopId: string): void {
  // NOTE: persistExecutionSnapshot is a standalone top-level function (not
  // nested in runAgentLoop), so it has no access to any cached local —
  // fetches getExecutionPort()/getChatDelta() fresh at each call, same
  // pattern as deactivateAllSkills() (see CHAT-PROBE-REPORT.md §2c).
  const exec = getExecutionPort().getExecutionByLoopId(loopId);
  // Return early only when there is truly nothing to persist.
  if (!exec || (exec.steps.length === 0 && exec.plannedSteps.length === 0)) return;

  // Persist execution steps snapshot if any.
  if (exec.steps.length > 0) {
    getChatDelta().setExecutionStepsSnapshot(conversationId, loopId, snapshotExecutionSteps(exec.steps));
  }
  // Persist planned steps so TaskProgressPanel survives loop eviction. The
  // panel renders an in_progress step statically (no spinner) once the live
  // execution is gone, so a stopped mid-flight step reads as "in progress,
  // paused" rather than a perpetual spinner — no status rewrite needed here.
  if (exec.plannedSteps.length > 0) {
    getChatDelta().setPlannedStepsSnapshot(conversationId, loopId, exec.plannedSteps);
  }
  getExecutionPort().evictExecution(exec.id);
}

/**
 * Abu's default soul — factory personality. Relocated to
 * `./prompts/defaultSoul` to break the agentLoop.ts ↔ orchestrator.ts import
 * cycle (see that module's doc comment). Re-exported here so any existing
 * external callers of `getDefaultSoul` from `agentLoop.ts` keep working.
 */
export { getDefaultSoul } from './prompts/defaultSoul';

export { getCapabilityPrompt } from './prompts/capabilityPrompt';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}



/**
 * Resolve and filter tools for current turn — called per-turn inside the while loop.
 * Supports advanced allowed-tools patterns (wildcards, constraints).
 * Returns { tools, inputValidators } where inputValidators are used at execution time.
 */
export function resolveTools(
  toolInvoker: ToolInvoker,
  route: RouteResult,
  hasBuiltinWebSearch: boolean,
  blockedTools?: string[],
  prefetchContext?: { userInput: string; computerUseEnabled: boolean; activeSkills: import('../../types').Skill[]; turnCount: number },
  allowedTools?: string[],
  conversationId?: string,
): { tools: ToolDefinition[]; deferredTools: ToolDefinition[]; inputValidators: Map<string, (input: Record<string, unknown>) => boolean> } {
  let tools = toolInvoker.getAllTools();
  let inputValidators = new Map<string, (input: Record<string, unknown>) => boolean>();
  let deferredTools: ToolDefinition[] = [];

  // Conditional tool loading: filter to core + prefetched tools
  // Non-core tools become "deferred" — name + description only in system prompt
  if (prefetchContext && !route.skill?.allowedTools && !allowedTools?.length) {
    const additionalToolNames = prefetchTools(prefetchContext);
    const prefetchedSet = new Set(additionalToolNames);
    const classified = classifyTools(tools, prefetchedSet, conversationId);
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
  // Per-run whitelist (for example a custom trigger). This is mirrored by
  // toolExecutor's fail-closed check so the restriction is both model-visible
  // and authoritative at execution time.
  if (allowedTools && allowedTools.length > 0) {
    tools = tools.filter((tool) =>
      allowedTools.some((pattern) => matchesToolName(tool.name, pattern)),
    );
    deferredTools = [];
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
  return `## Currently connected MCP tools\n${lines.join('\n')}`;
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
  const conv = getConversationReader().getConversation(conversationId);
  if (!conv?.activeSkills || conv.activeSkills.length === 0) return;

  getChatDelta().deactivateSkills(conversationId);

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
  /** Tool-name patterns allowed for this run. When present, all other tools
   * fail closed even if a model emits a call that was not advertised. */
  allowedTools?: string[];
  /** Fail instead of staging into an already-running loop. Used by recovery
   * flows whose tool restrictions must apply from the first turn. */
  requireNewRun?: boolean;
  /** IM headless context — injected into system prompt to replace UI-dependent workspace logic */
  imContext?: IMContext;
  /** Settings port — defaults to the in-process Zustand-backed reader. Injection point for
   *  a future out-of-process agent runtime (see SettingsReader docstring). */
  settingsReader?: SettingsReader;
  /** Pre-computed orchestration inputs (route + system prompt sections). Injection point for
   *  the out-of-process runtime: the shell dispatch layer computes these (orchestrator stays
   *  shell-side) and injects; when absent, the loop computes them in-process exactly as before. */
  orchestration?: { route: RouteResult; systemPromptSections: PromptSection[] };
  /**
   * Override the loop's internally-generated `loopId` (normally
   * `generateId()`, see the "Generate a unique loopId" block below).
   * Injection point for the out-of-process runtime (P1-3B-3B): the shell
   * dispatcher mints ONE id, uses it as both the wire `runId` AND this
   * `loopId` (same "keyed by a shell-known id" trick `createExecutionWithId`
   * uses for TaskExecution — see P1-3B-2-REPORT.md §2b) — so the shell's
   * `RunSession.loopId` (used to key `setLoopContext`/`getLoopContext` for
   * `delegate_to_agent`'s parent-step lookup) is known and registered
   * BEFORE the sidecar's loop ever emits a `tool.invoke` carrying this same
   * loopId in its context. Absent in-process (unchanged: a fresh
   * `generateId()` every run).
   */
  loopId?: string;
  /**
   * Shell-owned user message already appended and durably flushed before a
   * sidecar run starts. When present, the loop must consume that message from
   * the conversation snapshot instead of appending a duplicate.
   */
  prePersistedUserMessageId?: string;
  /** Process-local structured diagnostics hook. The shell and sidecar inject
   * their own sinks; it is deliberately omitted from the wire contract. */
  runtimeEvent?: (event: string, attributes: {
    conversationId?: string;
    loopId?: string;
    routeType?: string;
    turnIndex?: number;
    activeToolCount?: number;
    deferredToolCount?: number;
    computerUseExposed?: boolean;
    modelId?: string;
    modelTier?: string;
    capabilitySource?: string;
  }) => void;
}

/** Exit reason returned by runAgentLoop so callers (scheduler, trigger) can
 *  distinguish normal completion from abort / error / a guard stop.
 *  `max_turns` and `no_progress` are "incomplete" terminations: the loop ran but
 *  hit a safety guard instead of finishing — before, both silently reported
 *  `completed`, so headless callers couldn't tell. (`max_tokens` exhaustion stays
 *  under `error`, which already carries a descriptive `error` message.) */
export type AgentLoopExitReason =
  | 'completed'
  | 'aborted'
  | 'error'
  | 'max_turns'
  | 'no_progress'
  /** A trusted tool stopped the loop until the user chooses a recovery path. */
  | 'awaiting_user'
  /** No loop ran: the conversation already had a live loop, so the message was
   *  queued into it (see the concurrency guard at the top of runAgentLoop). */
  | 'enqueued';

/** Terminated by a safety guard rather than finishing the task — the result may
 *  be incomplete. Lets scheduler / trigger surface a meaningful status instead
 *  of treating these as either success or an opaque "Unknown error". */
export function isIncompleteReason(reason: AgentLoopExitReason): boolean {
  return reason === 'max_turns' || reason === 'no_progress' || reason === 'awaiting_user';
}

export interface AgentLoopResult {
  reason: AgentLoopExitReason;
  error?: string;
}

/**
 * Gate for "only run when the user can actually review the result".
 * Memory extraction + post-loop proposal signal both live behind this
 * check — an IM headless session, a scheduled task, or a trigger run
 * all execute without a visible chat, so autonomous writes from those
 * contexts would silently pollute the workspace (drafts/ dir, memdir)
 * with artifacts the user never sees.
 *
 * Pure function, exported for testing. Accepts partial shapes so
 * callers don't need full AgentLoopOptions / Conversation objects.
 */
export function isInteractiveDesktop(
  options: Pick<AgentLoopOptions, 'imContext'> | undefined,
  conversation: { scheduledTaskId?: string; triggerId?: string } | undefined,
): boolean {
  return !options?.imContext && !conversation?.scheduledTaskId && !conversation?.triggerId;
}

/**
 * Should this completed loop produce a post-loop proposal signal?
 *
 * Stricter than `isInteractiveDesktop` — adds a workspace-bound
 * requirement (Task #51). `skill_manage(create)` writes to the
 * workspace-auto dir, so a user without a workspace bound simply
 * can't act on the nudge; worse, the next turn's system prompt would
 * already carry a `workspace-hint` section saying "don't call
 * skill_manage, call request_workspace first" — stacking the proposal
 * signal on top gives the agent contradictory instructions.
 *
 * Memory extraction (the other isInteractiveDesktop consumer) is
 * intentionally NOT gated this way: memdir works without a workspace
 * (global `~/.abu/memory/`), so extraction stays useful even before
 * the user picks a project.
 *
 * Pure function, exported for testing.
 */
export function shouldComputeProposalSignal(
  options: Pick<AgentLoopOptions, 'imContext'> | undefined,
  conversation: { scheduledTaskId?: string; triggerId?: string } | undefined,
  workspacePath: string | null | undefined,
): boolean {
  return isInteractiveDesktop(options, conversation) && !!workspacePath;
}

export async function runAgentLoop(conversationId: string, userMessage: string, options?: AgentLoopOptions): Promise<AgentLoopResult> {
  const settingsReader = options?.settingsReader ?? getSettingsReader();

  // ── Concurrency guard: one live loop per conversation ────────────────────
  // The entry sequence below (clearAbortController → getAbortController)
  // replaces the controller WITHOUT aborting the previous loop, so a second
  // runAgentLoop on a running conversation would race it unstoppably (the UI's
  // isRunning check is React state and can lag a rapid double-send). Route the
  // message into the running loop's input queue instead — same behavior as
  // ChatInput's mid-task path. Only interactive text can be staged because the
  // queue is text-only. Every other request is rejected while the conversation
  // is owned; allowing images or headless callers to fall through would replace
  // the live AbortController and start a second LLM stream.
  {
    const runningConv = getConversationReader().getConversation(conversationId);
    if (runningConv?.status === 'running' && getAbortRegistry().hasAbortController(conversationId)) {
      const interactive = isInteractiveDesktop(options, runningConv);
      const hasImages = Boolean(options?.images?.length);
      const stageable = userMessage.trim().length > 0 && !hasImages;
      if (interactive && stageable) {
        if (options?.requireNewRun) {
          return {
            reason: 'error',
            error: 'A restricted recovery run cannot join an existing agent loop',
          };
        }
        // Codex-style staging: the message lives in the cancellable queue strip
        // above the composer and becomes a transcript bubble only when the
        // running loop drains it (see the drainQueuedInputs block below).
        enqueueUserInput(conversationId, userMessage);
        return { reason: 'enqueued' };
      }
      return {
        reason: 'error',
        error: hasImages
          ? getI18n().chat.attachmentDuringRun
          : getI18n().chat.conversationBusy,
      };
    }
  }

  // New turn starts clean: drop any stale plan-mode lock from a prior/abandoned plan (see planMode.ts).
  clearPlanMode(conversationId);

  // NOTE: the AbortController trio (control channel, deliberately excluded
  // from both ChatDelta and ConversationReader — see B1-REPORT.md) now goes
  // through the AbortRegistry port (P1-3b-pre) instead of a cached
  // `useChatStore.getState()` local — see ports/abortRegistry.ts. All
  // conversation-data reads below go through fresh `getConversationReader()`
  // calls, same as before.
  const abortRegistry = getAbortRegistry();
  const chatDelta = getChatDelta();
  const toolInvoker = getToolInvoker();
  const settings = settingsReader.getSnapshot();
  // `executionPort` now covers BOTH the lifecycle calls (createExecution/
  // cancelExecution below) AND the step-mutation family threaded into
  // `createEventRouter`'s `deps.executionStore` (P1-3b-pre widened
  // ExecutionPort to cover eventRouter.ts's full call surface — see
  // executionPort.ts's "Scope note"). No more separate `taskExecutionStore`
  // local / dual-use split.
  const executionPort = getExecutionPort();

  // ── Per-conversation model pin ──────────────────────────────────────────
  // A conversation runs on its own pinned model (conv.model); a new or legacy
  // conversation inherits the current global activeModel. Both the model name
  // and the provider identity (adapter / baseUrl / apiKey) derive from this one
  // pinned pair via `settingsForModel`, so they can never diverge and a global
  // model switch made for another conversation never bleeds into this in-flight
  // one. Pinned onto the conversation on first run (below) so it also survives
  // later global switches for display + future runs.
  const pinnedConv = getConversationReader().getConversation(conversationId);
  const baseModel =
    pinnedConv?.model ??
    getConversationReader().getIndexEntry(conversationId)?.model ??
    settings.activeModel;
  const settingsForModel: typeof settings =
    baseModel === settings.activeModel ? settings : { ...settings, activeModel: baseModel };

  // Generate a unique loopId for this agent loop - all messages in this loop share it.
  // Shell dispatch (P1-3B-3B) can override via options.loopId — see that
  // field's doc comment above.
  const loopId = options?.loopId ?? generateId();

  // Create EventRouter for this execution
  const eventRouter = createEventRouter({
    executionStore: executionPort,
    appendToolCallContext: (loopId, context) => {
      chatDelta.appendToolCallContext(conversationId, loopId, context);
    },
    addScratchpadEntry: (entry) => {
      getScratchpadPort().addEntry(entry);
    },
  });

  // Enterprise mode bypasses personal key requirement — gateway provides the key.
  const { forceOpenAiCompatible: _startForce } = (() => {
    try { return resolveEffectiveLlmCreds(getActiveApiKey(settingsForModel), undefined) }
    catch { return { forceOpenAiCompatible: false } }
  })()
  const isEnterpriseGatewayMode = _startForce
  if (!isEnterpriseGatewayMode && providerRequiresApiKey(settingsForModel) && !getActiveApiKey(settingsForModel)) {
    // Persist the user's input first so the chat history isn't an orphan warning.
    // Use raw userMessage (orchestrator hasn't run); skill metadata is intentionally omitted —
    // the user needs to configure a key before any skill/agent routing takes effect.
    if (!options?.prePersistedUserMessageId) {
      const userContent = await buildUserMessageContent(conversationId, userMessage, options?.images);
      chatDelta.addMessage(conversationId, {
        id: generateId(),
        role: 'user',
        content: userContent,
        timestamp: Date.now(),
        loopId,
      });
    }
    chatDelta.addMessage(conversationId, {
      id: generateId(),
      role: 'assistant',
      content: getI18n().chat.configureApiKey,
      timestamp: Date.now(),
      loopId,
    });
    return { reason: 'error', error: 'API Key not configured' };
  }

  // Create TaskExecution for this agent loop (after apiKey check to avoid leaking executions)
  const execution = executionPort.createExecution(conversationId, loopId);

  logger.info('Agent loop started', { conversationId, loopId });

  // Get abort controller for this conversation.
  // Force-clear any stale controller first to avoid inheriting aborted state from a previous run.
  abortRegistry.clearAbortController(conversationId);
  const abortController = abortRegistry.getAbortController(conversationId);

  // Set conversation status to running
  chatDelta.setConversationStatus(conversationId, 'running');

  // Route the input through the orchestrator + build the static system
  // prompt sections — unless the shell dispatch layer already pre-computed
  // both (out-of-process runtime injection seam, see
  // AgentLoopOptions.orchestration's doc comment). Zero behavior change when
  // not injected: same routeInput/skill-refresh/buildSystemPromptSections
  // sequence as before, now single-sourced in entryOrchestration.ts (P1-3B-3A
  // item 1) so the shell dispatcher's precomputed path and this in-process
  // fallback can never drift apart. Dynamic import ONLY — agentLoop.ts must
  // never take a static import of entryOrchestration.ts (it drags the full
  // orchestrator graph); see that module's doc comment for the sidecar-bundle
  // reasoning and entryOrchestrationRun.ts's throwing shim.
  const { route, systemPromptSections } = options?.orchestration ?? await (
    await import('./entryOrchestration')
  ).precomputeOrchestration(
    conversationId,
    userMessage,
    options?.imContext,
    { settings, settingsForModel },
    abortController.signal,
  );
  options?.runtimeEvent?.('agent_route_selected', {
    conversationId,
    loopId,
    routeType: route.type,
  });

  // Build tool execution context — provides resolved workspace for tools like update_memory.
  // Priority: IM-injected path > conversation's own stored path > global store fallback.
  // Using the conversation record rather than the global store prevents cross-conversation
  // workspace leakage when multiple conversations are open simultaneously.
  const _convForContext = getConversationReader().getConversation(conversationId);
  // Interactive-desktop conversations with no workspace get a managed default
  // (~/Abu/<name>/) bound here so the agent saves files there instead of
  // improvising (e.g. onto the Desktop). The folder is created lazily on the
  // first write. Headless contexts (IM / scheduled / trigger) are excluded —
  // they must not auto-create workspace directories.
  const toolContext: ToolExecutionContext = {
    workspacePath:
      options?.imContext?.workspacePath ??
      _convForContext?.workspacePath ??
      getWorkspaceReader().getCurrentPath(),
    loopId,
    conversationId,
    interactionMode: isInteractiveDesktop(options, _convForContext)
      ? 'foreground'
      : 'background',
    permissionMode: _convForContext?.permissionMode
      ?? getSettingsReader().getSnapshot().permissionMode,
    abortSignal: abortController.signal,
    taskSummaryHash: await hashComputerUseTaskSummary(
      latestUserTaskSummary(_convForContext?.messages ?? []) ?? userMessage,
    ),
  };
  let computerUseTaskEndPromise: Promise<void> | null = null;
  const endComputerUseTaskLease = (): Promise<void> => {
    if (!computerUseTaskEndPromise) {
      computerUseTaskEndPromise = import('../tools/definitions/computerTools')
        .then(({ endComputerUseTask }) => endComputerUseTask(conversationId, loopId))
        .catch(() => {});
    }
    return computerUseTaskEndPromise;
  };
  const endComputerUseTaskOnAbort = () => {
    void endComputerUseTaskLease();
  };
  abortController.signal.addEventListener('abort', endComputerUseTaskOnAbort, { once: true });

  // Determine effective model — agent can override (with provider compatibility check).
  // P1-3B-3B: the pure formula moved to resolveEntryModel.ts (shared with
  // entryOrchestration.ts's precomputeOrchestration and the shell
  // dispatcher's buildAgentRunParams — single source, see that module's
  // doc); setActiveModel's side effect stays uniquely here.
  const { effectiveModelId, entryModelDeclared } = resolveEntryModel(route, settings, settingsForModel);
  // Set active model for per-model token calibration
  setActiveModel(effectiveModelId);

  // Tell tools whether this model can consume images. read_file uses it to
  // avoid emitting base64 image blocks to text-only models (which bloats
  // context and triggers a 400 on providers that only accept text content).
  toolContext.supportsVision = applyDeclaredCapabilities(
    resolveCapabilities(effectiveModelId),
    entryModelDeclared,
  ).vision;
  const entryProvider = getActiveProvider(settingsForModel);
  const entryAgentCapabilities = resolveAgentModelCapabilities({
    modelId: effectiveModelId,
    providerSource: entryProvider?.source,
    declared: entryModelDeclared,
  });
  toolContext.computerUseTier = entryAgentCapabilities.computerUseTier;
  toolContext.modelCapabilitySource = entryAgentCapabilities.capabilitySource;
  toolContext.modelId = effectiveModelId;

  // `systemPromptSections` (active skills are injected dynamically per-turn)
  // was already resolved above, together with `route`, via
  // entryOrchestration.ts's precomputeOrchestration — see that module's
  // "Reordering note" for why the capability-prompt's `entryModelDeclared`
  // dependency is a deliberate, bounded, pure-formula duplicate rather than
  // threaded through from here.

  // Pin the resolved model to the conversation on first run, so it survives
  // later global model switches (for display + future runs). Pins the
  // user-selected baseModel, NOT effectiveModelId (which may be agent-overridden
  // per-invocation). Skipped in enterprise mode (model selection is gateway-
  // scoped) and when the conversation already carries a pin.
  if (!isEnterpriseGatewayMode && pinnedConv && !pinnedConv.model) {
    chatDelta.setConversationModel(conversationId, {
      providerId: baseModel.providerId,
      modelId: baseModel.modelId,
    });
  }

  // Add user message with loopId (use cleanInput for display)
  // Include skill info if a skill was triggered; build multimodal content if images are attached
  if (!options?.prePersistedUserMessageId) {
    const userContent = await buildUserMessageContent(conversationId, route.cleanInput, options?.images);

    chatDelta.addMessage(conversationId, {
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
  }

  // Enterprise mode always uses OpenAI-compatible adapter (LiteLLM exposes that interface).
  // selectChatAdapter routes through the sidecar transport when it's healthy
  // ('running'), else falls back to the local in-process adapter — the
  // kind-choosing condition itself is unchanged (P1-1).
  const adapter: LLMAdapter = selectChatAdapter(
    isEnterpriseGatewayMode || getActiveProvider(settingsForModel)?.apiFormat === 'openai-compatible'
      ? 'openai-compatible'
      : 'claude',
  );

  // Validate required tools are available (blocking check — one-time at start)
  if (route.type === 'skill' && route.skill?.requiredTools) {
    const initialTools = toolInvoker.getAllTools();
    const availableNames = new Set(initialTools.map(t => t.name));
    const missing = route.skill.requiredTools.filter(t => !availableNames.has(t));
    if (missing.length > 0) {
      chatDelta.addMessage(conversationId, {
        id: generateId(),
        role: 'assistant',
        content: format(getI18n().chat.skillMissingTools, { missing: missing.join(', ') }),
        timestamp: Date.now(),
        loopId,
      });
      chatDelta.setConversationStatus(conversationId, 'idle');
      executionPort.cancelExecution(execution.id);
      return { reason: 'error', error: `Missing required tools: ${missing.join(', ')}` };
    }
  }

  // builtinWebSearch config — refreshed per-turn below (user may change settings mid-conversation)

  // ── Handle @agent direct delegation ──
  if (route.type === 'delegate' && route.delegateAgent) {
    const delegateAgent = route.delegateAgent;
    const taskText = route.cleanInput;

    chatDelta.setAgentStatus('tool-calling', TOOL_NAMES.DELEGATE_TO_AGENT, delegateAgent.name);

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
    const existingMessages = getConversationReader().getConversation(conversationId)?.messages ?? [];
    const parentConversationSummary = extractParentConversationSummary(existingMessages);

    // Create per-subagent AbortController (linked to parent)
    const { signal: subagentSignal, cleanup: subagentCleanup } = createSubagentController(
      delegateAgent.name,
      abortController.signal
    );

    try {
      const result = await runSubagent({
        agent: delegateAgent,
        task: taskText,
        parentConversationSummary: parentConversationSummary || undefined,
        signal: subagentSignal,
        commandConfirmCallback: confirmCb,
        filePermissionCallback: filePermCb,
        onProgress,
        imContext: options?.imContext,
        parentConversationId: conversationId,
      });

      // runSubagentLoop RETURNS a (partial/cancelled) SubagentResult on abort
      // rather than throwing — deliberate for its structured-result contract, but
      // it means the catch block's isUserAbort path never fires for a cancelled
      // delegate run. Re-check the abort signal here so a user Stop during an
      // @agent delegation is reported as {reason:'aborted'}, not a successful
      // completion (schedulers/triggers/isIncompleteReason depend on this).
      if (abortController.signal.aborted) {
        subagentCleanup();
        chatDelta.removeActiveAgent(delegateAgent.name);
        chatDelta.setAgentStatus('idle');
        chatDelta.cancelStreaming(conversationId);
        abortRegistry.clearAbortController(conversationId);
        executionPort.cancelExecution(execution.id);
        chatDelta.setConversationStatus(conversationId, 'idle');
        return { reason: 'aborted' };
      }

      // Complete the delegate step
      subagentCleanup();
      chatDelta.removeActiveAgent(delegateAgent.name);
      if (delegateStepId) {
        eventRouter.route({ type: 'step-end', loopId, stepId: delegateStepId, result: result.text });
      }

      // Add result as assistant message
      const delegateAssistantId = generateId();
      chatDelta.addMessage(conversationId, {
        id: delegateAssistantId,
        role: 'assistant',
        content: result.text,
        timestamp: Date.now(),
        loopId,
      });

      // Pass msgId so finishStreaming uses replaceMessageById (precise) instead
      // of updateLastMessage (blind last-line replace). Without this, the
      // delegate path could race against the appendMessage batch queue and
      // either clobber the user message (when the file already has user line)
      // or duplicate the assistant message (when the user line was still in
      // the queue) — leaving the user bubble missing after reload.
      chatDelta.finishStreaming(conversationId, delegateAssistantId);
      abortRegistry.clearAbortController(conversationId);
      eventRouter.route({ type: 'done', loopId, reason: 'delegate_complete' });
      persistExecutionSnapshot(conversationId, loopId);
      chatDelta.setAgentStatus('idle');
      chatDelta.setConversationStatus(conversationId, 'completed');
      // Delegate run completed without an LLMError → provider is healthy; clears
      // any stale config-failure recorded for it (mirrors the main-loop path).
      recordProviderCallOutcome(getActiveProvider(settingsForModel)?.id, { ok: true, at: Date.now() });

      const convTitle = getConversationReader().getIndexEntry(conversationId)?.title ?? getI18n().chat.notificationTaskFallback;
      notifyTaskCompleted(convTitle, conversationId);
    } catch (err) {
      subagentCleanup();
      chatDelta.removeActiveAgent(delegateAgent.name);
      chatDelta.setAgentStatus('idle');
      // Treat retry-layer cancellation sentinel (LLMError code='cancelled', thrown
      // from retry.ts's abort-aware sleep) as a user abort, not a user-facing error.
      const isUserAbort = err instanceof Error
        && (err.name === 'AbortError'
          || abortController.signal.aborted
          || (err instanceof LLMError && err.code === 'cancelled'));
      if (isUserAbort) {
        chatDelta.cancelStreaming(conversationId);
        abortRegistry.clearAbortController(conversationId);
        executionPort.cancelExecution(execution.id);
        chatDelta.setConversationStatus(conversationId, 'idle');
        return { reason: 'aborted' };
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof LLMError && isConfigFailureCode(err.code)) {
        recordProviderCallOutcome(getActiveProvider(settingsForModel)?.id, { ok: false, code: err.code, at: Date.now() });
      }
      let delegateDisplayError = err instanceof EnterpriseLlmUnavailableError
        ? getI18n().chat.gatewayUnreachable
        : formatLlmDisplayError(err, errorMessage, getI18n().chat.errorEmptyBody);
      if (err instanceof LLMError && err.code === 'not_found') {
        delegateDisplayError += `\n\n${getI18n().chat.errorNotFoundHint}`;
      }
      const delegateErrorId = generateId();
      chatDelta.addMessage(conversationId, {
        id: delegateErrorId,
        role: 'assistant',
        content: `**Error:** ${delegateDisplayError}`,
        timestamp: Date.now(),
        loopId,
      });
      chatDelta.finishStreaming(conversationId, delegateErrorId);
      abortRegistry.clearAbortController(conversationId);
      eventRouter.route({ type: 'error', loopId, error: errorMessage });
      persistExecutionSnapshot(conversationId, loopId);
      chatDelta.setConversationStatus(conversationId, 'error');
      const convTitle = getConversationReader().getIndexEntry(conversationId)?.title ?? getI18n().chat.notificationTaskFallback;
      notifyTaskError(convTitle, conversationId);
      return { reason: 'error', error: errorMessage };
    }
    return { reason: 'completed' };
  }

  // Emit agentStart hook
  await emitHook({
    type: 'agentStart',
    timestamp: Date.now(),
    conversationId,
    agentName: route.name ?? 'abu',
    loopId,
  });

  // Observability: open a trace for this run (no-op when Langfuse disabled)
  startConversationTrace(conversationId, {
    name: route.name ?? 'abu',
    input: userMessage,
    metadata: { loopId, model: effectiveModelId, routeType: route.type },
  });

  let continueLoop = true;
  let exitReason: AgentLoopExitReason = 'completed';
  let exitError: string | undefined;
  let awaitingUserRecovery = false;
  // Cache of filePath → base64 for image rehydration, shared across every turn
  // of this request's tool-use loop so a stripped image is read from disk once,
  // not re-read + re-encoded on every iteration (source.data stays stripped).
  const imageBase64Cache: ImageBase64Cache = new Map();
  // maxTurns priority: skill > agent definition > global setting > sane default
  // (never unlimited — see resolveMaxTurns). Headless runs get a tighter cap.
  const globalMaxTurns = settingsReader.getSnapshot().agentMaxTurns;
  const maxTurns = resolveMaxTurns({
    skillMaxTurns: route.skill?.maxTurns,
    definitionMaxTurns: route.definition?.maxTurns,
    globalMaxTurns,
  });
  let turnCount = 0;
  // No-progress guard (mirrors subagentLoop): abort a model that emits only
  // unparseable tool calls for MAX_NO_PROGRESS_TURNS in a row — without it agentLoop
  // would spin to maxTurns (continueLoop is set on the tool_use branch regardless
  // of parse errors). One bad turn is tolerated so the _parse_error results give
  // the model a chance to recover.
  let consecutiveNoProgress = 0;
  const semanticToolHistory: ToolLoopObservation[] = [];
  const autoCompactTracker = new AutoCompactTracker();
  let maxOutputTokensRecoveryCount = 0;
  const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

  // Phase 2 relevant-memory injection — content of memories most relevant to
  // *this* user message, surfaced as a dynamic system-prompt section. The
  // agent no longer needs to call read_memory for basic recall.
  //
  // Computed ONCE per agent-loop run (per user message) — the user query
  // doesn't change across iterations of the inner while loop, so the
  // selection is stable. Cost: scan is cached, then ≤5 fs reads.
  let relevantMemoriesSection = '';
  try {
    const { findRelevantMemories, formatRelevantMemoriesSection, extractQueryText } =
      await import('../memdir/relevance');
    const queryText = extractQueryText(route.cleanInput);
    if (queryText) {
      const ws = toolContext.workspacePath;
      const relevant = await findRelevantMemories(queryText, ws ?? null);
      relevantMemoriesSection = formatRelevantMemoriesSection(relevant);
    }
  } catch (err) {
    // Non-critical: log and continue without Phase 2 injection
    logger.warn('Phase 2 relevant-memory injection failed', { err });
  }

  while (continueLoop) {
    // Check if cancelled before starting new turn
    if (abortController.signal.aborted) {
      chatDelta.cancelStreaming(conversationId);
      abortRegistry.clearAbortController(conversationId);
      executionPort.cancelExecution(execution.id);
      deactivateAllSkills(conversationId);
      chatDelta.setConversationStatus(conversationId, 'idle');
      // Report the cancellation to callers — without this an abort between turns
      // falls through to the default 'completed', so scheduler/trigger would treat
      // a cancelled run as a success and push its partial output downstream.
      exitReason = 'aborted';
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
        lastMessageId: getConversationReader().getConversation(conversationId)?.messages.slice(-1)[0]?.id ?? '',
        status: 'llm_calling',
        timestamp: Date.now(),
      });
    }).catch(() => {});

    // Check for mid-task user input. Queued messages are staged OUTSIDE the
    // transcript (cancellable strip above the composer) and become chat
    // messages only here, at consumption time — tagged with THIS loop's id so
    // they group with the turn that actually reads them.
    const queuedInputs = drainQueuedInputs(conversationId);
    for (const qi of queuedInputs) {
      chatDelta.addMessage(conversationId, {
        id: generateId(),
        role: 'user',
        content: qi.text,
        timestamp: qi.timestamp,
        loopId,
        ...(qi.isSystem ? { isSystem: true } : {}),
      });
    }

    // Emit turnStart hook
    await emitHook({
      type: 'turnStart',
      timestamp: Date.now(),
      conversationId,
      turnNumber: turnCount,
      maxTurns,
    });

    if (turnCount > maxTurns) {
      const maxTurnsMsgId = generateId();
      chatDelta.addMessage(conversationId, {
        id: maxTurnsMsgId,
        role: 'assistant',
        content: format(getI18n().chat.maxTurnsReached, { n: maxTurns }),
        timestamp: Date.now(),
        loopId,
      });
      chatDelta.finishStreaming(conversationId, maxTurnsMsgId);
      abortRegistry.clearAbortController(conversationId);
      eventRouter.route({ type: 'done', loopId, reason: 'max_turns' });
      persistExecutionSnapshot(conversationId, loopId);
      chatDelta.setConversationStatus(conversationId, 'completed');
      // Hitting the turn cap means every LLM call succeeded (a failed call throws
      // to the catch) → provider is healthy; record it so a prior config-failure
      // is cleared even when the run ends via the cap rather than end_turn.
      recordProviderCallOutcome(getActiveProvider(settingsForModel)?.id, { ok: true, at: Date.now() });
      // C: report the cap to callers (scheduler/trigger) instead of 'completed'.
      exitReason = 'max_turns';
      // Same terminal cleanup as the normal end_turn path — now that the cap is
      // always finite this break is routinely reached, so skipping these would
      // leak an active skill into the next message, leave a phantom crash-recovery
      // checkpoint, and keep the Computer-Use overlay / AX session alive.
      deactivateAllSkills(conversationId);
      import('./computerUseStatus').then(({ setComputerUseActive }) => {
        setComputerUseActive(false);
      }).catch(() => {});
      import('../tools/definitions/computerTools').then(({ closeAxSession }) => {
        closeAxSession(conversationId, loopId).catch(() => {});
      }).catch(() => {});
      import('../session/checkpoint').then(({ clearCheckpoint }) => {
        clearCheckpoint(conversationId);
      }).catch(() => {});
      break;
    }

    // Create a placeholder assistant message for streaming with loopId
    const assistantMsgId = generateId();
    chatDelta.addMessage(conversationId, {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: [],
      loopId,
    });

    chatDelta.setAgentStatus('thinking');

    const collectedToolCalls: ToolCall[] = [];
    const toolCallToStepId: Map<string, string> = new Map();  // Map toolCallId -> stepId
    let collectedThinking = '';
    let finalUsage: TokenUsage | undefined;
    let thinkingEndTime: number | undefined;  // Track when thinking ends
    let lastStopReason = '';
    let modelSupportsVision = false;
    let streamFlushTimer: ReturnType<typeof setInterval> | null = null;

    try {
      // ── Per-turn: refresh tools and dynamic prompt sections ──
      const freshSettings = settingsReader.getSnapshot();
      // Provider identity (id/baseUrl/apiKey/apiFormat) is pinned to the ENTRY
      // snapshot (`settings`), NOT freshSettings: the model name (effectiveModelId),
      // the adapter (chosen once at loop start), and the provider must stay a
      // matched pair for the whole loop. Otherwise switching the global active
      // model mid-loop (e.g. for another conversation) bleeds into this in-flight
      // loop — sending the old model name to the new provider's endpoint
      // ("deepseek endpoint, model mimo-v2.5-pro"). freshSettings below is only
      // for non-identity, mid-loop-tunable knobs (computerUse, maxOutputTokens,
      // contextWindowSize).
      const activeProvider = getActiveProvider(settingsForModel);
      const modelDeclared = resolveModelDeclared(activeProvider, effectiveModelId);
      const builtinWebSearch = activeProvider
        ? getBuiltinSearchConfig(activeProvider.capabilities, true)
        : undefined;
      // When the provider explicitly declared supportsTools=false, suppress tool
      // resolution entirely so the model never sees tool definitions in the system
      // prompt and can't hallucinate tool calls. The adapter-level toolsGate rule
      // also strips tools from the request body as belt-and-suspenders.
      const noTools = modelDeclared?.supportsTools === false;
      // Build prefetch context for conditional tool loading
      const conv = getConversationReader().getConversation(conversationId);
      const activeSkillObjects = (conv?.activeSkills ?? [])
        .map(name => skillLoader.getSkill(name))
        .filter((s): s is NonNullable<typeof s> => s !== undefined);
      const prefetchCtx = {
        userInput: userMessage,
        computerUseEnabled: freshSettings.computerUseEnabled ?? false,
        activeSkills: activeSkillObjects,
        turnCount,
      };
      const { tools: rawTools, deferredTools: rawDeferredTools, inputValidators } = resolveTools(toolInvoker, route, !!builtinWebSearch, options?.blockedTools, prefetchCtx, options?.allowedTools, conversationId);
      const deferredTools = noTools ? [] : rawDeferredTools;
      // tool_search is useful only when the host has an actual deferred catalog.
      // Hiding it when the catalog is empty prevents a weak model from spending
      // turns searching capabilities that are already loaded or policy-blocked.
      const tools = noTools
        ? []
        : deferredTools.length === 0
          ? rawTools.filter(tool => tool.name !== TOOL_NAMES.TOOL_SEARCH)
          : rawTools;
      options?.runtimeEvent?.('agent_tool_exposure', {
        conversationId,
        loopId,
        routeType: route.type,
        turnIndex: turnCount,
        activeToolCount: tools.length,
        deferredToolCount: deferredTools.length,
        computerUseExposed: tools.some((tool) => tool.name === TOOL_NAMES.COMPUTER),
        modelId: effectiveModelId,
        modelTier: toolContext.computerUseTier,
        capabilitySource: toolContext.modelCapabilitySource,
      });
      // Keep the deferred exposure with the trusted execution context rather
      // than module state. The Agent Loop may live in the sidecar while the
      // real tool registry executes in the renderer; this name-only snapshot
      // safely crosses that boundary and is re-filtered by the shell registry.
      toolContext.deferredToolNames = deferredTools.map(tool => tool.name);
      const toolTokens = estimateToolSchemaTokens(tools);
      const dynamicCapabilities = buildDynamicCapabilities(tools);
      const deferredToolsSummary = buildDeferredToolsSummary(deferredTools);
      const activeSkillContent = await loadActiveSkillContent(
        conv?.activeSkills,
        conv?.activeSkillArgs,
        conversationId,
      );

      // Get current messages for this conversation
      const messages = getConversationReader().getConversation(conversationId)?.messages ?? [];
      // Exclude the last empty assistant message we just added
      const historyMessages = messages.slice(0, -1);

      // Resolve model capabilities: registry baseline, then overlay any
      // runtime-discovered limits (e.g. from a previous max_tokens-too-large
      // 400 response). Discovered values come from real API errors so they
      // override the registry — but they don't override the *user's* setting,
      // since the user may have a smaller budget on purpose.
      let modelCaps = resolveCapabilities(effectiveModelId);
      // Override auto-detected caps with user-declared values (custom/local providers only).
      // No-op when activeProvider has no declaredCapabilities (builtin providers).
      modelCaps = applyDeclaredCapabilities(modelCaps, modelDeclared);
      modelSupportsVision = modelCaps.vision;
      const discoveredCaps = activeProvider
        ? getCapsPort().get(activeProvider.id, effectiveModelId)
        : undefined;
      const effectiveModelMaxOutput = discoveredCaps?.maxOutputTokens ?? modelCaps.maxOutputTokens;
      const effectiveModelContext = discoveredCaps?.contextWindow ?? modelCaps.contextWindow;
      // True output ceiling (distinct from the conservative request budget in
      // maxOutputTokens). max_tokens-recovery escalation may climb toward this.
      const effectiveModelCeiling = discoveredCaps?.maxOutputTokens ?? modelCaps.outputCeiling ?? modelCaps.maxOutputTokens;

      // Resolve budget + reasoning-control params. Overlay runtime-discovered
      // limits onto the static caps, then let computeReasoningParams reserve a
      // content floor for reasoning models so reasoning can't starve the answer
      // (empty reply + finish_reason=length). Non-reasoning models are clamped to
      // the model's real ceiling to avoid a guaranteed 400.
      const effectiveCaps: ModelCapabilities = {
        ...modelCaps,
        maxOutputTokens: effectiveModelMaxOutput,
        contextWindow: effectiveModelContext,
        // A model observed reasoning despite the registry saying otherwise → can't
        // bound it; treat as uncontrollable so it gets the full budget + reactive net.
        // Exception: if the user explicitly declared supportsReasoning=false for this
        // provider, respect that declaration and never flip thinking back on.
        ...(discoveredCaps?.isReasoningModel && modelCaps.thinking === false
            && modelDeclared?.supportsReasoning !== false
          ? { thinking: 'uncontrollable' as const }
          : {}),
      };
      const reasoningParams = computeReasoningParams(
        effectiveCaps,
        modelDeclared?.maxOutputTokens ?? freshSettings.maxOutputTokens ?? effectiveModelMaxOutput,
      );
      let maxOutputTokens = reasoningParams.maxTokens;
      // Effective context window = min(model published cap, user setting, runtime-discovered).
      // This prevents the UI/agent from claiming more capacity than the model actually
      // supports — e.g. mimo/gpt-4o/kimi at 128k were silently being reported as 200k
      // because the project default settingsStore.contextWindowSize is 200k.
      const contextWindowSize = resolveEffectiveContextWindow(
        effectiveModelId,
        modelDeclared?.maxInputTokens ?? freshSettings.contextWindowSize,
        discoveredCaps?.contextWindow,
      );

      // Escalate maxOutputTokens on max_tokens recovery (legacy CC pattern),
      // clamped to the model's true output ceiling so we never re-ask above a known limit.
      const escalation = escalateMaxOutputTokens(maxOutputTokens, contextWindowSize, maxOutputTokensRecoveryCount);
      if (escalation.changed) {
        const escalated = Math.min(escalation.maxOutputTokens, effectiveModelCeiling);
        if (escalated > maxOutputTokens) {
          logger.info('Escalating maxOutputTokens', { from: maxOutputTokens, to: escalated });
          maxOutputTokens = escalated;
        }
      }

      // Build effective system prompt: static cached sections + dynamic per-turn sections
      const todoState = formatPlannedStepsForPrompt(conversationId);
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
      if (relevantMemoriesSection) {
        dynamicSections.push({ name: 'relevant-memories', text: relevantMemoriesSection, cacheable: false });
      }
      let allSections = mergeSections([...systemPromptSections, ...dynamicSections]);
      // String form for token estimation and context management
      let effectiveSystemPrompt = sectionsToString(allSections);

      const maxInputTokens = contextWindowSize - maxOutputTokens;

      // Step 1: Semantic compression — use cached summary or auto-compact based on warning level
      // Compression triggers when: enough turns AND (cached result available OR warning level triggers compaction)
      let messagesForContext = historyMessages;
      let compressionApplied = false;
      // Long-conversation Part A: honour a persistent compact-boundary marker if
      // one exists. buildContextFromBoundary returns the compact view (firstRound
      // + summary + recent, markers stripped) when the LAST marker is present,
      // else the SAME array reference. A marker takes over → skip the ephemeral
      // 65% cache path below; otherwise fall through to the existing send-only
      // compression. The marker itself is NEVER sent to the LLM.
      const boundaryView = buildContextFromBoundary(historyMessages);
      if (boundaryView !== historyMessages) {
        messagesForContext = boundaryView;
        compressionApplied = true;
      } else if (turnCount >= 3) {
        const convForCache = getConversationReader().getConversation(conversationId);
        const cache = convForCache?.contextCache;

        if (cache && cache.messageCountAtCompression <= historyMessages.length) {
          // Reuse cached compression: firstRound + summary + messages after summarized range
          const rounds = identifyRounds(historyMessages);
          const firstRound = rounds[0] ?? [];
          const newMessages = historyMessages.slice(cache.summarizedRange[1]);
          messagesForContext = [...firstRound, cache.summaryMessage, ...newMessages];
          compressionApplied = true;
        } else if (!autoCompactTracker.isDisabled()) {
          // No valid cache AND the auto-compact circuit breaker is not tripped —
          // attempt compression. When the breaker IS tripped (repeated provider
          // failures/timeouts), skip the LLM call entirely; the deterministic
          // context budget gate below still guarantees the request
          // fits, so a doomed provider can't re-stall every turn.
          chatDelta.setIsCompressing(conversationId, true);
          try {
            const compressionCreds = resolveEffectiveLlmCreds(
              getActiveApiKey(settingsForModel),
              getActiveProvider(settingsForModel)?.baseUrl || undefined,
            )
            const compressionResult = await compressContextIfNeeded(
              historyMessages,
              effectiveSystemPrompt,
              contextWindowSize,
              maxOutputTokens,
              {
                adapter,
                model: effectiveModelId,
                apiKey: compressionCreds.apiKey,
                baseUrl: compressionCreds.baseUrl,
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
                chatDelta.setContextCache(conversationId, {
                  summaryMessage: summaryMsg,
                  summarizedRange: [rounds[0].length, endIdx],
                  messageCountAtCompression: historyMessages.length,
                });
              }
            } else if (compressionResult.failed) {
              // Summarization timed out or errored (returned gracefully, not
              // thrown) — record against the circuit breaker so repeated failures
              // trip it and stop re-attempting the doomed LLM call every turn.
              autoCompactTracker.recordFailure(compressionResult.failureCode);
            }
          } catch {
            // Defensive: compressContextIfNeeded no longer throws, but keep the
            // circuit-breaker record in case an unexpected error escapes.
            autoCompactTracker.recordFailure();
          } finally {
            chatDelta.setIsCompressing(conversationId, false);
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
          // LLM-facing system-prompt hint (never rendered to the user), so it is
          // written in English like the other prompts — not localized. The reply
          // language is still governed by the response-language section.
          text: '\n[The earlier conversation history has been compressed and older details summarized. If the user mentions early details you are unsure about, say so honestly and ask them to confirm — do not fabricate.]',
          cacheable: false,
        };
        allSections = mergeSections([...allSections, compressionHint]);
        effectiveSystemPrompt = sectionsToString(allSections);
      }

      // Step 2: Trim old screenshots dynamically based on context usage
      const postCompressionTokens = estimateTokens(effectiveSystemPrompt) + estimateMessageTokens(messagesForContext) + toolTokens;
      const usagePercent = getUsagePercent(postCompressionTokens, maxInputTokens);
      // NOTE: usage MUST be published on post-compression tokens. Pre-compression
      // tokens stay critically high in long conversations even after cache-hit
      // compression brings the actual payload below the threshold, which
      // previously left the UI stuck in the red Critical state.
      // Update tracker (its lastLevel may be read elsewhere downstream)
      autoCompactTracker.updateLevel(postCompressionTokens, maxInputTokens);
      // Publish usage to chatStore for UI consumption.
      // tokensMax uses the FULL contextWindow (not the maxInputTokens budget)
      // so the denominator the user sees matches the model's published context
      // window (e.g. 200k for Claude / mimo-v2.5-pro), which is the mental
      // model users have. The maxInputTokens budget (contextWindow - output
      // reservation) is an internal compression-trigger detail.
      // overhead = system prompt + tool schema tokens. Published so the indicator
      // can compute live = overhead + estimateMessageTokens(messagesNow) without
      // waiting for the next loop iteration (fixes streaming + post-restart UX).
      const systemAndToolsOverhead = estimateTokens(effectiveSystemPrompt) + toolTokens;
      chatDelta.setContextUsage(conversationId, {
        percent: getUsagePercent(postCompressionTokens, contextWindowSize),
        tokensUsed: postCompressionTokens,
        tokensMax: contextWindowSize,
        overhead: systemAndToolsOverhead,
      });

      // Step 2.1: Persistent compaction (long-conversation Part A). When the
      // payload is still critically large after the send-only pass, land an
      // append-only compact-boundary marker so future turns read a compact
      // context from the marker (survives restart; no re-summarizing every turn).
      // Gating: computeCompactionPlan gets the token estimator so it only returns
      // a plan when there is enough NEW content the LAST marker doesn't already
      // cover (delta guard) — prevents divider-spam / a blocking summarize call
      // every turn while the conversation stays large. autoCompactTracker (shared
      // with the 65% path) is the failure circuit breaker. No per-turn latch: the
      // marker lands immediately so the next iteration already sees it.
      if (
        turnCount >= 3 &&
        postCompressionTokens >= maxInputTokens * PERSISTENT_COMPACTION_THRESHOLD &&
        !autoCompactTracker.isDisabled()
      ) {
        const plan = computeCompactionPlan(historyMessages, { estimateTokens: estimateMessageTokens });
        if (plan) {
          const compactionCreds = resolveEffectiveLlmCreds(
            getActiveApiKey(settingsForModel),
            getActiveProvider(settingsForModel)?.baseUrl || undefined,
          );
          let summaryText = '';
          try {
            summaryText = await summarizeConversation(plan.middleMessages, {
              adapter,
              model: effectiveModelId,
              apiKey: compactionCreds.apiKey,
              baseUrl: compactionCreds.baseUrl,
              signal: abortController.signal,
            });
          } catch (err) {
            // Defensive: summarizeConversation is contractually no-throw (it
            // swallows timeout/error and returns ''), but keep this in case an
            // unexpected error escapes. The empty-string path below is the real
            // failure recorder.
            logger.warn('[persistentCompaction] summarize threw unexpectedly', { error: String(err) });
          }
          if (summaryText.trim()) {
            // Append-only: create a marker and add it as the new last message. No
            // existing message is mutated — the rewrite data-loss class cannot
            // occur. buildContextFromBoundary picks it up next turn. (Known minor:
            // when this fires mid tool-use loop the divider can visually split
            // that loop's group — cosmetic.)
            const marker = createCompactBoundaryMarker({
              summaryText,
              summarizedFromId: plan.summarizedFromId,
              summarizedToId: plan.summarizedToId,
              source: 'auto',
              timestamp: Date.now(),
            });
            chatDelta.addMessage(conversationId, marker);
            // Clear the now-stale ephemeral 65% cache (a marker supersedes it),
            // mirroring the manual /compact path so the two land paths stay
            // symmetric.
            chatDelta.clearContextCache(conversationId);
            autoCompactTracker.recordSuccess();
            logger.info('[persistentCompaction] landed compact-boundary marker', {
              from: plan.summarizedFromId,
              to: plan.summarizedToId,
              summarizedCount: plan.middleMessages.length,
            });
          } else {
            // Empty return = timeout / error / empty summary. Record against the
            // SHARED circuit breaker: when a marker is already active this Step
            // 2.1 call is the ONLY compaction path (buildContextFromBoundary
            // short-circuits the 65% path that otherwise records failures), so
            // without this a provider that keeps timing out would re-issue a
            // blocking summarize every turn with no breaker relief — the "死寂"
            // stall class the breaker exists to prevent.
            autoCompactTracker.recordFailure();
          }
        }
      }

      const trimmedMessages = trimOldScreenshots(messagesForContext, usagePercent);

      // Step 3: Hard truncation as safety net
      const initialBudgetResult = enforceContextBudget(
        trimmedMessages,
        effectiveSystemPrompt,
        contextWindowSize,
        maxOutputTokens,
        toolTokens
      );
      let preparedMessages = initialBudgetResult.messages;

      // Step 4: Rehydrate stripped image base64 from disk before sending.
      // Persisted images keep only `filePath` (base64 cleared to save disk); the
      // send path used the empty data directly, emitting `data:<mime>;base64,`
      // (empty) → provider "Invalid base64 image_url", bricking every later turn.
      // rehydrateForSend gates on vision + is the single shared send-prep seam
      // (see also the recovery retry below — both must use it).
      preparedMessages = await rehydrateForSend(preparedMessages, {
        vision: modelCaps.vision,
        conversationId,
        workspacePath: getConversationReader().getConversation(conversationId)?.workspacePath ?? null,
        cache: imageBase64Cache,
      });

      // The final provider-boundary invariant. Re-run after image rehydration so
      // every primary send is checked in its actual outbound shape, not merely
      // against the persisted (base64-stripped) history representation.
      const finalBudgetResult = enforceContextBudget(
        preparedMessages,
        effectiveSystemPrompt,
        contextWindowSize,
        maxOutputTokens,
        toolTokens,
      );
      preparedMessages = finalBudgetResult.messages;
      if (initialBudgetResult.strategy !== 'unchanged' || finalBudgetResult.strategy !== 'unchanged') {
        logger.info('Context budget gate applied', {
          tokensBefore: initialBudgetResult.tokensBefore,
          tokensAfter: finalBudgetResult.tokensAfter,
          inputBudget: finalBudgetResult.inputBudget,
          safetyMarginTokens: finalBudgetResult.safetyMarginTokens,
          strategy: initialBudgetResult.strategy === 'unchanged'
            ? finalBudgetResult.strategy
            : initialBudgetResult.strategy,
        });
      }

      // Resolve apiKey + baseUrl — enterprise gateway overrides personal creds.
      // Throws EnterpriseLlmUnavailableError if enforced but gateway unreachable.
      const effectiveCreds = resolveEffectiveLlmCreds(
        getActiveApiKey(settingsForModel),
        getActiveProvider(settingsForModel)?.baseUrl || undefined,
      )

      const chatOptions = {
        model: effectiveModelId,
        apiKey: effectiveCreds.apiKey,
        baseUrl: effectiveCreds.baseUrl,
        systemPrompt: effectiveSystemPrompt,
        systemPromptSections: allSections,
        tools: tools.length > 0 ? tools : undefined,
        maxTokens: maxOutputTokens,
        signal: abortController.signal,
        enableThinking: reasoningParams.enableThinking,
        thinkingBudget: reasoningParams.thinkingBudget,
        reasoningEffort: reasoningParams.reasoningEffort,
        supportsVision: modelCaps.vision,
        declaredCapabilities: modelDeclared,
        builtinWebSearch,
        // When the adapter's max_tokens auto-retry succeeds, persist the
        // discovered limit so the next request uses it pre-emptively.
        onMaxTokensLimitDiscovered: activeProvider
          ? (limit: number) => {
              getCapsPort().recordMaxOutputTokens(activeProvider.id, effectiveModelId, limit);
              logger.info('Persisted discovered max_tokens limit', {
                providerId: activeProvider.id,
                modelId: effectiveModelId,
                limit,
              });
            }
          : undefined,
      };

      const chatFn = () => adapter.chat(preparedMessages, chatOptions, eventHandler);

      // Drive crash-protection flushes from elapsed time, not provider events.
      // A provider can emit one partial chunk and then stall indefinitely; the
      // old event-driven timestamp check never persisted that visible content.
      const STREAM_FLUSH_INTERVAL = 5000;
      let streamFlushInFlight = false;
      const flushStreamingMessage = async () => {
        if (streamFlushInFlight) return;
        streamFlushInFlight = true;
        try {
          const { replaceMessageById } = await import('../session/conversationStorage');
          const currentMsg = getConversationReader().getConversation(conversationId)
            ?.messages.find((m) => m.id === assistantMsgId);
          // Re-read after the async import. If the turn completed while this
          // timer callback yielded, its final write is authoritative and this
          // older periodic snapshot must not overwrite it.
          if (!currentMsg?.isStreaming) return;
          await replaceMessageById(conversationId, currentMsg);
        } catch {
          // Best-effort crash protection. Final turn persistence remains the
          // authoritative write when the request completes normally.
        } finally {
          streamFlushInFlight = false;
        }
      };
      streamFlushTimer = setInterval(() => {
        void flushStreamingMessage();
      }, STREAM_FLUSH_INTERVAL);

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
                const thinkingStartTime = getConversationReader().getThinkingStartTime();
                if (thinkingStartTime) {
                  const thinkingDuration = Math.max(1, Math.round((thinkingEndTime - thinkingStartTime) / 1000));
                  chatDelta.setThinkingDuration(conversationId, thinkingDuration, assistantMsgId);
                }
              }
              chatDelta.setAgentStatus('streaming');
              chatDelta.appendText(conversationId, event.text, assistantMsgId);
              break;

            case 'thinking':
              collectedThinking += event.thinking;
              chatDelta.appendThinking(conversationId, collectedThinking, assistantMsgId);
              break;

            case 'tool_use': {
              // Flush any buffered streaming tokens before processing tool calls
              chatDelta.flushTokens(conversationId);
              // Record thinking end time when we transition from thinking to tool-calling
              // and immediately push thinkingDuration so the UI's thinking step flips to
              // completed (same reason as the 'text' branch above).
              if (!thinkingEndTime && collectedThinking) {
                thinkingEndTime = Date.now();
                const thinkingStartTime = getConversationReader().getThinkingStartTime();
                if (thinkingStartTime) {
                  const thinkingDuration = Math.max(1, Math.round((thinkingEndTime - thinkingStartTime) / 1000));
                  chatDelta.setThinkingDuration(conversationId, thinkingDuration, assistantMsgId);
                }
              }

              // Special handling for report_plan — hide from the generic tool
              // list. plannedSteps land on the execution inside the tool's own
              // execute() (memoryTools), AFTER approval resolves: a rejected
              // plan must never reach the progress panel.
              if (event.name === TOOL_NAMES.REPORT_PLAN) {
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

              chatDelta.setAgentStatus('tool-calling', event.name);

              // Create step in TaskExecutionStore via EventRouter
              const stepId = eventRouter.createStepForToolUse(loopId, {
                toolName: event.name,
                toolInput: event.input,
              });

              // Store the mapping for later result update
              if (stepId) {
                toolCallToStepId.set(event.id, stepId);
              }

              collectedToolCalls.push({
                id: event.id,
                name: event.name,
                input: event.input,
                isExecuting: true,
                startTime: Date.now(),
                // Display-hidden but step-backed (show_widget): MessageGroup
                // renders it as a dedicated inline ShowWidgetCard (reading
                // title/widget_code/loading_messages off `input`) instead of
                // the generic tool list. Unlike report_plan (which breaks
                // early above), it goes through the full step bookkeeping so
                // planned-step auto-link/advance still counts widget calls.
                hidden: isDisplayHiddenStepBackedTool(event.name) || undefined,
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
              chatDelta.setCurrentUsage(finalUsage);
              break;

            case 'done':
              // Record thinking end time if not already done
              if (!thinkingEndTime && collectedThinking) {
                thinkingEndTime = Date.now();
              }
              // Calculate and save thinking duration
              if (collectedThinking && thinkingEndTime) {
                const thinkingStartTime = getConversationReader().getThinkingStartTime();
                if (thinkingStartTime) {
                  const thinkingDuration = Math.round((thinkingEndTime - thinkingStartTime) / 1000);
                  chatDelta.setThinkingDuration(conversationId, thinkingDuration, assistantMsgId);
                }
              }
              // Track stop reason for max_tokens recovery
              lastStopReason = event.stopReason;
              // Continue if there are tool calls
              if (event.stopReason === 'tool_use' && collectedToolCalls.length > 0) {
                continueLoop = true;
                maxOutputTokensRecoveryCount = 0; // Reset on normal tool_use continuation
              } else if (shouldContinueTruncatedToolCalls(event.stopReason, collectedToolCalls)) {
                // Bug #4: max_tokens cut off the turn AFTER ≥1 well-formed tool call.
                // Executing them and sending results back IS real progress, so treat
                // this exactly like a tool_use continuation: continue and reset the
                // recovery counter. The counter is left at 0 (not incremented) because
                // it belongs to the no-tool-call text recovery path below — bumping it
                // on a productive turn would corrupt that path's 3-attempt budget. This
                // branch is bounded the same way a normal tool_use loop is (by maxTurns),
                // and shouldContinueTruncatedToolCalls refuses an all-malformed batch so
                // a broken model can't spin here.
                continueLoop = true;
                maxOutputTokensRecoveryCount = 0;
              }
              if (event.usage) {
                finalUsage = event.usage;
                chatDelta.setCurrentUsage(event.usage);
              }
              break;

            case 'error':
              chatDelta.appendText(conversationId, `\n\n**Error:** ${event.error}`, assistantMsgId);
              break;
          }
        };

      // Observability: mark when this turn's LLM call begins (for generation latency)
      const genStartTime = Date.now();

      // Execute with retry and context-too-long recovery
      try {
        await withRetry(
          chatFn,
          { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 30000 },
          abortController.signal,
          (attempt, error, delayMs) => {
            // Surface EVERY retry (not just rate-limits) so a stalled/flaky
            // provider isn't a silent dead wait. rate_limit gets 5 attempts in
            // retry.ts, others get 3.
            const maxAttempts = error.code === 'rate_limit' ? 5 : 3;
            chatDelta.setRetryInfo({ attempt, maxAttempts, delayMs });
            if (error.code === 'rate_limit') {
              chatDelta.setAgentStatus('rate-limited', `${Math.round(delayMs / 1000)}s`);
            }
            // Clear any partial content written before the stream failed so
            // the retry starts with a clean message instead of appending to
            // a truncated or corrupted response.
            chatDelta.flushTokens(conversationId, assistantMsgId);
            chatDelta.setLastMessageContent(conversationId, '', assistantMsgId);
          }
        );
      } catch (retryErr) {
        // Handle context_too_long with two-stage recovery:
        // Stage 1: Semantic compression → retry
        // Stage 2: Hard truncation → retry
        // Stage 3: Surface error to user
        if (retryErr instanceof LLMError && retryErr.code === 'context_too_long') {
          // Reverse-engineer the real context window from the error message
          // and persist it. Pattern: "maximum context length is N tokens"
          // (OpenAI-compatible style). Next request will use this as a cap.
          const ctxMatch = /maximum context length is (\d+) tokens/i.exec(retryErr.message);
          let recoveryContextWindowSize = contextWindowSize;
          if (ctxMatch) {
            const discoveredWindow = parseInt(ctxMatch[1], 10);
            if (Number.isFinite(discoveredWindow) && discoveredWindow > 0) {
              recoveryContextWindowSize = Math.min(contextWindowSize, discoveredWindow);
              if (activeProvider) {
                getCapsPort().recordContextWindow(activeProvider.id, effectiveModelId, discoveredWindow);
                logger.info('Persisted discovered context window', {
                  providerId: activeProvider.id,
                  modelId: effectiveModelId,
                  contextWindow: discoveredWindow,
                });
              }
            }
          }

          chatDelta.appendText(
            conversationId,
            getI18n().chat.compactingInlineNotice,
            assistantMsgId
          );

          let recovered = false;

          // Stage 1: Try semantic compression (if not already attempted this turn)
          if (!autoCompactTracker.isDisabled()) {
            try {
              const recoveryCreds = resolveEffectiveLlmCreds(
                getActiveApiKey(settingsForModel),
                getActiveProvider(settingsForModel)?.baseUrl || undefined,
              )
              // Use boundaryView (marker-free compact view if a marker exists,
              // else raw history) so recovery never re-feeds a marker to the LLM
              // and reuses the existing summary instead of re-summarizing full raw
              // history.
              const compressionResult = await compressContextIfNeeded(
                boundaryView,
                effectiveSystemPrompt,
                contextWindowSize,
                maxOutputTokens,
                {
                  adapter,
                  model: effectiveModelId,
                  apiKey: recoveryCreds.apiKey,
                  baseUrl: recoveryCreds.baseUrl,
                  signal: abortController.signal,
                },
                toolTokens
              );
              if (compressionResult.compressed) {
                preparedMessages = enforceContextBudget(
                  compressionResult.messages,
                  effectiveSystemPrompt,
                  recoveryContextWindowSize,
                  maxOutputTokens,
                  toolTokens
                ).messages;
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
            // boundaryView is marker-free (compact view if a marker exists) so
            // the truncated emergency payload never contains a boundary marker.
            const emergencyRounds = identifyRounds(boundaryView);
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

          // Retry with recovered messages. These were rebuilt from the stripped
          // store copies (compression / round-slicing above), so re-run the same
          // send-prep seam the primary path uses — otherwise a vision model would
          // get empty-base64 images silently dropped on this path.
          preparedMessages = await rehydrateForSend(preparedMessages, {
            vision: modelCaps.vision,
            conversationId,
            workspacePath: getConversationReader().getConversation(conversationId)?.workspacePath ?? null,
            cache: imageBase64Cache,
          });
          const recoveryBudgetResult = enforceContextBudget(
            preparedMessages,
            effectiveSystemPrompt,
            recoveryContextWindowSize,
            maxOutputTokens,
            toolTokens,
          );
          preparedMessages = recoveryBudgetResult.messages;
          logger.info('Context recovery budget gate applied', {
            tokensBefore: recoveryBudgetResult.tokensBefore,
            tokensAfter: recoveryBudgetResult.tokensAfter,
            inputBudget: recoveryBudgetResult.inputBudget,
            safetyMarginTokens: recoveryBudgetResult.safetyMarginTokens,
            strategy: recoveryBudgetResult.strategy,
          });
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

      // Observability: record this turn's LLM call as a generation (no-op when disabled)
      {
        const turnMsg = getConversationReader().getConversation(conversationId)?.messages.find(m => m.id === assistantMsgId);
        startGeneration(conversationId, {
          name: `turn-${turnCount}`,
          model: effectiveModelId,
          input: preparedMessages,
          startTime: new Date(genStartTime),
        }).end({
          output: {
            content: turnMsg?.content,
            toolCalls: collectedToolCalls.map(tc => ({ name: tc.name, input: tc.input })),
          },
          usage: finalUsage,
          costUsd: finalUsage ? calculateTurnCost(effectiveModelId, finalUsage) : undefined,
        });
      }

      // Update usage on message if available
      if (finalUsage) {
        chatDelta.updateMessageUsage(conversationId, finalUsage, assistantMsgId);
        // Calibrate token estimator with actual API usage
        const estimatedInput = estimateTokens(effectiveSystemPrompt) + estimateMessageTokens(preparedMessages) + toolTokens;
        calibrateFromUsage(estimatedInput, finalUsage.inputTokens);
        // Record token usage
        const usageSnapshot = { ...finalUsage };
        import('../llm/usageTracker').then(({ recordTurnUsage }) => {
          recordTurnUsage(
            conversationId,
            effectiveModelId,
            route.type === 'skill'
              ? (route.skill?.name ?? null)
              : (getConversationReader().getConversation(conversationId)?.activeSkills?.[0] ?? null),
            {
              inputTokens: usageSnapshot.inputTokens,
              outputTokens: usageSnapshot.outputTokens,
              cacheReadInputTokens: usageSnapshot.cacheReadInputTokens,
              cacheCreationInputTokens: usageSnapshot.cacheCreationInputTokens,
            },
          );
        }).catch(() => {});
      }

      let semanticLoopReason: SemanticToolLoopReason | null = null;

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
          blockedTools: options?.blockedTools,
          allowedTools: options?.allowedTools,
          confirmCb,
          filePermCb,
          toolContext,
          continueLoop,
          contextUsagePercent: usagePercent,
          toolInvoker,
        });
        if (batchResult.requiresUserRecovery) {
          awaitingUserRecovery = true;
          continueLoop = false;
        }
        collectedToolCalls.forEach((toolCall, index) => {
          const observation = batchResult.observations[index];
          if (
            toolCall.name === TOOL_NAMES.TOOL_SEARCH
            && observation
            && !observation.error
          ) {
            promoteSearchedDeferredTools(
              toolCall.input,
              deferredTools,
              conversationId,
            );
          }
        });
        semanticToolHistory.push(
          ...batchResult.observations.map(minimizeToolLoopObservation),
        );
        if (semanticToolHistory.length > SEMANTIC_TOOL_LOOP_WINDOW) {
          semanticToolHistory.splice(0, semanticToolHistory.length - SEMANTIC_TOOL_LOOP_WINDOW);
        }
        semanticLoopReason = detectSemanticToolLoop(semanticToolHistory);

        // ★ Persist this turn's full message state (including completed tool calls)
        // to disk RIGHT NOW. We must use replaceMessageById (not updateLastMessage)
        // because by the time the next turn's addMessage races with our write, the
        // "last line" may already have shifted to the next turn's placeholder, and
        // updateLastMessage would either clobber the new placeholder or update the
        // wrong line. Awaiting here adds a few ms of latency but guarantees disk
        // state matches in-memory state before the loop continues.
        const turnMsg = getConversationReader().getConversation(conversationId)
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
          // Pass the SAME prefetchCtx the turn's own tool set was built with
          // (line ~1304). Without it, freshTools is the full unfiltered catalog
          // while `tools` is the prefetched subset, so every deferred tool shows
          // up as falsely "added" in the injected tools-changed notification.
          const { tools: freshRawTools } = resolveTools(toolInvoker, route, !!builtinWebSearch, options?.blockedTools, prefetchCtx, options?.allowedTools, conversationId);
          const freshTools = noTools ? [] : freshRawTools;
          const freshNames = new Set(freshTools.map(t => t.name));
          const added = freshTools.filter(t => !toolNames.has(t.name));
          const removed = tools.filter(t => !freshNames.has(t.name));

          if (added.length > 0 || removed.length > 0) {
            const tc = getI18n().chat;
            const parts: string[] = [tc.toolsUpdatedHeader];
            if (added.length > 0) {
              parts.push(format(tc.toolsAdded, { tools: added.map(t => t.name).join(', ') }));
            }
            if (removed.length > 0) {
              parts.push(format(tc.toolsRemoved, { tools: removed.map(t => t.name).join(', ') }));
            }
            parts.push(tc.toolsUpdatedFooter);
            chatDelta.addMessage(conversationId, {
              id: generateId(),
              role: 'user',
              content: parts.join('\n'),
              timestamp: Date.now(),
              loopId,
            });
          }
        }
      }

      // L4: learn that a statically-non-reasoning model actually reasons, so future
      // turns bound it (treated as 'uncontrollable' → full budget + reserved content).
      // Skip if the user explicitly declared supportsReasoning=false — their declaration
      // takes precedence over runtime observation.
      if (collectedThinking && modelCaps.thinking === false && activeProvider
          && modelDeclared?.supportsReasoning !== false) {
        getCapsPort().recordReasoningObserved(activeProvider.id, effectiveModelId);
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
          chatDelta.addMessage(conversationId, recoveryMsg);
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
          chatDelta.appendText(
            conversationId,
            format(getI18n().chat.outputLimitError, { limit: MAX_OUTPUT_TOKENS_RECOVERY_LIMIT }),
            assistantMsgId
          );
        }
      }

      // A: no-progress guard. A turn whose tool calls are ALL unparseable is not
      // real progress; tolerate a few in a row (the _parse_error results give the
      // model a chance to recover) but stop a model stuck emitting only malformed
      // calls before it spins to maxTurns. Mirrors subagentLoop's isNoProgressTurn
      // via the shared allToolsUnparseable predicate. Checked before the queued-input
      // override below, so a present user can still rescue the loop by typing.
      let noProgressAborted = false;
      if (semanticLoopReason && !awaitingUserRecovery) {
        continueLoop = false;
        noProgressAborted = true;
        logger.warn('Semantic tool loop stopped', {
          conversationId,
          loopId,
          reason: semanticLoopReason,
          observationCount: semanticToolHistory.length,
        });
      } else if (allToolsUnparseable(collectedToolCalls)) {
        consecutiveNoProgress++;
        if (consecutiveNoProgress >= MAX_NO_PROGRESS_TURNS) {
          continueLoop = false;
          noProgressAborted = true;
        }
      } else {
        consecutiveNoProgress = 0;
      }

      // If the user enqueued additional input mid-stream (handled by ChatInput when
      // a message is sent while a turn is still running), and the current turn ended
      // with plain text rather than tool_use, run another turn so the LLM actually
      // responds to that follow-up. Without this, mid-stream user messages get added
      // to the conversation but never receive a reply.
      if (
        !continueLoop
        && !awaitingUserRecovery
        && hasQueuedInputs(conversationId)
        && !abortController.signal.aborted
      ) {
        // Flush any buffered tokens and finalize the previous assistant message
        // (toolExecutor normally does this between tool_use turns; we have to do it
        // ourselves on the no-tool path).
        chatDelta.flushTokens(conversationId, assistantMsgId);
        chatDelta.setMessageStreamingFlag(conversationId, assistantMsgId, false);
        continueLoop = true;
        // A new user directive is a fresh start: restore the full no-progress
        // tolerance budget so the rescue actually buys the intended retries, not
        // just one more turn before the (still-3) counter trips again.
        consecutiveNoProgress = 0;
        semanticToolHistory.length = 0;
      }

      if (!continueLoop) {
        // Surface why we stopped when it was the no-progress guard, so the user
        // doesn't mistake a degenerate stop for a finished answer (mirrors the
        // max_tokens-exhausted marker above).
        if (noProgressAborted) {
          chatDelta.appendText(
            conversationId,
            `\n\n${semanticLoopReason
              ? getI18n().chat.semanticLoopStopped
              : getI18n().chat.noProgressStopped}`,
            assistantMsgId,
          );
        }
        chatDelta.finishStreaming(conversationId, assistantMsgId);
        abortRegistry.clearAbortController(conversationId);
        const endReason = awaitingUserRecovery
          ? 'awaiting_user'
          : noProgressAborted
          ? 'no_progress'
          : maxTokensRecoveryExhausted ? 'max_tokens_exhausted' : 'end_turn';
        logger.info('Agent loop ended', { conversationId, loopId, turnCount, reason: endReason });
        // Reaching this point means no LLM call threw, so ok:true is correct
        // regardless of endReason (no_progress / max_tokens_exhausted / end_turn).
        recordProviderCallOutcome(getActiveProvider(settingsForModel)?.id, { ok: true, at: Date.now() });
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
        // Close any open AX session (releases CFRetain'd element refs)
        import('../tools/definitions/computerTools').then(({ closeAxSession }) => {
          closeAxSession(conversationId, loopId).catch(() => {});
        }).catch(() => {});
        // Clear crash recovery checkpoint — loop completed normally
        import('../session/checkpoint').then(({ clearCheckpoint }) => {
          clearCheckpoint(conversationId);
        }).catch(() => {});
        // Mark conversation status — error if recovery exhausted, otherwise completed.
        // no_progress is a soft stop (visible marker, status completed) like maxTurns.
        if (awaitingUserRecovery) {
          exitReason = 'awaiting_user';
        } else if (maxTokensRecoveryExhausted) {
          exitReason = 'error';
          exitError = 'Max output tokens recovery exhausted';
        } else if (noProgressAborted) {
          exitReason = 'no_progress';
        }
        chatDelta.setConversationStatus(
          conversationId,
          awaitingUserRecovery ? 'idle' : maxTokensRecoveryExhausted ? 'error' : 'completed',
        );
  
        // Interactive-desktop gate: user-visible conversations only.
        // IM conversations, scheduled tasks, triggers run headless — the
        // user can't see skill proposal cards / review memory extractions,
        // so any autonomous write from these contexts would silently
        // pollute the workspace. Both memory extraction AND self-evolution
        // proposals share this gate (they're two sides of the same
        // "agent writes stuff only when user can review" invariant).
        const convRecord = getConversationReader().getConversation(conversationId);
        const interactiveDesktop = isInteractiveDesktop(options, convRecord);

        // Auto-extract memories from desktop conversations (non-blocking).
        // IM conversations have their own extraction in channelRouter.ts.
        if (interactiveDesktop && !awaitingUserRecovery) {
          const wsPath = convRecord?.workspacePath ?? getWorkspaceReader().getCurrentPath();
          import('../memdir/extractor').then(({ extractMemoriesFromConversation }) =>
            extractMemoriesFromConversation(conversationId, wsPath)
          ).catch(() => {});
        }

        // Post-loop proposal signal — if this loop was "sink-worthy",
        // stash a one-shot nudge so next turn's system prompt tells
        // the agent to consider skill_manage(agent_proposed=true). This
        // is the self-evolution activation mechanism — without it,
        // agent only proposes when user explicitly says "save this".
        //
        // The gate logic (interactiveDesktop + workspace bound) lives
        // in `shouldComputeProposalSignal` so it's unit-testable. Full
        // rationale in that function's docstring (Task #49 + #51).
        const wsPath = convRecord?.workspacePath ?? getWorkspaceReader().getCurrentPath();
        if (
          exitReason === 'completed' &&
          !awaitingUserRecovery &&
          shouldComputeProposalSignal(options, convRecord, wsPath)
        ) {
          try {
            const { computeProposalSignal } = await import('./proposalSignal');
            const proactivity =
              settingsReader.getSnapshot().soul?.proactivity ?? 'companion';
            const loopMsgs = (convRecord?.messages ?? []).filter((m) => m.loopId === loopId);
            const signal = computeProposalSignal(loopMsgs, proactivity);
            if (signal) {
              chatDelta.setPendingProposalSignal(conversationId, signal);
            }
          } catch (err) {
            logger.warn('[proposalSignal] compute failed', { err: err instanceof Error ? err.message : String(err) });
          }
        }
        if (!awaitingUserRecovery) {
          const convTitle = getConversationReader().getIndexEntry(conversationId)?.title ?? getI18n().chat.notificationTaskFallback;
          notifyTaskCompleted(convTitle, conversationId);
        }
      }
    } catch (err) {
      // Handle abort errors gracefully.
      // retry.ts wraps signal-aborted sleeps in LLMError(code='cancelled'); treat
      // it as a user abort too, otherwise it would surface as "Error: Request cancelled".
      const isUserAbort = err instanceof Error
        && (err.name === 'AbortError'
          || abortController.signal.aborted
          || (err instanceof LLMError && err.code === 'cancelled'));
      if (isUserAbort) {
        logger.warn('Agent loop aborted', { conversationId, loopId });

        // Flush partial streamed text into the message first — on this path the
        // RAF-batched token buffer may still hold everything streamed so far.
        chatDelta.flushTokens(conversationId, assistantMsgId);

        // Backfill missing tool results for interrupted tool calls.
        // Without this, orphaned tool_use blocks cause API 400 errors on the next turn.
        for (const tc of collectedToolCalls) {
          const existing = getConversationReader().getConversation(conversationId)
            ?.messages.find((m) => m.id === assistantMsgId)
            ?.toolCalls?.find((t) => t.id === tc.id);
          if (existing && existing.result === undefined) {
            chatDelta.updateToolCall(conversationId, assistantMsgId, tc.id,
              '[Tool execution interrupted by user]', undefined, true);
            chatDelta.appendToolCallContext(conversationId, loopId, {
              name: tc.name,
              input: tc.input,
              result: '[Tool execution interrupted by user]',
            });
          }
        }

        // Clear loop context and any pending confirmation/permission dialogs
        clearLoopContext(loopId);
        // Surface staged (non-system) queue messages as transcript user bubbles
        // before clearing — the aborted loop can't answer them, but the text
        // must remain visible instead of being silently destroyed.
        for (const qi of drainQueuedInputs(conversationId)) {
          if (qi.isSystem) continue;
          chatDelta.addMessage(conversationId, {
            id: generateId(),
            role: 'user',
            content: qi.text,
            timestamp: qi.timestamp,
            loopId,
          });
        }
        clearInputQueue(conversationId);
        drainConfirmationQueue();
        drainFilePermissionQueue();
        drainWorkspaceRequest();
        drainUserQuestions();
        drainCapabilitySetupRequests(loopId);

        // Drop the untouched placeholder BEFORE cancelStreaming: an abort that
        // arrived before any text/thinking/tool call would otherwise persist as
        // a blank assistant bubble (live now, and after reload via the JSONL
        // copy written at creation — sanitizeLoadedMessages drops that one).
        const placeholder = getConversationReader().getConversation(conversationId)
          ?.messages.find((m) => m.id === assistantMsgId);
        if (placeholder) {
          const placeholderText = typeof placeholder.content === 'string'
            ? placeholder.content
            : placeholder.content.filter((c) => c.type === 'text')
                .map((c) => (c as { type: 'text'; text: string }).text).join('');
          const isGhost = placeholderText.trim().length === 0
            && !(placeholder.toolCalls?.length)
            && !(placeholder.toolCallsForContext?.length)
            && !placeholder.thinking;
          if (isGhost) {
            // code-review fix #8: chatStore.deleteMessage's catalog `-1` only
            // balances a `+1` that addMessage's appendMessage call actually
            // fired. If this ghost placeholder aborted before that
            // fire-and-forget disk-append ran, there was never a `+1` to
            // offset, so skip the bump — otherwise the catalog would
            // transiently undercount until the next turn-end reindex.
            // P1-3B-3B fix: in-process this call is synchronous, but the
            // sidecar-run path shims it to an async reverse RPC
            // (session.isMessageWrittenToDisk — see
            // sidecar/src/shims/conversationStorageRun.ts). An un-awaited
            // call there always resolved a truthy Promise, so
            // skipCatalogBump was always `false` on the sidecar path
            // regardless of the real answer. `await`ing a synchronous
            // boolean is harmless (Promise.resolve(value) semantics), so
            // this is safe for both paths.
            const { isMessageWrittenToDisk } = await import('../session/conversationStorage');
            chatDelta.deleteMessage(conversationId, assistantMsgId, {
              skipCatalogBump: !(await isMessageWrittenToDisk(assistantMsgId)),
            });
          }
        }

        chatDelta.cancelStreaming(conversationId);
        abortRegistry.clearAbortController(conversationId);
        // Cancel the TaskExecution
        executionPort.cancelExecution(execution.id);
        // Auto-deactivate skills on abort
        deactivateAllSkills(conversationId);
        // Clear crash recovery checkpoint — loop aborted by user
        import('../session/checkpoint').then(({ clearCheckpoint }) => {
          clearCheckpoint(conversationId);
        }).catch(() => {});
        // Close any open AX session (releases CFRetain'd element refs)
        import('../tools/definitions/computerTools').then(({ closeAxSession }) => {
          closeAxSession(conversationId, loopId).catch(() => {});
        }).catch(() => {});
        // Set status back to idle on cancel
        chatDelta.setConversationStatus(conversationId, 'idle');

        endConversationTrace(conversationId, { output: { reason: 'aborted' } });
        await endComputerUseTaskLease();
        return { reason: 'aborted' as const };
      }

      clearLoopContext(loopId);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof LLMError
        ? err.code
        : err instanceof ContextBudgetError
        ? err.code
        : undefined;
      logger.error('LLM call failed', {
        error: errorMessage,
        code: errorCode,
        model: effectiveModelId,
        providerId: getActiveProvider(settingsForModel)?.id,
      });

      // Fire-and-forget: report to console for quality monitoring
      if (err instanceof LLMError) {
        reportError('api_error', err.code, err.statusCode ?? undefined, effectiveModelId, errorMessage, err.rawBody);
        // Only a persistent config-class provider failure (not a transient rate
        // limit / 5xx / network blip, and not a non-LLM agent crash) should mark
        // this provider unhealthy for the diagnostic.
        if (isConfigFailureCode(err.code)) {
          recordProviderCallOutcome(getActiveProvider(settingsForModel)?.id, { ok: false, code: err.code, at: Date.now() });
        }
      } else {
        reportError('agent_crash', errorCode ?? 'unknown', undefined, effectiveModelId, errorMessage);
      }
      logger.info('Agent loop ended', { conversationId, loopId, turnCount, reason: 'error' });

      // Friendly message when a 400 error is likely caused by image content
      // sent to a model that doesn't support vision
      const isLikelyVisionError = isVisionUnsupportedError(
        errorCode,
        err instanceof LLMError ? err.statusCode : undefined,
        conversationHasImages(getConversationReader().getConversation(conversationId)?.messages ?? []),
        modelSupportsVision,
      );
      const isOllamaForbidden = errorCode === 'authentication'
        && err instanceof LLMError && err.statusCode === 403
        && /^forbidden\s*$/i.test(err.message.trim());
      const isEnterpriseGatewayUnavailable = err instanceof EnterpriseLlmUnavailableError;
      const isContextBudgetError = err instanceof ContextBudgetError;
      let displayError = isEnterpriseGatewayUnavailable
        ? getI18n().chat.gatewayUnreachable
        : isContextBudgetError && err.code === 'INPUT_TOO_LARGE'
        ? getI18n().chat.contextInputTooLarge
        : isContextBudgetError
        ? getI18n().chat.contextFixedTooLarge
        : isLikelyVisionError
        ? getI18n().chat.visionUnsupported
        : isOllamaForbidden
        ? getI18n().chat.ollamaForbidden
        : formatLlmDisplayError(err, errorMessage, getI18n().chat.errorEmptyBody);
      if (errorCode === 'not_found') {
        displayError += `\n\n${getI18n().chat.errorNotFoundHint}`;
      }

      chatDelta.appendText(
        conversationId,
        `\n\n**Error:** ${displayError}`,
        assistantMsgId
      );
      chatDelta.finishStreaming(conversationId, assistantMsgId);
      abortRegistry.clearAbortController(conversationId);
      // Error the TaskExecution
      eventRouter.route({ type: 'error', loopId, error: errorMessage });
      persistExecutionSnapshot(conversationId, loopId);
      // Auto-deactivate skills on error
      deactivateAllSkills(conversationId);
      // Clean up Computer Use session
      import('./computerUseStatus').then(({ setComputerUseActive }) => {
        setComputerUseActive(false);
      }).catch(() => {});
      // Close any open AX session (releases CFRetain'd element refs)
      import('../tools/definitions/computerTools').then(({ closeAxSession }) => {
        closeAxSession(conversationId, loopId).catch(() => {});
      }).catch(() => {});
      // Clear crash recovery checkpoint — loop ended with error
      import('../session/checkpoint').then(({ clearCheckpoint }) => {
        clearCheckpoint(conversationId);
      }).catch(() => {});
      // Mark conversation as error and send notification
      chatDelta.setConversationStatus(conversationId, 'error');

      const convTitle = getConversationReader().getIndexEntry(conversationId)?.title ?? getI18n().chat.notificationTaskFallback;
      notifyTaskError(convTitle, conversationId);
      exitReason = 'error';
      exitError = errorMessage;
      continueLoop = false;
    } finally {
      if (streamFlushTimer) clearInterval(streamFlushTimer);
    }
  }
  abortController.signal.removeEventListener('abort', endComputerUseTaskOnAbort);
  await endComputerUseTaskLease();
  endConversationTrace(conversationId, { output: { reason: exitReason }, error: exitError });
  return { reason: exitReason, error: exitError };
}
