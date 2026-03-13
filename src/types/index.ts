// ============================================================
// ABU — Core Type Definitions
// ============================================================

// --- Messages & Conversations ---

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
}

// Simplified tool call info for LLM context building
export interface ToolCallForContext {
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
  contextCache?: ContextCache;  // Ephemeral compression cache (not persisted)
}

// --- Agent ---

export type AgentStatus = 'idle' | 'thinking' | 'tool-calling' | 'streaming';

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
  items?: { type: string };  // For array types
  [key: string]: unknown;    // Allow extra JSON Schema fields (e.g. default, properties)
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

// --- LLM ---

export type LLMProvider = 'volcengine' | 'bailian' | 'anthropic' | 'openai' | 'deepseek' | 'moonshot' | 'zhipu' | 'siliconflow' | 'qiniu' | 'openrouter' | 'local' | 'custom';

// --- Provider Capabilities ---

export type BuiltinSearchMethod =
  | { type: 'tool'; toolSpec: Record<string, unknown> }       // Complete tool object, injected into tools array
  | { type: 'parameter'; paramName: string; paramValue: unknown }; // Body parameter injection

export interface ProviderCapabilities {
  webSearch?: BuiltinSearchMethod;
  imageGen?: boolean;
}

export type ApiFormat = 'anthropic' | 'openai-compatible';

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

export interface SkillMetadata {
  name: string;
  description: string;
  trigger?: string;           // When to auto-invoke, e.g. "用户要求深度调研某个主题"
  doNotTrigger?: string;      // When NOT to auto-invoke, e.g. "用户只是随口问个简单问题"
  userInvocable?: boolean;
  disableAutoInvoke?: boolean;
  argumentHint?: string;
  allowedTools?: string[];    // Whitelist filter — only these tools are available to the LLM
  requiredTools?: string[];   // Must be available or skill execution is blocked
  model?: string;
  maxTurns?: number;          // Max agent loop turns (default 20, increase for browsing-heavy skills)
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
  maxTurns?: number;
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
