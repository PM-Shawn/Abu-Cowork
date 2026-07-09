/**
 * EventRouter - Unified event handling for Agent execution
 *
 * Responsibilities:
 * - Parse AgentEvent from LLM adapters
 * - Create/update ExecutionStep
 * - Generate DetailBlock
 * - Sync update to TaskExecutionStore and ChatStore
 * - Capture intermediate results to Scratchpad
 */

import type {
  AgentEvent,
  ExecutionStep,
  DetailBlock,
  StepType,
  StepSource,
  StepStartPayload,
  ToolCallContext,
} from '../../types/execution';
import type { TaskExecutionStore } from '../../stores/taskExecutionStore';
import {
  useScratchpadStore,
  shouldCaptureScratchpad,
  inferScratchpadType,
  generateScratchpadTitle,
  truncateScratchpadContent,
} from '../../stores/scratchpadStore';
import { parseSearchResults } from '../../utils/searchParser';
import { isToolResultError } from '../../utils/workflowExtractor';
import { getToolLabel } from '../../utils/toolLabels';
import { TOOL_NAMES } from '../tools/toolNames';

// --- Helper Functions ---

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// --- Tool Classification ---

const FILE_READ_TOOLS: string[] = [TOOL_NAMES.READ_FILE, 'read', 'get_file_contents'];
const FILE_WRITE_TOOLS: string[] = [TOOL_NAMES.WRITE_FILE, 'write', TOOL_NAMES.EDIT_FILE, 'edit'];
const FILE_CREATE_TOOLS: string[] = ['create_file', 'create'];
const COMMAND_TOOLS: string[] = [TOOL_NAMES.RUN_COMMAND, 'bash', 'execute', 'shell'];
const SEARCH_TOOLS: string[] = ['search', 'grep', 'find', TOOL_NAMES.WEB_SEARCH, TOOL_NAMES.SEARCH_FILES, TOOL_NAMES.FIND_FILES];
const SKILL_TOOLS: string[] = [TOOL_NAMES.USE_SKILL];
const DELEGATE_TOOLS: string[] = [TOOL_NAMES.DELEGATE_TO_AGENT];

/**
 * Check if a tool is an MCP tool (format: serverName__toolName)
 */
function isMCPTool(toolName: string): boolean {
  return toolName.includes('__');
}

/**
 * Parse MCP tool name into server and tool parts
 */
function parseMCPToolName(toolName: string): { serverName: string; actualToolName: string } | null {
  if (!isMCPTool(toolName)) return null;
  const sepIndex = toolName.indexOf('__');
  return {
    serverName: toolName.substring(0, sepIndex),
    actualToolName: toolName.substring(sepIndex + 2),
  };
}

/**
 * Check if a tool is the use_skill tool
 */
function isSkillTool(toolName: string): boolean {
  return SKILL_TOOLS.includes(toolName);
}

/**
 * Infer step source from tool name
 */
function inferStepSource(toolName: string): StepSource {
  if (isMCPTool(toolName)) return 'mcp';
  if (isSkillTool(toolName)) return 'skill';
  return 'agent';
}

function inferStepType(toolName: string): StepType {
  // For MCP tools, use the actual tool name (after colon)
  const mcpParts = parseMCPToolName(toolName);
  const actualName = mcpParts ? mcpParts.actualToolName : toolName;

  if (FILE_READ_TOOLS.includes(actualName)) return 'file-read';
  if (FILE_WRITE_TOOLS.includes(actualName)) return 'file-write';
  if (FILE_CREATE_TOOLS.includes(actualName)) return 'file-create';
  if (COMMAND_TOOLS.includes(actualName)) return 'command';
  if (SEARCH_TOOLS.includes(actualName)) return 'search';
  if (SKILL_TOOLS.includes(actualName)) return 'skill';
  if (DELEGATE_TOOLS.includes(actualName)) return 'delegate';
  // MCP tools default to 'mcp' type
  if (isMCPTool(toolName)) return 'mcp';
  return 'tool';
}

// --- Detail Block Creation ---

