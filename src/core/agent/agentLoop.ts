import type { StreamEvent, ToolCall, TokenUsage, ImageAttachment, MessageContent, ToolExecutionContext } from '../../types';
import type { LLMAdapter } from '../llm/adapter';
import { LLMError, formatLlmDisplayError } from '../llm/adapter';
import { recordProviderCallOutcome, isConfigFailureCode } from '../llm/providerCallHealth';
import { ClaudeAdapter } from '../llm/claude';
import { OpenAICompatibleAdapter } from '../llm/openai-compatible';
import { getAllTools, type ConfirmationInfo, type FilePermissionCallback } from '../tools/registry';
import type { ToolDefinition } from '../../types';
import { useChatStore, flushTokenBuffer } from '../../stores/chatStore';
import { useSettingsStore, getEffectiveModel, getActiveApiKey, getActiveProvider, resolveAgentModel, providerRequiresApiKey } from '../../stores/settingsStore';
import { useDiscoveredCapsStore } from '../../stores/discoveredCapabilitiesStore';
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
import { allToolsUnparseable, MAX_NO_PROGRESS_TURNS, resolveMaxTurns } from './loopGuards';
import { drainQueuedInputs, clearInputQueue, enqueueUserInput } from './userInputQueue';
import { snapshotExecutionSteps } from './executionSnapshot';
import { emitHook } from './lifecycleHooks';
import { getI18n, format } from '../../i18n';
import { clearAllSkillHooks } from '../tools/builtins';
import { executeToolBatch } from './toolExecutor';
import { startConversationTrace, endConversationTrace, startGeneration } from '../observability/langfuse';
import { calculateTurnCost } from '../llm/costTracker';
import { formatPlannedStepsForPrompt } from './plannedStepsPrompt';
import { isWindows } from '../../utils/platform';
import { getBuiltinSearchConfig } from '../capabilities';
import { resolveCapabilities, resolveEffectiveContextWindow, computeReasoningParams, type ModelCapabilities } from '../llm/modelCapabilities';
import { applyDeclaredCapabilities } from '../llm/applyDeclaredCapabilities';
import { resolveModelDeclared } from '../llm/resolveModelDeclared';
import { rehydrateForSend, type ImageBase64Cache } from '../llm/imageRehydration';
import { TOOL_NAMES, isDisplayHiddenStepBackedTool } from '../tools/toolNames';
import { WIDGET_CDN_HOSTS, getWidgetHardBanBriefList } from '../widget/guidelines';
import { prefetchTools } from '../tools/toolPrefetch';
import { classifyTools, buildDeferredToolsSummary } from '../tools/toolSearch';
import { hasQueuedInputs } from './userInputQueue';
import { resolveEffectiveLlmCreds, EnterpriseLlmUnavailableError } from '../enterprise/llm-resolver';
import { createLogger } from '../logging/logger';
import { reportError } from '@/utils/consoleError';

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
async function buildUserMessageContent(
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

/** Persist execution steps onto the last assistant message for the given loop, then evict from memory */
export function persistExecutionSnapshot(conversationId: string, loopId: string): void {
  const store = useTaskExecutionStore.getState();
  const exec = store.getExecutionByLoopId(loopId);
  // Return early only when there is truly nothing to persist.
  if (!exec || (exec.steps.length === 0 && exec.plannedSteps.length === 0)) return;

  // Persist execution steps snapshot if any.
  if (exec.steps.length > 0) {
    useChatStore.getState().setExecutionStepsSnapshot(conversationId, loopId, snapshotExecutionSteps(exec.steps));
  }
  // Persist planned steps so TaskProgressPanel survives loop eviction. The
  // panel renders an in_progress step statically (no spinner) once the live
  // execution is gone, so a stopped mid-flight step reads as "in progress,
  // paused" rather than a perpetual spinner — no status rewrite needed here.
  if (exec.plannedSteps.length > 0) {
    useChatStore.getState().setPlannedStepsSnapshot(conversationId, loopId, exec.plannedSteps);
  }
  store.evictExecution(exec.id);
}

/**
 * Abu's default soul — factory personality.
 * Used when ~/.abu/SOUL.md is empty or doesn't exist.
 * Exported so orchestrator can use it as fallback.
 */
export function getDefaultSoul(): string {
  return `You are Abu (阿布), a professional, reliable, easy-to-talk-to desktop AI assistant. Your job is to help the user get all kinds of work done efficiently — file management, finding information, content creation, everyday office tasks — you can lend a hand with anything.

## Core principles
- Natural, conversational tone, like a reliable friend helping out: not stuffy, but not cutesy either
- Positive and pragmatic: when something breaks, offer a fix; when a task is done, give a brief report — no excessive reassurance or praise
- Refer to yourself as "Abu" (阿布) or "I"; do not use kaomoji or emoji
- Keep replies concise, clear, and focused: neither aloof nor long-winded

## Reply style — concise and direct
- **Focus on the result, not the process**: the tool-call process is already shown in the UI; don't restate it in text
- **No technical jargon**: don't mention the OS type, programming languages, the command line, API names, or tool names
- **No implementation details**: don't say "I'll use Python to...", "let me get the system info first...", or "on the xxx system..."
- **Short reply examples**:
  - Opened a website → "Opened Xiaohongshu for you"
  - Finished → "Done"
  - Read a file → "Took a look — this file is..."
  - Something failed → "Didn't work: [brief reason]. Want me to try again?"
- **Exceptions** (detail is fine): the user explicitly asks "how did you do it", a task failed and needs an explanation, or a complex task needs step-by-step confirmation`;
}

/**
 * The "Visual output" capability section — two variants, selected on the
 * resolved model's tool support:
 *
 * - Tools supported (default): visualization goes through the explicit
 *   show_widget tool (P1 widget system, aligned with WorkBuddy/ChatGPT/TRAE),
 *   and a "save as a real webpage" intent escalates to write_file. A written
 *   .html CAN open in the side preview panel — MessageGroup.tsx's openPreview
 *   effect auto-opens the LAST non-image deliverable of the turn, so the
 *   prompt is worded "can be opened" (not "always auto-opens"): if the model
 *   writes another file after the page, that one wins the auto-open. No new
 *   tool needed either way.
 * - Tools NOT supported (`supportsTools === false`): the model gets tools=[]
 *   (see the `noTools` gate in the turn loop) — no show_widget, no
 *   write_file, nothing. These models keep the previous ```html-fence
 *   instruction — the fence rendering path still works
 *   (codeBlockRenderers.ts) and is the ONLY channel they have, so there is
 *   no save-as-a-file escalation to offer them.
 *
 * Both variants share the same trigger tiers (when to make a visual at all)
 * and the same hard-ban list (`getWidgetHardBanBriefList()`, single-sourced
 * from guidelines.ts's `WIDGET_HARD_BAN_RULES` — read_me documents the same
 * rules in full) — this is what stops the white-screen failure class at the
 * prompt layer, before a single widget is ever rendered.
 *
 * Both variants also carve a STATIC structure diagram (flowchart, tree,
 * sequence, state machine, org chart, node/edge graph, ER diagram, Gantt
 * chart) out of the show_widget/```html default and route it to a
 * ```mermaid fence instead — Abu bundles a real Mermaid engine
 * (MermaidBlock.tsx, no CDN) registered for that fence in
 * codeBlockRenderers.ts, so this carve-out routes static structure diagrams
 * to the robust engine instead of fragile hand-drawn SVG. (ER diagram/Gantt
 * chart were folded in from the now-non-auto-invoking mermaid-diagram
 * builtin skill's type table — the two mermaid strengths svg-diagram can't
 * match — see guidelines.ts's file-header note on the wider skill fold-in.)
 * The carve-out must be worded as scoping DOWN the show_widget/html default,
 * not replacing it, so the two rules don't read as contradictory. It
 * distinguishes BY PURPOSE, not keyword: a project-scheduling Gantt (tasks
 * with start/end dates) stays on Mermaid, but a reading-oriented timeline of
 * milestones/history ("大事记", dated events for a reader) routes to
 * show_widget's `poster` Timeline recipe (guidelines.ts) instead — otherwise
 * the model over-generalizes "timeline" -> mermaid's own `timeline` diagram
 * type, which is plain and underwhelming compared to the poster rendering.
 * Qualifying Gantt this way also prevents the timeline exclusion from
 * contradicting the retained "Gantt chart" entry in the same mermaid list.
 */
const VISUAL_TRIGGER_TIERS = `**When to make a visual** — explicit ask (show/visualize/diagram/chart/draw/graph/plot, "what does X look like"); proactively make a visual — don't answer in prose alone — for how-does-X-work / teaching / process / architecture / "compare A vs B" requests; or implied by the noun phrase ("comparison table of A vs B", "settings panel mockup", "state machine for …") — a markdown table is NOT a substitute when a visual is what's actually being asked for. (Mockups use plain inputs/buttons, never a real <form>.)`;

// Shared blocks — identical in both variants, factored out so the ban list
// and the CDN allowlist can't drift between the tool and fence prompts.
const VISUAL_HARD_BANS_BLOCK = `**Hard bans** (cause a blank/broken render):
${getWidgetHardBanBriefList()}`;

const VISUAL_CDN_ALLOWED_LINE = `**Allowed**: CDN libraries (Chart.js, D3, etc.): ${WIDGET_CDN_HOSTS.join(' / ')}`;

const VISUAL_OUTPUT_TOOL_VARIANT = `${VISUAL_TRIGGER_TIERS}

**Routing — the deciding question is "is this a file the user wants to keep?"** Ephemeral, part of this reply → **call the show_widget tool**, right where you need it — this is the default (call read_me once before your first call each conversation, don't narrate it). A page the user wants to **save, export, download, or keep as a real file** → write_file a COMPLETE self-contained \`.html\` document (doctype + html/head/body; inline CSS/JS or the CDN allowlist below) — it can then be opened in the side preview panel. Only escalate to write_file on an explicit save/export intent.

**Static structure diagrams — carve-out**: when labeled nodes and edges fully explain a STATIC structure — flowchart, tree, sequence diagram, state machine, org chart, node/edge graph, ER diagram, Gantt chart (project scheduling — tasks with start/end dates) — output a \`\`\`mermaid code block instead (rendered by the built-in Mermaid engine, no sandbox). A reading-oriented timeline of milestones/history ("大事记", dated events for a reader) is not a structure graph — use show_widget (poster-style timeline). (Project-scheduling Gantt charts still use Mermaid, above.) This narrows, not replaces, the show_widget default above: show_widget stays the default for everything dynamic, interactive, data-driven, or chart-like.

${VISUAL_HARD_BANS_BLOCK}

**Strictly forbidden**: generate_image for a chart/diagram (show_widget draws those) — just call show_widget.

${VISUAL_CDN_ALLOWED_LINE}`;

const VISUAL_OUTPUT_FENCE_VARIANT = `${VISUAL_TRIGGER_TIERS}

**Rendering**: no tools here — every visual, including a "save"/"download" ask, goes through **a \`\`\`html code block in your reply**; there's no separate saved-file path, so say so if the user needs a real downloadable file.

**Static structure diagrams — carve-out**: when labeled nodes and edges fully explain a STATIC structure — flowchart, tree, sequence diagram, state machine, org chart, node/edge graph, ER diagram, Gantt chart (project scheduling — tasks with start/end dates) — output a \`\`\`mermaid code block instead (rendered by the built-in Mermaid engine, no sandbox). A reading-oriented timeline of milestones/history ("大事记", dated events for a reader) is not a structure graph — use an \`\`\`html poster-style timeline. (Project-scheduling Gantt charts still use Mermaid, above.) Use an \`\`\`html fragment for everything dynamic, interactive, data-driven, or chart-like.

${VISUAL_HARD_BANS_BLOCK}

**Design system** (no design-guide tool in this mode — use these directly): utility classes \`.w-card\`/\`.w-stat\`/\`.w-grid\`/\`.w-row\`/\`.w-badge\`/\`.w-btn\` plus the \`--w-*\` theme vars.

${VISUAL_CDN_ALLOWED_LINE}`;

/**
 * Abu's capability prompt — always injected, cannot be overridden by SOUL.md.
 * Contains operational rules: visualization, work style, permissions, extensions.
 *
 * `supportsTools` (default true) selects the visual-output variant — see the
 * variant constants above. All other sections are identical in both modes.
 */
export function getCapabilityPrompt(opts?: { supportsTools?: boolean }): string {
  const win = isWindows();
  const dangerousCmd = win ? 'del /s /q' : 'rm -rf';
  const abuDir = win ? '%USERPROFILE%\\.abu\\' : '~/.abu/';
  const skillPathTmpl = win ? '%USERPROFILE%\\.abu\\skills\\{skill-name}\\' : '~/.abu/skills/{skill-name}/';
  const agentPathTmpl = win ? '%USERPROFILE%\\.abu\\agents\\{agent-name}\\' : '~/.abu/agents/{agent-name}/';
  const visualOutput = opts?.supportsTools === false
    ? VISUAL_OUTPUT_FENCE_VARIANT
    : VISUAL_OUTPUT_TOOL_VARIANT;

  return `## Visual output — generative UI (important!)
${visualOutput}

**Editing an already-exported file**:
- ⚠️ Once a file is written to disk, **partial edits must use edit_file** (provide old_content + new_content for an exact replacement)
- ❌ Never use write_file to fully overwrite an existing multi-section document (report / long HTML / long code) — it loses content the user didn't ask to change
- ✅ If you truly need to rebuild the whole file structure, first run_command to delete the original file, then write_file to create a new one

**Style requirement (exported/write_file documents only)**: use a light/white background, no dark/black background — a standalone file has no host theme to follow. (This is the opposite of the inline visual path above, which is theme-aware by design because it renders inside Abu's chat.)

## How you work — take initiative!
You are a **proactive assistant**. When the user gives you a task:
1. **Act first, report after** — don't ask the user "do you want me to do X"; just use tools to do it
2. **Gather information yourself** — if you need a path, file contents, etc., get it with tools directly; don't ask the user
3. **Only reach out when you hit a problem** — ask the user only when you actually hit an obstacle (insufficient permission, path doesn't exist, the user needs to make a choice)

### Common scenarios
- User says "look at the desktop" → directly use tools to get the desktop path and list its contents
- User says "help me organize files" → first see what's there, then make a plan and execute it
- When you hit an uncertain proper noun, brand name, or project name, web_search first, then answer — don't guess
- If during a task you find you're missing some tool capability (e.g. operating GitHub, Slack, a database), use search_mcp_server to find the matching MCP service
- User asks to install some software/tool/app (e.g. "help me install xxx") → this is a normal software-install request; web_search for the install method and tell the user the steps, or run_command to run the install command — do NOT use search_mcp_server

### Permissions and safety
The following actions require informing the user and getting confirmation before executing:
- **Deleting files/directories** — tell the user what you're about to delete, and wait for "ok / go ahead / delete it" before executing
- **Overwriting an existing file** — tell the user the file already exists, and wait for confirmation before overwriting
- **Running potentially risky commands** — e.g. ${dangerousCmd}, formatting, etc.

**First-time access to a new directory requires user authorization.** When you read, list, or write files in a new directory, the system automatically pops up an authorization dialog. Once the user authorizes it, all operations under that directory proceed normally. Sensitive directories (e.g. .ssh, .aws) are rejected outright and cannot be authorized.
Ordinary commands (run_command) can be run directly; just report the result afterward.

## Extension directory structure
Abu's extensions live under the ${abuDir} folder in the user's home directory:
- **skills/** — the skills directory; each skill has a SKILL.md file, path: ${skillPathTmpl}SKILL.md
- **agents/** — the agents directory; each agent has an AGENT.md file, path: ${agentPathTmpl}AGENT.md

Use the skill_manage (create/patch/write_file) tool to create or modify skills, and the save_agent tool to create a new agent.

## Parallel agent capability
When the user's task can be split into multiple **independent subtasks**, you can use the async parameter of delegate_to_agent to run them in parallel:
- Calling delegate_to_agent(task: "subtask description", type: "research", async: true) returns immediately, and the agent runs in the background
- You can dispatch multiple agents at once (up to 5), each working independently
- Once all agents finish, their results are returned automatically, and you then synthesize the output for the user

### When to use parallel agents
- The user asks to do several things "at the same time", "in parallel", or "separately"
- The subtasks have no dependencies between them (e.g. researching topics A, B, and C)
- Each subtask needs multiple steps (search + organize + summarize)

### When not to use
- A single simple question can just be answered directly
- The subtasks depend on one another in sequence
- It can be done with a single tool call

### After receiving agent results
- You'll receive agent results in <agent-result> format
- **Synthesize and condense**: extract the key information and comparisons; don't list the raw content one by one
- If multiple agents did similar research, present the differences as a comparison table or bullet points
- Summarize in your own words; don't copy-paste the agents' raw output

## Large-file reading strategy
- When reading a text file, if it exceeds 256KB, read_file will prompt you to use the offset/limit parameters to read it in chunks
- After a "File is too large" prompt, decide your strategy by need:
  - Need to understand the overall structure: read the first 200 lines (offset=0, limit=200) to get the gist
  - Need to find specific content: use search_files to locate it by keyword, then read the relevant region with offset/limit
  - Need a thorough analysis: read in multiple passes, 2000 lines at a time, processing section by section
- Don't try to read the entire contents of a large file at once

## Multi-turn conversation management
- In a long conversation, if you suspect earlier information may be stale (e.g. file contents may have changed), proactively re-fetch it rather than relying on old data
- When the user's question is clearly unrelated to the earlier context (a topic change), just respond concisely — no need to tie it back to the previous context
- If the context is compressed by the system, keep working normally; don't mention technical details like "the context was truncated"

## Error-recovery strategy
- When a tool call fails: analyze the cause and try a different approach (different params, different tool, different path); don't just retry the same operation
- After two consecutive failures: stop and tell the user what went wrong, with a suggestion
- Network-related errors: tell the user "the network seems unstable" and suggest trying again later
- Permission errors: clearly tell the user what permission is needed; don't keep retrying

## Using MCP tools
- When tools from a connected MCP service are available, prefer them over the built-in tool alternatives
- No need to explain the source before using an MCP tool — just call it
- If an MCP tool fails, you can fall back to the built-in tool`;
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
  /** No loop ran: the conversation already had a live loop, so the message was
   *  queued into it (see the concurrency guard at the top of runAgentLoop). */
  | 'enqueued';

/** Terminated by a safety guard rather than finishing the task — the result may
 *  be incomplete. Lets scheduler / trigger surface a meaningful status instead
 *  of treating these as either success or an opaque "Unknown error". */
export function isIncompleteReason(reason: AgentLoopExitReason): boolean {
  return reason === 'max_turns' || reason === 'no_progress';
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

/**
 * Calculate the escalated maxOutputTokens for a max_tokens recovery turn.
 *
 * A fixed 2× that PERSISTS for every recovery (recoveryCount >= 1), so the budget
 * sequence is base → 2× → 2× → 2×, clamped to contextWindowSize - 1000. Callers
 * recompute `currentMax` from base each turn, so the escalation must be a pure
 * function of `recoveryCount`. The old one-shot `alreadyEscalated` latch made the
 * budget fall back to base on later recoveries (base → 2× → base → base) — bug #5.
 *
 * The multiplier is deliberately NOT progressive (e.g. 2^recoveryCount): the
 * recovery prompt tells the model to break remaining work into smaller pieces, so
 * a single doubling suffices, and an ever-growing budget would compound the input
 * squeeze below. Note the unavoidable tradeoff: escalation raises maxOutputTokens,
 * which lowers maxInputTokens (= contextWindowSize - maxOutputTokens) for the whole
 * recovery sequence. On large windows this is negligible; on small windows it is
 * inherent to escalating output at all (the "break into smaller pieces" prompt, not
 * a bigger budget, is the real lever there). The clamp keeps ≥1000 input tokens.
 * Pure function, exported for testing.
 */
export function escalateMaxOutputTokens(
  currentMax: number,
  contextWindowSize: number,
  recoveryCount: number,
): { maxOutputTokens: number; changed: boolean } {
  if (recoveryCount <= 0) {
    return { maxOutputTokens: currentMax, changed: false };
  }
  const escalated = Math.min(currentMax * 2, contextWindowSize - 1000);
  if (escalated > currentMax) {
    return { maxOutputTokens: escalated, changed: true };
  }
  return { maxOutputTokens: currentMax, changed: false };
}

/**
 * Decide whether to continue the loop when a turn was cut off by max_tokens but
 * still carried complete tool calls. The Claude adapter only emits a tool_use
 * event on content_block_stop, so a call truncated mid-JSON is dropped — any
 * collected calls are complete; sending their results back lets the model resume
 * instead of the turn being discarded (legacy behavior excluded these entirely).
 *
 * We require at least one WELL-FORMED tool call (input without `_parse_error`). An
 * all-malformed batch is not real progress: continuing on it would re-prompt a
 * broken model indefinitely — agentLoop has no no-progress guard and maxTurns
 * defaults to unlimited. This mirrors the subagent's `allToolsUnparseable` guard
 * (see isNoProgressTurn). Pure, exported for testing.
 */
export function shouldContinueTruncatedToolCalls(
  stopReason: string,
  toolCalls: Array<{ input: Record<string, unknown> }>,
): boolean {
  return stopReason === 'max_tokens' && toolCalls.some((tc) => !('_parse_error' in tc.input));
}


export async function runAgentLoop(conversationId: string, userMessage: string, options?: AgentLoopOptions): Promise<AgentLoopResult> {
  // ── Concurrency guard: one live loop per conversation ────────────────────
  // The entry sequence below (clearAbortController → getAbortController)
  // replaces the controller WITHOUT aborting the previous loop, so a second
  // runAgentLoop on a running conversation would race it unstoppably (the UI's
  // isRunning check is React state and can lag a rapid double-send). Route the
  // message into the running loop's input queue instead — same behavior as
  // ChatInput's mid-task path. Interactive desktop only: headless callers
  // (scheduler / trigger / IM) manage their own conversations. Only stage when
  // there is stageable text and no images — the queue is text-only, and
  // silently losing an image is worse than the rare double-loop race, so
  // image/empty sends fall through to a normal loop start.
  {
    const runningConv = useChatStore.getState().conversations[conversationId];
    if (
      runningConv?.status === 'running'
      && useChatStore.getState().hasAbortController(conversationId)
      && isInteractiveDesktop(options, runningConv)
      && userMessage.trim().length > 0
      && !(options?.images?.length)
    ) {
      // Codex-style staging: the message lives in the cancellable queue strip
      // above the composer and becomes a transcript bubble only when the
      // running loop drains it (see the drainQueuedInputs block below).
      enqueueUserInput(conversationId, userMessage);
      return { reason: 'enqueued' };
    }
  }

  // New turn starts clean: drop any stale plan-mode lock from a prior/abandoned plan (see planMode.ts).
  clearPlanMode(conversationId);

  const chatStore = useChatStore.getState();
  const settings = useSettingsStore.getState();
  const taskExecutionStore = useTaskExecutionStore.getState();

  // ── Per-conversation model pin ──────────────────────────────────────────
  // A conversation runs on its own pinned model (conv.model); a new or legacy
  // conversation inherits the current global activeModel. Both the model name
  // and the provider identity (adapter / baseUrl / apiKey) derive from this one
  // pinned pair via `settingsForModel`, so they can never diverge and a global
  // model switch made for another conversation never bleeds into this in-flight
  // one. Pinned onto the conversation on first run (below) so it also survives
  // later global switches for display + future runs.
  const pinnedConv = chatStore.conversations[conversationId];
  const baseModel =
    pinnedConv?.model ??
    chatStore.conversationIndex[conversationId]?.model ??
    settings.activeModel;
  const settingsForModel: typeof settings =
    baseModel === settings.activeModel ? settings : { ...settings, activeModel: baseModel };

  // Generate a unique loopId for this agent loop - all messages in this loop share it
  const loopId = generateId();

  // Create EventRouter for this execution
  const eventRouter = createEventRouter({
    executionStore: taskExecutionStore,
    appendToolCallContext: (loopId, context) => {
      useChatStore.getState().appendToolCallContext(conversationId, loopId, context);
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
    const userContent = await buildUserMessageContent(conversationId, userMessage, options?.images);
    chatStore.addMessage(conversationId, {
      id: generateId(),
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
      loopId,
    });
    chatStore.addMessage(conversationId, {
      id: generateId(),
      role: 'assistant',
      content: getI18n().chat.configureApiKey,
      timestamp: Date.now(),
      loopId,
    });
    return { reason: 'error', error: 'API Key not configured' };
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

  // Build tool execution context — provides resolved workspace for tools like update_memory.
  // Priority: IM-injected path > conversation's own stored path > global store fallback.
  // Using the conversation record rather than the global store prevents cross-conversation
  // workspace leakage when multiple conversations are open simultaneously.
  const _convForContext = useChatStore.getState().conversations[conversationId];
  // Interactive-desktop conversations with no workspace get a managed default
  // (~/Abu/<name>/) bound here so the agent saves files there instead of
  // improvising (e.g. onto the Desktop). The folder is created lazily on the
  // first write. Headless contexts (IM / scheduled / trigger) are excluded —
  // they must not auto-create workspace directories.
  const toolContext: ToolExecutionContext = {
    workspacePath:
      options?.imContext?.workspacePath ??
      _convForContext?.workspacePath ??
      useWorkspaceStore.getState().currentPath,
    loopId,
    conversationId,
  };

  // Determine effective model — agent can override (with provider compatibility check)
  let effectiveModelId = getEffectiveModel(settingsForModel);
  if (route.type === 'agent' && route.definition?.model) {
    effectiveModelId = resolveAgentModel(route.definition.model, settings);
  }
  // Set active model for per-model token calibration
  setActiveModel(effectiveModelId);

  // Tell tools whether this model can consume images. read_file uses it to
  // avoid emitting base64 image blocks to text-only models (which bloats
  // context and triggers a 400 on providers that only accept text content).
  const entryModelDeclared = resolveModelDeclared(getActiveProvider(settingsForModel), effectiveModelId);
  toolContext.supportsVision = applyDeclaredCapabilities(
    resolveCapabilities(effectiveModelId),
    entryModelDeclared,
  ).vision;

  // Build static system prompt sections once (active skills are injected
  // dynamically per-turn). Built AFTER model resolution because the
  // capability prompt's visual-output section branches on the model's tool
  // support: no-tools models get the fence variant since tools=[] for them
  // (the per-turn `noTools` gate resolves the same declared value).
  const systemPromptSections = await buildSystemPromptSections(
    route,
    getCapabilityPrompt({ supportsTools: entryModelDeclared?.supportsTools !== false }),
    conversationId,
    options?.imContext,
    0,
  );

  // Pin the resolved model to the conversation on first run, so it survives
  // later global model switches (for display + future runs). Pins the
  // user-selected baseModel, NOT effectiveModelId (which may be agent-overridden
  // per-invocation). Skipped in enterprise mode (model selection is gateway-
  // scoped) and when the conversation already carries a pin.
  if (!isEnterpriseGatewayMode && pinnedConv && !pinnedConv.model) {
    useChatStore.getState().setConversationModel(conversationId, {
      providerId: baseModel.providerId,
      modelId: baseModel.modelId,
    });
  }

  // Add user message with loopId (use cleanInput for display)
  // Include skill info if a skill was triggered; build multimodal content if images are attached
  const userContent = await buildUserMessageContent(conversationId, route.cleanInput, options?.images);

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

  // Enterprise mode always uses OpenAI-compatible adapter (LiteLLM exposes that interface).
  const adapter: LLMAdapter = (isEnterpriseGatewayMode || getActiveProvider(settingsForModel)?.apiFormat === 'openai-compatible')
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
        content: format(getI18n().chat.skillMissingTools, { missing: missing.join(', ') }),
        timestamp: Date.now(),
        loopId,
      });
      chatStore.setConversationStatus(conversationId, 'idle');
      taskExecutionStore.cancelExecution(execution.id);
      return { reason: 'error', error: `Missing required tools: ${missing.join(', ')}` };
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
        parentConversationId: conversationId,
      });

      // Complete the delegate step
      subagentCleanup();
      chatStore.removeActiveAgent(delegateAgent.name);
      if (delegateStepId) {
        eventRouter.route({ type: 'step-end', loopId, stepId: delegateStepId, result: result.text });
      }

      // Add result as assistant message
      const delegateAssistantId = generateId();
      chatStore.addMessage(conversationId, {
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
      chatStore.finishStreaming(conversationId, delegateAssistantId);
      chatStore.clearAbortController(conversationId);
      eventRouter.route({ type: 'done', loopId, reason: 'delegate_complete' });
      persistExecutionSnapshot(conversationId, loopId);
      chatStore.setAgentStatus('idle');
      chatStore.setConversationStatus(conversationId, 'completed');
      // Delegate run completed without an LLMError → provider is healthy; clears
      // any stale config-failure recorded for it (mirrors the main-loop path).
      recordProviderCallOutcome(getActiveProvider(settingsForModel)?.id, { ok: true, at: Date.now() });

      const convTitle = useChatStore.getState().conversationIndex[conversationId]?.title ?? getI18n().chat.notificationTaskFallback;
      notifyTaskCompleted(convTitle, conversationId);
    } catch (err) {
      subagentCleanup();
      chatStore.removeActiveAgent(delegateAgent.name);
      chatStore.setAgentStatus('idle');
      // Treat retry-layer cancellation sentinel (LLMError code='cancelled', thrown
      // from retry.ts's abort-aware sleep) as a user abort, not a user-facing error.
      const isUserAbort = err instanceof Error
        && (err.name === 'AbortError'
          || abortController.signal.aborted
          || (err instanceof LLMError && err.code === 'cancelled'));
      if (isUserAbort) {
        chatStore.cancelStreaming(conversationId);
        chatStore.clearAbortController(conversationId);
        taskExecutionStore.cancelExecution(execution.id);
        chatStore.setConversationStatus(conversationId, 'idle');
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
      chatStore.addMessage(conversationId, {
        id: delegateErrorId,
        role: 'assistant',
        content: `**Error:** ${delegateDisplayError}`,
        timestamp: Date.now(),
        loopId,
      });
      chatStore.finishStreaming(conversationId, delegateErrorId);
      chatStore.clearAbortController(conversationId);
      eventRouter.route({ type: 'error', loopId, error: errorMessage });
      persistExecutionSnapshot(conversationId, loopId);
      chatStore.setConversationStatus(conversationId, 'error');
      const convTitle = useChatStore.getState().conversationIndex[conversationId]?.title ?? getI18n().chat.notificationTaskFallback;
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
  // Cache of filePath → base64 for image rehydration, shared across every turn
  // of this request's tool-use loop so a stripped image is read from disk once,
  // not re-read + re-encoded on every iteration (source.data stays stripped).
  const imageBase64Cache: ImageBase64Cache = new Map();
  // maxTurns priority: skill > agent definition > global setting > sane default
  // (never unlimited — see resolveMaxTurns). Headless runs get a tighter cap.
  const globalMaxTurns = useSettingsStore.getState().agentMaxTurns;
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
      chatStore.cancelStreaming(conversationId);
      chatStore.clearAbortController(conversationId);
      taskExecutionStore.cancelExecution(execution.id);
      deactivateAllSkills(conversationId);
      chatStore.setConversationStatus(conversationId, 'idle');
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
        lastMessageId: useChatStore.getState().conversations[conversationId]?.messages.slice(-1)[0]?.id ?? '',
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
      useChatStore.getState().addMessage(conversationId, {
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
      chatStore.addMessage(conversationId, {
        id: maxTurnsMsgId,
        role: 'assistant',
        content: format(getI18n().chat.maxTurnsReached, { n: maxTurns }),
        timestamp: Date.now(),
        loopId,
      });
      chatStore.finishStreaming(conversationId, maxTurnsMsgId);
      chatStore.clearAbortController(conversationId);
      eventRouter.route({ type: 'done', loopId, reason: 'max_turns' });
      persistExecutionSnapshot(conversationId, loopId);
      chatStore.setConversationStatus(conversationId, 'completed');
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
        closeAxSession().catch(() => {});
      }).catch(() => {});
      import('../session/checkpoint').then(({ clearCheckpoint }) => {
        clearCheckpoint(conversationId);
      }).catch(() => {});
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
    let modelSupportsVision = false;

    try {
      // ── Per-turn: refresh tools and dynamic prompt sections ──
      const freshSettings = useSettingsStore.getState();
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
      const { tools: rawTools, deferredTools: rawDeferredTools, inputValidators } = resolveTools(route, !!builtinWebSearch, options?.blockedTools, prefetchCtx);
      const tools = noTools ? [] : rawTools;
      const deferredTools = noTools ? [] : rawDeferredTools;
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
        ? useDiscoveredCapsStore.getState().get(activeProvider.id, effectiveModelId)
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
        } else if (!autoCompactTracker.isDisabled()) {
          // No valid cache AND the auto-compact circuit breaker is not tripped —
          // attempt compression. When the breaker IS tripped (repeated provider
          // failures/timeouts), skip the LLM call entirely; the deterministic
          // truncation (prepareContextMessages) below still guarantees the request
          // fits, so a doomed provider can't re-stall every turn.
          useChatStore.getState().setIsCompressing(conversationId, true);
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
                useChatStore.getState().setContextCache(conversationId, {
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
            useChatStore.getState().setIsCompressing(conversationId, false);
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
      useChatStore.getState().setContextUsage(conversationId, {
        percent: getUsagePercent(postCompressionTokens, contextWindowSize),
        tokensUsed: postCompressionTokens,
        tokensMax: contextWindowSize,
        overhead: systemAndToolsOverhead,
      });
      const trimmedMessages = trimOldScreenshots(messagesForContext, usagePercent);

      // Step 3: Hard truncation as safety net
      let preparedMessages = prepareContextMessages(
        trimmedMessages,
        effectiveSystemPrompt,
        contextWindowSize,
        maxOutputTokens,
        toolTokens
      );

      // Step 4: Rehydrate stripped image base64 from disk before sending.
      // Persisted images keep only `filePath` (base64 cleared to save disk); the
      // send path used the empty data directly, emitting `data:<mime>;base64,`
      // (empty) → provider "Invalid base64 image_url", bricking every later turn.
      // rehydrateForSend gates on vision + is the single shared send-prep seam
      // (see also the recovery retry below — both must use it).
      preparedMessages = await rehydrateForSend(preparedMessages, {
        vision: modelCaps.vision,
        conversationId,
        workspacePath: useChatStore.getState().conversations[conversationId]?.workspacePath ?? null,
        cache: imageBase64Cache,
      });

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
              useDiscoveredCapsStore
                .getState()
                .recordMaxOutputTokens(activeProvider.id, effectiveModelId, limit);
              logger.info('Persisted discovered max_tokens limit', {
                providerId: activeProvider.id,
                modelId: effectiveModelId,
                limit,
              });
            }
          : undefined,
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

              chatStore.setAgentStatus('tool-calling', event.name);

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
                chatStore.setCurrentUsage(event.usage);
              }
              break;

            case 'error':
              chatStore.appendToLastMessage(conversationId, `\n\n**Error:** ${event.error}`, assistantMsgId);
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
            chatStore.setRetryInfo({ attempt, maxAttempts, delayMs });
            if (error.code === 'rate_limit') {
              chatStore.setAgentStatus('rate-limited', `${Math.round(delayMs / 1000)}s`);
            }
            // Clear any partial content written before the stream failed so
            // the retry starts with a clean message instead of appending to
            // a truncated or corrupted response.
            flushTokenBuffer(conversationId, assistantMsgId);
            chatStore.setLastMessageContent(conversationId, '', assistantMsgId);
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
          if (ctxMatch && activeProvider) {
            const discoveredWindow = parseInt(ctxMatch[1], 10);
            if (Number.isFinite(discoveredWindow) && discoveredWindow > 0) {
              useDiscoveredCapsStore
                .getState()
                .recordContextWindow(activeProvider.id, effectiveModelId, discoveredWindow);
              logger.info('Persisted discovered context window', {
                providerId: activeProvider.id,
                modelId: effectiveModelId,
                contextWindow: discoveredWindow,
              });
            }
          }

          chatStore.appendToLastMessage(
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
              const compressionResult = await compressContextIfNeeded(
                historyMessages,
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

          // Retry with recovered messages. These were rebuilt from the stripped
          // store copies (compression / round-slicing above), so re-run the same
          // send-prep seam the primary path uses — otherwise a vision model would
          // get empty-base64 images silently dropped on this path.
          preparedMessages = await rehydrateForSend(preparedMessages, {
            vision: modelCaps.vision,
            conversationId,
            workspacePath: useChatStore.getState().conversations[conversationId]?.workspacePath ?? null,
            cache: imageBase64Cache,
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
        const turnMsg = useChatStore.getState().conversations[conversationId]?.messages.find(m => m.id === assistantMsgId);
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
        useChatStore.getState().updateMessageUsage(conversationId, finalUsage, assistantMsgId);
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
              : (useChatStore.getState().conversations[conversationId]?.activeSkills?.[0] ?? null),
            {
              inputTokens: usageSnapshot.inputTokens,
              outputTokens: usageSnapshot.outputTokens,
              cacheReadInputTokens: usageSnapshot.cacheReadInputTokens,
              cacheCreationInputTokens: usageSnapshot.cacheCreationInputTokens,
            },
          );
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
          const { tools: freshRawTools } = resolveTools(route, !!builtinWebSearch, options?.blockedTools);
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

      // L4: learn that a statically-non-reasoning model actually reasons, so future
      // turns bound it (treated as 'uncontrollable' → full budget + reserved content).
      // Skip if the user explicitly declared supportsReasoning=false — their declaration
      // takes precedence over runtime observation.
      if (collectedThinking && modelCaps.thinking === false && activeProvider
          && modelDeclared?.supportsReasoning !== false) {
        useDiscoveredCapsStore.getState().recordReasoningObserved(activeProvider.id, effectiveModelId);
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
      if (allToolsUnparseable(collectedToolCalls)) {
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
        // A new user directive is a fresh start: restore the full no-progress
        // tolerance budget so the rescue actually buys the intended retries, not
        // just one more turn before the (still-3) counter trips again.
        consecutiveNoProgress = 0;
      }

      if (!continueLoop) {
        // Surface why we stopped when it was the no-progress guard, so the user
        // doesn't mistake a degenerate stop for a finished answer (mirrors the
        // max_tokens-exhausted marker above).
        if (noProgressAborted) {
          chatStore.appendToLastMessage(
            conversationId,
            `\n\n${getI18n().chat.noProgressStopped}`,
            assistantMsgId,
          );
        }
        chatStore.finishStreaming(conversationId, assistantMsgId);
        chatStore.clearAbortController(conversationId);
        const endReason = noProgressAborted
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
          closeAxSession().catch(() => {});
        }).catch(() => {});
        // Clear crash recovery checkpoint — loop completed normally
        import('../session/checkpoint').then(({ clearCheckpoint }) => {
          clearCheckpoint(conversationId);
        }).catch(() => {});
        // Mark conversation status — error if recovery exhausted, otherwise completed.
        // no_progress is a soft stop (visible marker, status completed) like maxTurns.
        if (maxTokensRecoveryExhausted) {
          exitReason = 'error';
          exitError = 'Max output tokens recovery exhausted';
        } else if (noProgressAborted) {
          exitReason = 'no_progress';
        }
        chatStore.setConversationStatus(conversationId, maxTokensRecoveryExhausted ? 'error' : 'completed');
  
        // Interactive-desktop gate: user-visible conversations only.
        // IM conversations, scheduled tasks, triggers run headless — the
        // user can't see skill proposal cards / review memory extractions,
        // so any autonomous write from these contexts would silently
        // pollute the workspace. Both memory extraction AND self-evolution
        // proposals share this gate (they're two sides of the same
        // "agent writes stuff only when user can review" invariant).
        const convRecord = chatStore.conversations[conversationId];
        const interactiveDesktop = isInteractiveDesktop(options, convRecord);

        // Auto-extract memories from desktop conversations (non-blocking).
        // IM conversations have their own extraction in channelRouter.ts.
        if (interactiveDesktop) {
          const wsPath = convRecord?.workspacePath ?? useWorkspaceStore.getState().currentPath;
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
        const wsPath = convRecord?.workspacePath ?? useWorkspaceStore.getState().currentPath;
        if (
          exitReason === 'completed' &&
          shouldComputeProposalSignal(options, convRecord, wsPath)
        ) {
          try {
            const { computeProposalSignal } = await import('./proposalSignal');
            const { useSettingsStore } = await import('../../stores/settingsStore');
            const proactivity =
              useSettingsStore.getState().soul?.proactivity ?? 'companion';
            const loopMsgs = (convRecord?.messages ?? []).filter((m) => m.loopId === loopId);
            const signal = computeProposalSignal(loopMsgs, proactivity);
            if (signal) {
              chatStore.setPendingProposalSignal(conversationId, signal);
            }
          } catch (err) {
            logger.warn('[proposalSignal] compute failed', { err: err instanceof Error ? err.message : String(err) });
          }
        }
        const convTitle = useChatStore.getState().conversationIndex[conversationId]?.title ?? getI18n().chat.notificationTaskFallback;
        notifyTaskCompleted(convTitle, conversationId);
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
        flushTokenBuffer(conversationId, assistantMsgId);

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
        // Surface staged (non-system) queue messages as transcript user bubbles
        // before clearing — the aborted loop can't answer them, but the text
        // must remain visible instead of being silently destroyed.
        for (const qi of drainQueuedInputs(conversationId)) {
          if (qi.isSystem) continue;
          useChatStore.getState().addMessage(conversationId, {
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

        // Drop the untouched placeholder BEFORE cancelStreaming: an abort that
        // arrived before any text/thinking/tool call would otherwise persist as
        // a blank assistant bubble (live now, and after reload via the JSONL
        // copy written at creation — sanitizeLoadedMessages drops that one).
        const placeholder = useChatStore.getState().conversations[conversationId]
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
          if (isGhost) chatStore.deleteMessage(conversationId, assistantMsgId);
        }

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
        // Close any open AX session (releases CFRetain'd element refs)
        import('../tools/definitions/computerTools').then(({ closeAxSession }) => {
          closeAxSession().catch(() => {});
        }).catch(() => {});
        // Set status back to idle on cancel
        chatStore.setConversationStatus(conversationId, 'idle');

        endConversationTrace(conversationId, { output: { reason: 'aborted' } });
        return { reason: 'aborted' as const };
      }

      clearLoopContext(loopId);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = err instanceof LLMError ? err.code : undefined;
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
        reportError('agent_crash', 'unknown', undefined, effectiveModelId, errorMessage);
      }
      logger.info('Agent loop ended', { conversationId, loopId, turnCount, reason: 'error' });

      // Friendly message when a 400 error is likely caused by image content
      // sent to a model that doesn't support vision
      const isLikelyVisionError = isVisionUnsupportedError(
        errorCode,
        err instanceof LLMError ? err.statusCode : undefined,
        conversationHasImages(useChatStore.getState().conversations[conversationId]?.messages ?? []),
        modelSupportsVision,
      );
      const isOllamaForbidden = errorCode === 'authentication'
        && err instanceof LLMError && err.statusCode === 403
        && /^forbidden\s*$/i.test(err.message.trim());
      const isEnterpriseGatewayUnavailable = err instanceof EnterpriseLlmUnavailableError;
      let displayError = isEnterpriseGatewayUnavailable
        ? getI18n().chat.gatewayUnreachable
        : isLikelyVisionError
        ? getI18n().chat.visionUnsupported
        : isOllamaForbidden
        ? getI18n().chat.ollamaForbidden
        : formatLlmDisplayError(err, errorMessage, getI18n().chat.errorEmptyBody);
      if (errorCode === 'not_found') {
        displayError += `\n\n${getI18n().chat.errorNotFoundHint}`;
      }

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
      // Close any open AX session (releases CFRetain'd element refs)
      import('../tools/definitions/computerTools').then(({ closeAxSession }) => {
        closeAxSession().catch(() => {});
      }).catch(() => {});
      // Clear crash recovery checkpoint — loop ended with error
      import('../session/checkpoint').then(({ clearCheckpoint }) => {
        clearCheckpoint(conversationId);
      }).catch(() => {});
      // Mark conversation as error and send notification
      chatStore.setConversationStatus(conversationId, 'error');

      const convTitle = useChatStore.getState().conversationIndex[conversationId]?.title ?? getI18n().chat.notificationTaskFallback;
      notifyTaskError(convTitle, conversationId);
      exitReason = 'error';
      exitError = errorMessage;
      continueLoop = false;
    }
  }
  endConversationTrace(conversationId, { output: { reason: exitReason }, error: exitError });
  return { reason: exitReason, error: exitError };
}
