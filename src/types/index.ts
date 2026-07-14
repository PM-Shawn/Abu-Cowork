// ============================================================
// ABU — Core Type Definitions
// ============================================================

// --- Messages & Conversations ---

// ─── Interactive Notice Cards (Module I) ───────────────────────────────
//
// Cards render inline in the chat stream right after the tool call that
// produced them. They're the user-facing UI for "agent wants to do X,
// click to confirm". The source of truth is the tool's JSON result —
// chat renderer parses `notice_card` out of the stringified result and
// renders a React component per card.type.
//
// Action persistence lives in the tool call's `noticeCardAction` field
// (serialized with conversation state), so reloading the conversation
// preserves the "already accepted/rejected" UI state.

// 'deferred' (Task #43): user dismissed the card without committing to
// accept/reject. The draft stays on disk and remains actionable from the
// drafts panel — "稍后处理" just clears the in-chat card. Settled cards
// in 'deferred' state get flipped by later panel actions (see
// settleCardsForSkill's guard).
export type NoticeCardAction = 'accepted' | 'rejected' | 'rejected-category' | 'deferred';

/** Payload for a "save this as a skill?" proposal card. */
export interface SkillProposalPayload {
  skillName: string;
  /** Short description from SKILL.md frontmatter. */
  description: string;
  /** Agent's one-line reason for proposing ("6 步任务完成"). */
  triggerReason?: string;
  /** Absolute path to the draft SKILL.md, so the card can click-through to files. */
  draftPath: string;
  /** Full SKILL.md content for the expand-to-preview UI. */
  fullContent: string;
  /**
   * Workspace captured at proposal time. Carried on the card so accept /
   * reject clicks work even after the global workspaceStore has drifted
   * (e.g. user reopened an old conversation whose conv.workspacePath was
   * never bound, and chatStore.setActiveConversation cleared the store).
   */
  workspacePath: string;
}

/**
 * Payload for an "agent silently patched a skill" notice. Not
 * interactive — just a visibility surface so users don't find their
 * skill behavior mutated without a trace. Future Task #24 can hang a
 * "view diff" button off this payload without schema changes.
 */
export interface SkillPatchedPayload {
  skillName: string;
  /** Absolute path to the file that got patched (usually SKILL.md). */
  filePath: string;
  /** One-line summary of what changed ("replaced step 3", "added guard"). */
  summary?: string;
  /** Workspace captured at patch time — same rationale as proposal card. */
  workspacePath: string;
}

/**
 * Payload for a "Abu deleted this skill" notice (Task #17 · v2 delete).
 * Read-only surface — destructive action already happened, we just let
 * the user see it. workspace-auto deletes are permanent; draft deletes
 * go to trash (7-day recovery), indicated by `rescuable`.
 */
export interface SkillDeletedPayload {
  skillName: string;
  /** Absolute directory that was removed (or moved to trash). */
  skillDir: string;
  /** The skill's source before delete (workspace-auto | draft). */
  source: 'workspace-auto' | 'draft';
  /** True when the delete went to trash and can still be recovered. */
  rescuable: boolean;
  /** Workspace captured at delete time. */
  workspacePath: string;
}

/**
 * Discriminated union of card types. Extend by adding a new `type`
 * literal + matching payload field (optional so narrowing by `type`
 * tells TS which payload to read).
 */
export type NoticeCardType = 'skill-proposal' | 'skill-patched' | 'skill-deleted';

export interface InteractiveNoticeCard {
  type: NoticeCardType;
  /**
   * Stable ID per card. For skill-proposal this equals the skill name
   * (used by settleCardsForSkill to find peer cards). For skill-patched
   * and skill-deleted it's `${skillName}@${timestamp}` — those cards
   * don't need peer settling, but do need unique IDs so rapid
   * successive actions don't collapse visually.
   */
  id: string;
  skillProposal?: SkillProposalPayload;
  skillPatched?: SkillPatchedPayload;
  skillDeleted?: SkillDeletedPayload;
}

// --- ask_user_question — interactive choice cards ---

export interface UserQuestionOption {
  label: string;
  description?: string;
}

export interface UserQuestion {
  question: string;
  header: string;                // ≤12 chars short label
  multiSelect: boolean;
  options: UserQuestionOption[]; // 2-4 options
}

export interface UserQuestionPayload {
  questions: UserQuestion[];     // 1-4 questions
  /** Two-step confirm mode (e.g. plan approval): clicking a single-select
   * option only selects it — submission requires the explicit confirm button.
   * Guards destructive approvals against click-through. */
  confirm?: boolean;
}