function createScriptBlock(stepId: string, toolName: string, toolInput: Record<string, unknown>, locale: string = 'zh'): DetailBlock | null {
  const isZh = locale.startsWith('zh');

  // Command tools - show command
  if (COMMAND_TOOLS.includes(toolName)) {
    const command = (toolInput.command || toolInput.cmd) as string | undefined;
    if (!command) return null;

    return {
      id: `${stepId}-script`,
      stepId,
      type: 'script',
      label: isZh ? '脚本' : 'Script',
      labelKey: 'script',
      content: command,
      language: 'bash',
      isTruncated: false,
      isExpanded: false,
    };
  }

  // File tools - show path and content for write/edit
  if (FILE_WRITE_TOOLS.includes(toolName) || FILE_CREATE_TOOLS.includes(toolName)) {
    const path = (toolInput.path || toolInput.file_path) as string | undefined;
    const content = toolInput.content as string | undefined;

    if (content) {
      // Detect language from file extension
      const ext = path?.split('.').pop()?.toLowerCase();
      const languageMap: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        py: 'python',
        rs: 'rust',
        go: 'go',
        json: 'json',
        md: 'markdown',
        css: 'css',
        html: 'html',
        sh: 'bash',
      };

      return {
        id: `${stepId}-script`,
        stepId,
        type: 'script',
        label: isZh ? '内容' : 'Content',
        labelKey: 'content',
        content: content.length > 1000 ? content.slice(0, 1000) : content,
        language: ext ? languageMap[ext] : undefined,
        isTruncated: content.length > 1000,
        fullContentLength: content.length > 1000 ? content.length : undefined,
        isExpanded: false,
      };
    }
  }

  return null;
}

function createResultBlock(stepId: string, result: string, toolName: string, locale: string = 'zh'): DetailBlock {
  const isZh = locale.startsWith('zh');
  const maxLength = 1000;
  const isTruncated = result.length > maxLength;
  // Detect real tool errors using shared utility (prefix match, not full-text search)
  const isError = isToolResultError(result);

  // Check if result is structured JSON (for web_search, MCP tools, etc.)
  let parsedItems: DetailBlock['parsedItems'];
  let blockType: DetailBlock['type'] = isError ? 'error' : 'result';
  let language: string | undefined;

  // Try to parse search results from SEARCH_JSON marker or raw JSON
  if (toolName === TOOL_NAMES.WEB_SEARCH || toolName === 'search') {
    const results = parseSearchResults(result);
    if (results) {
      parsedItems = results.map((item) => ({
        title: item.title || '',
        url: item.url,
        description: item.snippet || '',
      }));
      blockType = 'list';
    }
  }

  // For MCP tools, try to detect and format JSON results
  if (isMCPTool(toolName) && !isError) {
    try {
      // Check if result looks like JSON
      const trimmed = result.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        JSON.parse(trimmed); // Validate JSON
        blockType = 'json';
        language = 'json';
      }
    } catch {
      // Not valid JSON, keep as result type
    }
  }

  return {
    id: `${stepId}-result`,
    stepId,
    type: blockType,
    label: isError ? (isZh ? '错误' : 'Error') : (isZh ? '结果' : 'Result'),
    labelKey: isError ? 'error' : 'result',
    content: isTruncated ? result.slice(0, maxLength) : result,
    language,
    parsedItems,
    isTruncated,
    fullContentLength: isTruncated ? result.length : undefined,
    isExpanded: false,
  };
}

// --- Event Router Class ---

export interface EventRouterDeps {
  executionStore: TaskExecutionStore;
  /** Callback to append tool call context to ChatStore */
  appendToolCallContext?: (loopId: string, context: ToolCallContext) => void;
}

export class EventRouter {
  private deps: EventRouterDeps;
  private locale: string;
  private thinkingStartTime: number | null = null;

  constructor(deps: EventRouterDeps, locale: string = 'zh') {
    this.deps = deps;
    this.locale = locale;
  }

