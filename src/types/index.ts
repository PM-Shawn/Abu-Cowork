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
 * Discriminated union of card types. Extend by adding a new `type`
 * literal + matching payload field (optional so narrowing by `type`
 * tells TS which payload to read).
 */
export type NoticeCardType = 'skill-proposal' | 'skill-patched';

export interface InteractiveNoticeCard {
  type: NoticeCardType;
  /**
   * Stable ID per card. For skill-proposal this equals the skill name
   * (used by settleCardsForSkill to find peer cards). For skill-patched
   * it's `${skillName}@${timestamp}` — patch cards don't need peer
   * settling, but do need unique IDs so rapid successive patches don't
   * collapse visually.
   */
  id: string;
  skillProposal?: SkillProposalPayload;
  skillPatched?: SkillPatchedPayload;
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
  // System-injected messages (e.g. max_tokens recovery) — hidden from chat UI
  isSystem?: boolean;
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
  enabledMCPServers?: string[];  // Per-session MCP server filter (undefined = all enabled)
  scheduledTaskId?: string;  // If set, this conversation was created by a scheduled task
  triggerId?: string;  // If set, this conversation was created by a trigger
  imChannelId?: string;  // If set, this conversation was created by an IM channel
  imPlatform?: string;  // IM platform name (dchat/feishu/dingtalk/wecom/slack)
  projectId?: string;  // If set, this conversation belongs to a project
  contextCache?: ContextCache;  // Ephemeral compression cache (not persisted)
  contextWarningLevel?: 0 | 1 | 2 | 3;  // Ephemeral context usage warning level (not persisted)
  /**
   * Post-loop proposal nudge, stashed by agentLoop completion when the
   * last loop was "sink-worthy" (see `proposalSignal.ts`). Read by the
   * next turn's orchestrator and cleared immediately — single-shot, not
   * persisted across sessions.
   */
  pendingProposalSignal?: import('../core/agent/proposalSignal').ProposalSignal;
}

// --- Agent ---

export type AgentStatus = 'idle' | 'thinking' | 'tool-calling' | 'streaming' | 'rate-limited';

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

export type LLMProvider = 'volcengine' | 'bailian' | 'anthropic' | 'openai' | 'deepseek' | 'moonshot' | 'zhipu' | 'minimax' | 'siliconflow' | 'qiniu' | 'openrouter' | 'ollama' | 'local' | 'custom';

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
export type { ProviderSource, ProviderStatus, ModelCapability, ModelInfo, ProviderInstance, ActiveModel, AuxiliaryServices, ProviderGuide } from './provider';

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
  | 'draft';

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

export interface SubagentMetadata {
  name: string;
  description: string;
  avatar?: string;
  model?: string;
  maxTurns?: number;          // Optional cap on subagent loop turns. Falls back to global settings; ultimate fallback is 200 for safety.
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  memory?: 'session' | 'project' | 'user';
  background?: boolean;
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
