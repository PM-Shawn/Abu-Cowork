// ============================================================
// ABU — Task Execution Type Definitions
// ============================================================

import type { TokenUsage } from './index';

// --- Step Types ---

export type StepType =
  | 'thinking'
  | 'tool'
  | 'skill'
  | 'file-read'
  | 'file-write'
  | 'file-create'
  | 'command'
  | 'search'
  | 'mcp'
  | 'delegate';

export type StepStatus = 'pending' | 'running' | 'completed' | 'error';

export type StepSource = 'agent' | 'skill' | 'mcp';

// --- Detail Block Types ---

export type DetailBlockType =
  | 'script'   // Command/code
  | 'result'   // Plain text result
  | 'error'    // Error message
  | 'info'     // Meta information
  | 'preview'  // File preview
  | 'list'     // Clickable list (e.g., search results)
  | 'json'     // Structured JSON
  | 'diff'     // File diff
  | 'table'    // Table data
  | 'image';   // Image content (base64)

/**
 * List item for 'list' type DetailBlock
 */
export interface ListItem {
  title: string;
  url?: string;
  description?: string;
  icon?: string;
}

/**
 * Table data for 'table' type DetailBlock
 */
export interface TableData {
  headers: string[];
  rows: string[][];
}

/**
 * Detail Block - Collapsible content area
 */
export interface DetailBlock {
  id: string;
  stepId: string;

  // Type and label
  type: DetailBlockType;
  label: string;

  // Content
  content: string;
  language?: string;  // bash, json, typescript, etc.

  // Extended fields for list type
  parsedItems?: ListItem[];

  // Extended fields for table type
  tableData?: TableData;

  // Extended fields for image type
  imageData?: { mediaType: string; base64: string };

  // Long content handling
  isTruncated: boolean;
  fullContentLength?: number;

  // UI state (persisted)
  isExpanded: boolean;
}

// --- Execution Step ---

/**
 * Execution Step - Complete information for a tool call
 */
export interface ExecutionStep {
  id: string;
  executionId: string;

  // Display info
  type: StepType;
  label: string;
  detail?: string;

  // Status
  status: StepStatus;

  // Tool call details
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult?: string;
  errorMessage?: string;

  // Source tracking
  source: StepSource;
  skillName?: string;  // When source is 'skill'
  mcpServer?: string;  // When source is 'mcp'

  // Detail blocks (for UI expansion)
  detailBlocks: DetailBlock[];

  // Delegate (subagent) support
  agentName?: string;         // When type is 'delegate'
  childSteps?: ExecutionStep[];  // Nested steps from subagent

  // Timing
  startTime?: number;
  endTime?: number;
  duration?: number;
}

// --- Task Execution ---

export type ExecutionStatus = 'running' | 'completed' | 'error' | 'cancelled';

/**
 * Planned Step - AI-generated execution plan item
 */
export interface PlannedStep {
  index: number;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  linkedStepId?: string;  // Link to actual ExecutionStep when matched
}

/**
 * Task Execution - Complete state for one Agent Loop
 */
export interface TaskExecution {
  id: string;
  conversationId: string;
  loopId: string;

  // Lifecycle
  status: ExecutionStatus;
  startTime: number;
  endTime?: number;

  // AI-generated execution plan
  plannedSteps: PlannedStep[];
  planParsed: boolean;

  // Steps list
  steps: ExecutionStep[];

  // Metadata
  thinking?: string;
  thinkingDuration?: number;
  usage?: TokenUsage;

  // For future nested executions (Subagent support)
  parentExecutionId?: string;
}

// --- Agent Events ---

/**
 * Unified Agent Event types for event routing
 */
export type AgentEvent =
  | { type: 'execution-start'; loopId: string; conversationId: string }
  | { type: 'thinking-start'; loopId: string }
  | { type: 'thinking-delta'; loopId: string; content: string }
  | { type: 'thinking-end'; loopId: string; duration: number }
  | { type: 'step-start'; loopId: string; step: StepStartPayload }
  | { type: 'step-progress'; loopId: string; stepId: string; progress: number }
  | { type: 'step-end'; loopId: string; stepId: string; result: string; resultContent?: import('./index').ToolResultContent[] }
  | { type: 'step-error'; loopId: string; stepId: string; error: string }
  | { type: 'text-delta'; loopId: string; content: string }
  | { type: 'usage'; loopId: string; usage: TokenUsage }
  | { type: 'done'; loopId: string; reason: string }
  | { type: 'error'; loopId: string; error: string };

/**
 * Payload for step-start event
 */
export interface StepStartPayload {
  toolName: string;
  toolInput: Record<string, unknown>;
  source?: StepSource;
  skillName?: string;
  mcpServer?: string;
}

// --- Execution Step Snapshot (for persistence on Message) ---

/** Compact snapshot of ExecutionStep for persistence on Message.
 *  Omits large fields (toolInput, toolResult) to keep payload small. */
export interface ExecutionStepSnapshot {
  id: string;
  type: StepType;
  label: string;
  status: 'completed' | 'error';
  toolName: string;
  duration?: number;
  completionMessage?: string;
  // Delegate support
  agentName?: string;
  childSteps?: ExecutionStepSnapshot[];
  // Detail block stubs (with truncated content for post-eviction display)
  detailBlocks?: { id: string; title: string; type: DetailBlockType; content?: string }[];
}

// --- Tool Call Context (for LLM history) ---

/**
 * Simplified tool call info for LLM context building
 */
export interface ToolCallContext {
  name: string;
  input: Record<string, unknown>;
  result: string;
}