/** Single-question answer: selected labels, or custom free text (Other…) */
export interface UserQuestionAnswerItem {
  header: string;
  question: string;
  selected: string[];            // single-select length=1; multi-select ≥1; other=custom text
}

export interface UserQuestionResult {
  answers: UserQuestionAnswerItem[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  resultContent?: ToolResultContent[];  // Rich content for LLM (images etc.)
  isExecuting?: boolean;
  isError?: boolean;   // Whether tool execution resulted in an error
  startTime?: number;  // Timestamp when tool execution started
  endTime?: number;    // Timestamp when tool execution completed
  hidden?: boolean;    // Hidden from UI (e.g., report_plan)
  hideScreenshot?: boolean;  // If true, screenshot thumbnails hidden from chat UI (still sent to LLM)
  /**
   * Interactive notice card attached to this tool call (e.g. a
   * "save as skill?" proposal). Populated from the tool's JSON result
   * when present. Chat renderer picks it up and renders the card right
   * below the tool's regular output.
   */
  noticeCard?: InteractiveNoticeCard;
  /**
   * User's action on the notice card, if any. Persisted with the
   * conversation so reopening shows the settled state. Absence means
   * "card still actionable" — absence is the normal state for fresh
   * cards until the user clicks a button.
   */
  noticeCardAction?: NoticeCardAction;
  /**
   * User's answers to an ask_user_question tool call. Set once the user
   * submits — drives settled read-only rendering. undefined = still
   * interactive (waiting for the user to answer).
   */
  userQuestionAnswers?: UserQuestionResult;
}

// Multimodal content types for messages
export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
  filePath?: string;  // Disk path for persistence — base64 data is stripped on persist, filePath survives
}

export interface DocumentContent {
  type: 'document';
  source: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
}

export type MessageContent = TextContent | ImageContent | DocumentContent;

// Attachment for images added via paste/drag in the input
export interface ImageAttachment {
  id: string;
  data: string;        // base64 data (no prefix)
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

// Thinking block for extended thinking
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  // Support both simple string and multimodal content array
  content: string | MessageContent[];
  timestamp: number;
  isStreaming?: boolean;
  toolCalls?: ToolCall[];
  // Extended thinking content
  thinking?: string;
  // Thinking duration in seconds
  thinkingDuration?: number;
  // Token usage for this message
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  // Loop identifier - messages in the same agent loop share this ID
  loopId?: string;
  // Skill information - when message triggers or uses a skill
  skill?: {
    name: string;
    description?: string;
  };
  // Delegate agent information - when message is directed to a sub-agent via @agent
  delegateAgent?: {
    name: string;
    description?: string;
  };
  // Tool call context for LLM history (simplified, read-only)
  toolCallsForContext?: ToolCallForContext[];
  // Persisted execution steps snapshot (for post-restart rich display)
  executionSteps?: import('./execution').ExecutionStepSnapshot[];
  // Persisted planned steps snapshot (for post-restart plan display in TaskProgressPanel)
  plannedSteps?: import('./execution').PlannedStep[];
  // System-injected messages (e.g. max_tokens recovery) — hidden from chat UI
  isSystem?: boolean;
  // Compaction boundary marker payload (long-conversation Part A). Present only
  // on marker messages (id prefix `compact-boundary-`). The message is appended
  // to the log and never rewrites earlier entries; the send-side rebuilds a
  // compact context from the LAST marker.
  compactBoundary?: CompactBoundary;
}

/**
 * Compaction boundary marker payload (long-conversation Part A).
 *
 * Persisted append-only as a Message (id prefix `compact-boundary-`). Original
 * messages are NEVER rewritten or truncated — the send-side rebuilds a compact
 * context on the fly by honouring the last marker. Range is expressed with
 * message-id anchors (not array indices) so a deleted message invalidates the
 * marker cleanly instead of silently shifting the summarized window.
 */
export interface CompactBoundary {
  /** LLM-generated summary of the messages between the two anchors (inclusive). */
  summaryText: string;
  /** id of the first summarized message. */
  summarizedFromId: string;
  /** id of the last summarized message. */
  summarizedToId: string;
  /** Marker creation time (ms). */
  createdAt: number;
  /** Whether this boundary was created automatically or via manual /compact. */
  source: 'auto' | 'manual';
}