  /**
   * Route an AgentEvent to the appropriate handler
   */
  async route(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'execution-start':
        this.handleExecutionStart(event);
        break;

      case 'thinking-start':
        this.handleThinkingStart(event);
        break;

      case 'thinking-delta':
        this.handleThinkingDelta(event);
        break;

      case 'thinking-end':
        this.handleThinkingEnd(event);
        break;

      case 'step-start':
        this.handleStepStart(event);
        break;

      case 'step-progress':
        this.handleStepProgress(event);
        break;

      case 'step-end':
        this.handleStepEnd(event);
        break;

      case 'step-error':
        this.handleStepError(event);
        break;

      case 'text-delta':
        // Text delta is handled by ChatStore directly
        break;

      case 'usage':
        this.handleUsage(event);
        break;

      case 'done':
        this.handleDone(event);
        break;

      case 'error':
        this.handleError(event);
        break;
    }
  }

  // --- Event Handlers ---

  private handleExecutionStart(event: Extract<AgentEvent, { type: 'execution-start' }>) {
    const { loopId, conversationId } = event;
    this.deps.executionStore.createExecution(conversationId, loopId);
  }

  private handleThinkingStart(_event: Extract<AgentEvent, { type: 'thinking-start' }>) {
    this.thinkingStartTime = Date.now();
  }

  private handleThinkingDelta(event: Extract<AgentEvent, { type: 'thinking-delta' }>) {
    const { loopId, content } = event;
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (execution) {
      this.deps.executionStore.appendThinking(execution.id, content);
    }
  }

  private handleThinkingEnd(event: Extract<AgentEvent, { type: 'thinking-end' }>) {
    const { loopId, duration } = event;
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (execution) {
      // Use provided duration or calculate from start time
      const actualDuration = duration || (this.thinkingStartTime
        ? Math.round((Date.now() - this.thinkingStartTime) / 1000)
        : 0);
      this.deps.executionStore.setThinkingDuration(execution.id, actualDuration);
    }
    this.thinkingStartTime = null;
  }

  private handleStepStart(event: Extract<AgentEvent, { type: 'step-start' }>) {
    const { loopId, step } = event;
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (!execution) return;

    const stepId = generateId();
    const { label, detail } = getToolLabel(step.toolName, step.toolInput, this.locale);

    const newStep: ExecutionStep = {
      id: stepId,
      executionId: execution.id,
      type: inferStepType(step.toolName),
      label,
      detail,
      status: 'running',
      toolName: step.toolName,
      toolInput: step.toolInput,
      source: step.source || 'agent',
      skillName: step.skillName,
      mcpServer: step.mcpServer,
      detailBlocks: [],
      startTime: Date.now(),
    };

    // Add script block if applicable
    const scriptBlock = createScriptBlock(stepId, step.toolName, step.toolInput, this.locale);
    if (scriptBlock) {
      newStep.detailBlocks.push(scriptBlock);
    }

    this.deps.executionStore.addStep(execution.id, newStep);
  }

  private handleStepProgress(_event: Extract<AgentEvent, { type: 'step-progress' }>) {
    // Future: implement progress tracking for batch operations
  }

  private handleStepEnd(event: Extract<AgentEvent, { type: 'step-end' }>) {
    const { loopId, stepId, result, resultContent } = event;
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (!execution) return;

    const step = execution.steps.find((s) => s.id === stepId);
    if (!step) return;

    // Update step result
    this.deps.executionStore.setStepResult(execution.id, stepId, result);

    // Add result block for delegate steps — show summary instead of hiding content
    if (step.type === 'delegate') {
      const isZh = this.locale.startsWith('zh');
      const isError = isToolResultError(result);
      // Truncate delegate result to a readable summary (first 500 chars)
      const maxSummaryLen = 500;
      const summary = result.length > maxSummaryLen
        ? result.slice(0, maxSummaryLen) + '...'
        : result;
      const summaryBlock: DetailBlock = {
        id: `${stepId}-result`,
        stepId,
        type: isError ? 'error' : 'result',
        label: isError ? (isZh ? '错误' : 'Error') : (isZh ? '执行摘要' : 'Result Summary'),
        labelKey: isError ? 'error' : 'summary',
        content: summary,
        isTruncated: result.length > maxSummaryLen,
        isExpanded: isError,
      };
      this.deps.executionStore.addDetailBlock(execution.id, stepId, summaryBlock);
    } else {
      // Add image block if resultContent contains images
      if (resultContent && Array.isArray(resultContent)) {
        const imageBlock = resultContent.find(b => b.type === 'image');
        if (imageBlock && imageBlock.type === 'image') {
          const isZh = this.locale.startsWith('zh');
          const imgDetailBlock: DetailBlock = {
            id: `${stepId}-image`,
            stepId,
            type: 'image',
            label: isZh ? '图片' : 'Image',
            labelKey: 'image',
            content: result,
            imageData: { mediaType: imageBlock.source.media_type, base64: imageBlock.source.data },
            isTruncated: false,
            isExpanded: true,
          };
          this.deps.executionStore.addDetailBlock(execution.id, stepId, imgDetailBlock);
        }
      }
      const resultBlock = createResultBlock(stepId, result, step.toolName, this.locale);
      this.deps.executionStore.addDetailBlock(execution.id, stepId, resultBlock);
    }

    // Capture to scratchpad if applicable
    if (shouldCaptureScratchpad(step.toolName, result)) {
      const entryType = inferScratchpadType(step.toolName);
      if (entryType) {
        const path = (step.toolInput.path || step.toolInput.file_path || step.toolInput.filePath) as string | undefined;
        useScratchpadStore.getState().addEntry({
          conversationId: execution.conversationId,
          title: generateScratchpadTitle(step.toolName, step.toolInput, entryType),
          type: entryType,
          content: truncateScratchpadContent(result),
          sourceFile: path,
          toolName: step.toolName,
        });
      }
    }

    // Sync to ChatStore for LLM context (preserve resultContent for images/screenshots)
    if (this.deps.appendToolCallContext) {
      this.deps.appendToolCallContext(loopId, {
        name: step.toolName,
        input: step.toolInput,
        result,
        ...(resultContent ? { resultContent } : {}),
      });
    }
  }

  private handleStepError(event: Extract<AgentEvent, { type: 'step-error' }>) {
    const { loopId, stepId, error } = event;
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (!execution) return;

    const step = execution.steps.find((s) => s.id === stepId);
    if (!step) return;

    // Update step error
    this.deps.executionStore.setStepError(execution.id, stepId, error);

    // Add error block
    const isZh = this.locale.startsWith('zh');
    const errorBlock: DetailBlock = {
      id: `${stepId}-error`,
      stepId,
      type: 'error',
      label: isZh ? '错误' : 'Error',
      labelKey: 'error',
      content: error,
      isTruncated: false,
      isExpanded: true,  // Errors are expanded by default
    };
    this.deps.executionStore.addDetailBlock(execution.id, stepId, errorBlock);

    // Sync to ChatStore for LLM context
    if (this.deps.appendToolCallContext) {
      this.deps.appendToolCallContext(loopId, {
        name: step.toolName,
        input: step.toolInput,
        result: `Error: ${error}`,
      });
    }
  }

  private handleUsage(event: Extract<AgentEvent, { type: 'usage' }>) {
    const { loopId, usage } = event;
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (execution) {
      this.deps.executionStore.setUsage(execution.id, usage);
    }
  }

  private handleDone(event: Extract<AgentEvent, { type: 'done' }>) {
    const { loopId } = event;
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (execution) {
      this.deps.executionStore.completeExecution(execution.id);
    }
  }

  private handleError(event: Extract<AgentEvent, { type: 'error' }>) {
    const { loopId, error } = event;
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (execution) {
      this.deps.executionStore.errorExecution(execution.id, error);
    }
  }

  /**
   * Get the current step ID for a loopId (useful for tool execution tracking)
   */
  getCurrentStepId(loopId: string): string | null {
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (!execution) return null;
    const runningStep = execution.steps.find((s) => s.status === 'running');
    return runningStep?.id || null;
  }

  /**
   * Add a child step to a delegate parent step (for subagent tool visualization)
   * Returns the child step ID
   */
  addChildStepToDelegate(loopId: string, parentStepId: string, payload: StepStartPayload): string | null {
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (!execution) return null;

    const childId = generateId();
    const { label, detail } = getToolLabel(payload.toolName, payload.toolInput, this.locale);

    const childStep: ExecutionStep = {
      id: childId,
      executionId: execution.id,
      type: inferStepType(payload.toolName),
      label,
      detail,
      status: 'running',
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      source: payload.source || inferStepSource(payload.toolName),
      detailBlocks: [],
      startTime: Date.now(),
    };

    this.deps.executionStore.addChildStep(execution.id, parentStepId, childStep);
    return childId;
  }

  /**
   * Complete a child step with result or error
   */
  completeChildStep(loopId: string, parentStepId: string, childStepId: string, result: string, error: boolean): void {
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (!execution) return;
    this.deps.executionStore.updateChildStep(execution.id, parentStepId, childStepId, result, error);
  }

  /**
   * Create a step and return its ID (for use when tool_use event doesn't have step-start)
   */
  createStepForToolUse(loopId: string, payload: StepStartPayload): string | null {
    const execution = this.deps.executionStore.getExecutionByLoopId(loopId);
    if (!execution) return null;

    const stepId = generateId();
    const { label, detail } = getToolLabel(payload.toolName, payload.toolInput, this.locale);

    // Auto-detect source from tool name if not provided
    const source = payload.source || inferStepSource(payload.toolName);

    // Auto-detect MCP server from tool name
    const mcpParts = parseMCPToolName(payload.toolName);
    const mcpServer = payload.mcpServer || (mcpParts ? mcpParts.serverName : undefined);

    // Auto-detect skill name from use_skill tool input
    let skillName = payload.skillName;
    if (isSkillTool(payload.toolName) && !skillName) {
      skillName = payload.toolInput.skill_name as string | undefined;
    }

    const stepType = inferStepType(payload.toolName);

    const newStep: ExecutionStep = {
      id: stepId,
      executionId: execution.id,
      type: stepType,
      label,
      detail,
      status: 'running',
      toolName: payload.toolName,
      toolInput: payload.toolInput,
      source,
      skillName,
      mcpServer,
      detailBlocks: [],
      startTime: Date.now(),
    };

    // Set agentName for delegate steps
    if (stepType === 'delegate') {
      newStep.agentName = payload.toolInput.agent_name as string | undefined;
    }

    // Add script block if applicable
    const scriptBlock = createScriptBlock(stepId, payload.toolName, payload.toolInput, this.locale);
    if (scriptBlock) {
      newStep.detailBlocks.push(scriptBlock);
    }

    this.deps.executionStore.addStep(execution.id, newStep);
    return stepId;
  }
}

// --- Factory Function ---

export function createEventRouter(deps: EventRouterDeps, locale?: string): EventRouter {
  return new EventRouter(deps, locale);
}