// Simplified tool call info for LLM context building
export interface ToolCallForContext {
  id?: string;  // Tool call ID for API tool_use/tool_result pairing (optional for backward compat)
  name: string;
  input: Record<string, unknown>;
  result: string;
  resultContent?: ToolResultContent[];  // Preserve images (screenshots) for LLM vision
}

// --- Conversation Status ---

export type ConversationStatus = 'idle' | 'running' | 'completed' | 'error';

/** Cached context compression result (ephemeral, not persisted) */
export interface ContextCache {
  summaryMessage: Message;
  /** Index range [start, end) of original messages covered by the summary */
  summarizedRange: [number, number];
  /** messages.length at the time of compression — cache is stale if messages shrink */
  messageCountAtCompression: number;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
  status: ConversationStatus;
  completedAt?: number;
  activeSkills?: string[];  // Skill names active in this conversation
  activeSkillArgs?: Record<string, string>;  // Per-skill invocation arguments
  workspacePath?: string | null;  // Workspace bound to this conversation
  model?: { providerId: string; modelId: string };  // Model pinned to this conversation (undefined = inherit global activeModel; pinned on first run)
  permissionMode?: import('../core/permissions/permissionMode').PermissionMode;  // Per-conversation override (undefined = inherit global permissionMode)
  enabledMCPServers?: string[];  // Per-session MCP server filter (undefined = all enabled)
  scheduledTaskId?: string;  // If set, this conversation was created by a scheduled task
  triggerId?: string;  // If set, this conversation was created by a trigger
  imChannelId?: string;  // If set, this conversation was created by an IM channel
  imPlatform?: string;  // IM platform name (dchat/feishu/dingtalk/wecom/slack)
  projectId?: string;  // If set, this conversation belongs to a project
  contextCache?: ContextCache;  // Ephemeral compression cache (not persisted)
  // Ephemeral context usage state — NOT persisted (excluded by JSONL writer + chatStore partialize).
  // Published by agentLoop each turn from post-compression tokens. ContextIndicator
  // derives the live water-level from this baseline + estimateMessageTokens(messages),
  // so streaming output and post-restart history view both stay accurate without
  // waiting for the next agent-loop iteration.
  contextUsage?: {
    percent: number;      // 0–100+; round(tokensUsed / contextWindow * 100)
    tokensUsed: number;   // post-compression input tokens (system + tools + messages snapshot)
    tokensMax: number;    // contextWindow (NOT contextWindow - reservedOutput — users expect the published model window)
    // System prompt + tool schema overhead. Stored so the indicator can compute
    // live = overhead + estimateMessageTokens(messagesNow) without a second
    // agent-loop pass. Empirically ~7-8k for Abu; absent on first-open (use fallback).
    overhead?: number;
  };
  isCompressing?: boolean;  // True while compressContextIfNeeded is awaiting LLM
  /**
   * Post-loop proposal nudge, stashed by agentLoop completion when the
   * last loop was "sink-worthy" (see `proposalSignal.ts`). Read by the
   * next turn's orchestrator and cleared immediately — single-shot, not
   * persisted across sessions.
   */
  pendingProposalSignal?: import('../core/agent/proposalSignal').ProposalSignal;
  /**
   * True if this conversation was imported from a shared bundle (.abu.json).
   * Read-only — user cannot continue the conversation. Persisted via
   * ConversationMeta (index.json) so the flag survives restarts.
   */
  readOnly?: boolean;
  /**
   * Provenance of an imported share bundle. Populated during import alongside
   * `readOnly: true`. Persisted via ConversationMeta.
   */
  importedFrom?: {
    schemaVersion: number;
    importedAt: number;
  };
  /**
   * Ephemeral — NOT persisted (excluded by chatStore's `partialize`, which
   * never persists the `conversations` map at all; only `conversationIndex`
   * is). Set by `chatStore.ensureFullyLoaded()` once `conv.messages` is
   * guaranteed to hold the complete on-disk history rather than a possible
   * window (message-storage P1 Step 5/8-9). Consumers that must not
   * silently under-count (export/share, RightPanel stats) check this flag
   * before trusting `messages.length`.
   */
  __fullyLoaded?: boolean;
}

// --- Agent ---

export type AgentStatus = 'idle' | 'thinking' | 'tool-calling' | 'streaming' | 'rate-limited';

/** Live retry state surfaced to the UI so a stalled/flaky provider isn't silent. */
export interface RetryInfo {
  /** 1-based attempt number of the retry that is about to happen. */
  attempt: number;
  /** Best-effort max attempts for this error class. */
  maxAttempts: number;
  /** Delay before the next attempt, in ms. */
  delayMs: number;
}

// --- Tool Results ---

// Rich content blocks for tool results (images, text)
export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

// Tool execute return type: simple string or rich content array
export type ToolResult = string | ToolResultContent[];

// --- Tools ---

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  items?: { type: string; enum?: string[]; properties?: Record<string, ToolParameter>; required?: string[] };  // For array types
  [key: string]: unknown;    // Allow extra JSON Schema fields (e.g. default, properties)
}

/** Runtime context passed to tool execute(), e.g. the effective workspace for this conversation */
export interface ToolExecutionContext {
  /** Resolved workspace path (from IMContext or global store) */
  workspacePath?: string | null;
  /** Loop ID for multi-agent context lookup */
  loopId?: string;
  /** Conversation ID — tools should prefer this over activeConversationId */
  conversationId?: string;
  /** Tool call ID — injected by toolExecutor; lets a tool locate itself and key per-call state (e.g. run_agent_batch progress) */
  toolCallId?: string;
  /**
   * Whether the active model supports vision/image input, resolved from the
   * turn's model capabilities. When explicitly `false`, tools that would emit
   * image content (e.g. read_file on an image) must return a text note instead
   * — a base64 image both bloats context and gets rejected (400) by text-only
   * providers. Undefined means "unknown / assume capable" (default behavior).
   */
  supportsVision?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  execute: (input: Record<string, unknown>, context?: ToolExecutionContext) => Promise<ToolResult>;
  /**
   * Whether this tool can safely execute in parallel with other concurrent-safe tools.
   * - `true` or returns `true`: tool only reads data, no side effects
   * - `false` or returns `false`: tool writes data, needs exclusive execution
   * - `undefined`: defaults to `false` (fail-closed)
   *
   * Can be a static boolean or a function that inspects the input (e.g., run_command
   * checks if the command is read-only).
   */
  isConcurrencySafe?: boolean | ((input: Record<string, unknown>) => boolean);
}

// --- LLM ---

export type LLMProvider = 'volcengine' | 'bailian' | 'anthropic' | 'openai' | 'deepseek' | 'moonshot' | 'zhipu' | 'minimax' | 'siliconflow' | 'qiniu' | 'openrouter' | 'xiaomi' | 'ollama' | 'lmstudio' | 'local' | 'custom';

// --- Provider Capabilities ---

export type BuiltinSearchMethod =
  | { type: 'tool'; toolSpec: Record<string, unknown> }       // Complete tool object, injected into tools array
  | { type: 'parameter'; paramName: string; paramValue: unknown }; // Body parameter injection

export interface ProviderCapabilities {
  webSearch?: BuiltinSearchMethod;
  imageGen?: boolean;
}

export type ApiFormat = 'anthropic' | 'openai-compatible';

/** User-saved custom AI service configuration (legacy — kept for migration) */
export interface CustomService {
  id: string;
  name: string;
  baseUrl: string;
  apiFormat: ApiFormat;
  model: string;
  apiKey: string;
}

// Re-export V2 provider types
export type { ProviderSource, ProviderStatus, ModelCapability, ModelInfo, ProviderInstance, ActiveModel, AuxiliaryServices, ProviderGuide, DeclaredCapabilities } from './provider';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}

// Token usage information
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; result: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; stopReason: string; usage?: TokenUsage }
  | { type: 'error'; error: string };

// --- Skill ---

export interface SkillHookEntry {
  matcher: string;  // Tool name pattern
  hooks: Array<{
    type: 'command';
    command: string;
  }>;
}

// Skill source — where the skill was loaded from.
//
// Priority order (first-win; earlier scans beat later ones on name collision):
//   1. project            — {workspace}/.abu/skills/, git-shareable
//   2. project-standard   — {workspace}/.agents/skills/, git-shareable cross-client
//   3. workspace-auto     — ~/.abu/projects/<key>/skills/, agent-auto-written for this project
//   4. draft              — ~/.abu/projects/<key>/skills/drafts/, pending user review
//   5. user               — ~/.abu/skills/, user's personal global
//   6. standard           — ~/.agents/skills/, cross-client global
//   7. builtin            — bundled with Abu, read-only
//
// Agent is allowed to create/modify only `workspace-auto` and (with confirm) `user`
// scopes — everything else is read-only to the agent (see PRD 2.4).
export type SkillSource =
  | 'builtin'
  | 'user'
  | 'standard'
  | 'project'
  | 'project-standard'
  | 'workspace-auto'
  | 'draft'
  | 'enterprise';

/**
 * User-facing skill categories surfaced in the Toolbox. This is a
 * coarser taxonomy than SkillSource: it groups several on-disk
 * sources into one mental-model bucket. The Toolbox never shows
 * SkillSource directly to users — it always goes through
 * `sourceToUXCategory()` first.
 */
export type SkillUXCategory =
  | 'mine'           // user / standard / project / project-standard
  | 'agent-evolved'  // workspace-auto / draft
  | 'builtin';       // bundled with Abu

export interface SkillMetadata {
  name: string;
  description: string;
  source?: SkillSource;       // Where this skill was discovered (set by loader)
  trigger?: string;           // When to auto-invoke, e.g. "用户要求深度调研某个主题"
  doNotTrigger?: string;      // When NOT to auto-invoke, e.g. "用户只是随口问个简单问题"
  userInvocable?: boolean;
  disableAutoInvoke?: boolean;
  argumentHint?: string;
  allowedTools?: string[];    // Whitelist filter — only these tools are available to the LLM
  blockedTools?: string[];    // Blacklist filter — these tools are hidden from the LLM
  requiredTools?: string[];   // Must be available or skill execution is blocked
  model?: string;
  maxTurns?: number;          // Optional cap on agent loop turns. Falls back to global settings; if global also unset, runs unlimited.
  context?: 'inline' | 'fork';
  tags?: string[];
  agent?: string;             // Fork mode subagent type
  preloadSkills?: string[];   // Fork mode: preload other skills' content
  hooks?: {
    PreToolUse?: SkillHookEntry[];
    PostToolUse?: SkillHookEntry[];
  };
  // Agent Skills spec compatibility fields
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
}

export interface Skill extends SkillMetadata {
  content: string;
  filePath: string;
  skillDir: string;           // Absolute path to SKILL.md's parent directory
  chain?: string[];  // Chain skill names to auto-activate
}

// --- Subagent ---

/** Locale code used for i18n overrides. Mirrors SupportedLocale from i18n/types.ts
 *  — declared inline here to avoid pulling the i18n module into core agent code. */
type AgentLocale = 'zh-CN' | 'en-US';

export interface SubagentMetadata {
  /** Canonical name — primary key in agentRegistry, also the `@mention` token. */
  name: string;
  /** Default-locale description shown in toolbox / agent selector. */
  description: string;
  avatar?: string;
  model?: string;
  maxTurns?: number;          // Optional cap on subagent loop turns. Falls back to global settings; ultimate fallback is 200 for safety.
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  memory?: 'session' | 'project' | 'user';
  background?: boolean;

  // ── Display-only fields (rendered by toolbox AgentsSection / chat welcome banner)
  //   All optional. User-defined agents can fill any subset; builtins ship full data.

  /** Per-locale display names. UI renders `displayNames[locale] ?? name`. Also
   *  used as `@mention` aliases — an en-US user can type `@product-manager` and
   *  it routes to the same agent as `@产品经理`. */
  displayNames?: Partial<Record<AgentLocale, string>>;
  /** Per-locale description overrides (falls back to `description`). */
  descriptions?: Partial<Record<AgentLocale, string>>;
  /** Self-introduction paragraph shown on the chat welcome screen when this
   *  agent is the pending one. Default locale. */
  intro?: string;
  /** Per-locale intro overrides (falls back to `intro`). */
  intros?: Partial<Record<AgentLocale, string>>;
  /** What this agent is good at — 3-5 bullet items shown in toolbox detail. */
  expertise?: string[];
  expertiseI18n?: Partial<Record<AgentLocale, string[]>>;
  /** Suggested opening questions — clicking one starts a chat pre-filled with it. */
  samplePrompts?: string[];
  samplePromptsI18n?: Partial<Record<AgentLocale, string[]>>;
  /** Free-form category slug for grouping (no enforced taxonomy). */
  category?: string;
  /** Short tags shown as chips in toolbox list / agent selector. */
  tags?: string[];
  tagsI18n?: Partial<Record<AgentLocale, string[]>>;
}

export interface SubagentDefinition extends SubagentMetadata {
  systemPrompt: string;
  filePath: string;
}

// --- Web Search ---

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;       // domain name
  publishedDate?: string;
}

export interface WebSearchResponse {
  query: string;
  results: SearchResult[];
}

// --- Settings ---

export interface AppSettings {
  provider: LLMProvider;
  model: string;
  apiKey: string;
  theme: 'dark' | 'light';
}
