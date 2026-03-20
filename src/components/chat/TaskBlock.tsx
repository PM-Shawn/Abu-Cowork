import { useState, useMemo, useEffect, useRef } from 'react';
import {
  Clock,
  FileSearch,
  FilePen,
  FilePlus,
  Wrench,
  Wand2,
  Terminal,
  Globe,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Check,
  Loader2,
  AlertCircle,
  Info,
  RotateCcw,
  Search,
  Plug,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { WorkflowStep, StepType } from '@/utils/workflowExtractor';
import type { ExecutionStep, DetailBlock, StepType as ExecStepType } from '@/types/execution';
import { generateCompletionMessage } from '@/utils/workflowExtractor';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import DetailBlockView from './DetailBlockView';

// Unified step type for rendering
type UnifiedStep = {
  id: string;
  type: StepType | ExecStepType;
  label: string;
  detail?: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  duration?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  completionMessage?: string;
  // New: detail blocks from ExecutionStep
  detailBlocks?: DetailBlock[];
  // Reference to original execution for toggle actions
  executionId?: string;
  // Delegate (subagent) support
  agentName?: string;
  childSteps?: UnifiedStep[];
};

// Icon mapping for step types
const stepIcons: Record<string, React.ElementType> = {
  thinking: Clock,
  'file-read': FileSearch,
  'file-write': FilePen,
  'file-create': FilePlus,
  tool: Wrench,
  skill: Wand2,
  command: Terminal,
  search: Search,
  mcp: Plug,  // MCP tools use Plug icon
  delegate: Users,  // Delegate/subagent icon
};

// Get icon for specific tool names
function getStepIcon(step: UnifiedStep): React.ElementType {
  if (step.detail?.includes(TOOL_NAMES.LIST_DIRECTORY) || step.label.includes('目录') || step.label.includes('directory')) {
    return FolderOpen;
  }
  if (step.label.includes('搜索') || step.label.includes('search') || step.type === 'search') {
    return Globe;
  }
  if (step.label.includes('系统信息') || step.label.includes('system')) {
    return Info;
  }
  return stepIcons[step.type] || Wrench;
}

// Get type label for step (displayed on the right side like Cowork's "Script")
function getTypeLabel(step: UnifiedStep, t: TranslationDict): string | null {
  switch (step.type) {
    case 'thinking':
      return null; // Thinking shows duration instead
    case 'file-read':
      return t.task.typeRead;
    case 'file-write':
      return t.task.typeWrite;
    case 'file-create':
      return t.task.typeCreate;
    case 'command':
      return t.task.typeScript;
    case 'skill':
      return t.task.typeSkill;
    case 'mcp':
      return 'MCP';  // MCP tools show "MCP" label
    case 'delegate':
      return t.task.typeDelegate;
    case 'tool':
      return t.task.typeTool;
    case 'search':
      return t.task.typeSearch;
    default:
      return null;
  }
}

// Generate summary title from steps (with translations)
function generateSummary(steps: UnifiedStep[], t: TranslationDict, locale: string, isActive: boolean): string {
  const actions: string[] = [];
  const separator = locale.startsWith('zh') ? '，' : ', ';

  const skillStep = steps.find((s) => s.type === 'skill');
  if (skillStep) {
    actions.push(skillStep.label);
  }

  let readCount = 0;
  let writeCount = 0;
  let createCount = 0;
  let commandCount = 0;
  let otherCount = 0;

  for (const step of steps) {
    if (step.type === 'thinking' || step.type === 'skill') continue;
    if (step.type === 'file-read') readCount++;
    else if (step.type === 'file-write') writeCount++;
    else if (step.type === 'file-create') createCount++;
    else if (step.type === 'command') commandCount++;
    else otherCount++;
  }

  if (skillStep) {
    const toolCount = readCount + writeCount + createCount + commandCount + otherCount;
    if (toolCount > 0) {
      actions.push(format(t.task.executedOperations, { count: toolCount }));
    }
  } else {
    if (createCount > 0) {
      actions.push(createCount === 1 ? t.task.createdFile : format(t.task.createdFiles, { count: createCount }));
    }
    if (writeCount > 0) {
      actions.push(writeCount === 1 ? t.task.modifiedFile : format(t.task.modifiedFiles, { count: writeCount }));
    }
    if (readCount > 0) {
      actions.push(readCount === 1 ? t.task.readFile : format(t.task.readFiles, { count: readCount }));
    }
    if (commandCount > 0) {
      actions.push(commandCount === 1 ? t.task.executedCommand : format(t.task.executedCommands, { count: commandCount }));
    }
    if (otherCount > 0) {
      actions.push(otherCount === 1 ? t.task.calledTool : format(t.task.calledTools, { count: otherCount }));
    }
  }

  if (actions.length > 0) return actions.join(separator);
  // Fallback: show "处理中..." only when actively running, otherwise show completed text
  return isActive ? t.task.processing : t.task.completed;
}

// Convert WorkflowStep to UnifiedStep
function convertWorkflowStep(step: WorkflowStep): UnifiedStep {
  return {
    id: step.id,
    type: step.type,
    label: step.label,
    detail: step.detail,
    status: step.status,
    duration: step.duration,
    toolName: step.toolName,
    toolInput: step.toolInput,
    toolResult: step.toolResult,
  };
}

// Convert ExecutionStep to UnifiedStep (recursive for childSteps)
function convertExecutionStep(step: ExecutionStep): UnifiedStep {
  return {
    id: step.id,
    type: step.type,
    label: step.label,
    detail: step.detail,
    status: step.status,
    duration: step.duration,
    toolName: step.toolName,
    toolInput: step.toolInput,
    toolResult: step.toolResult,
    detailBlocks: step.detailBlocks,
    executionId: step.executionId,
    agentName: step.agentName,
    childSteps: step.childSteps?.map(convertExecutionStep),
  };
}

interface TaskBlockProps {
  steps?: WorkflowStep[];
  executionSteps?: ExecutionStep[];
  isActive: boolean;
  onRetry?: () => void;
}

/**
 * TaskBlock component - Cowork-style workflow display with timeline
 * Supports both legacy WorkflowStep[] and new ExecutionStep[]
 */
// Number of steps shown in preview mode
const PREVIEW_LIMIT = 3;

type DisplayMode = 'collapsed' | 'preview' | 'expanded';

export default function TaskBlock({ steps, executionSteps, isActive, onRetry }: TaskBlockProps) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>('collapsed');
  const { t, locale } = useI18n();

  // Auto-collapse when execution finishes (isActive: true → false)
  const prevIsActiveRef = useRef(isActive);
  useEffect(() => {
    if (prevIsActiveRef.current && !isActive) {
      setDisplayMode('collapsed');
    }
    prevIsActiveRef.current = isActive;
  }, [isActive]);

  // Convert to unified steps
  const unifiedSteps = useMemo(() => {
    if (executionSteps && executionSteps.length > 0) {
      return executionSteps.map(convertExecutionStep);
    }
    if (steps && steps.length > 0) {
      return steps.map(convertWorkflowStep);
    }
    return [];
  }, [steps, executionSteps]);

  const completedCount = unifiedSteps.filter((s) => s.status === 'completed').length;
  const allCompleted = completedCount === unifiedSteps.length && unifiedSteps.length > 0 && !isActive;
  const hasError = unifiedSteps.some((s) => s.status === 'error');
  const summary = useMemo(() => generateSummary(unifiedSteps, t, locale, isActive), [unifiedSteps, t, locale, isActive]);

  // Determine which steps to display based on mode
  const isOpen = displayMode !== 'collapsed';
  const needsTruncation = unifiedSteps.length > PREVIEW_LIMIT;
  const visibleSteps = (displayMode === 'preview' && needsTruncation)
    ? unifiedSteps.slice(0, PREVIEW_LIMIT)
    : unifiedSteps;

  const handleHeaderClick = () => {
    if (allCompleted && !hasError) {
      // Completed: toggle between collapsed and fully expanded (skip preview)
      setDisplayMode(displayMode === 'collapsed' ? 'expanded' : 'collapsed');
    } else {
      setDisplayMode(displayMode === 'collapsed' ? 'preview' : 'collapsed');
    }
  };

  const handleShowMore = () => {
    setDisplayMode('expanded');
  };

  const handleCollapse = () => {
    setDisplayMode('preview');
  };

  if (unifiedSteps.length === 0) return null;

  return (
    <div className="task-block mb-4">
      {/* Summary Header */}
      {allCompleted && !hasError ? (
        // Minimal completed header — single text line, no icons
        <button
          onClick={handleHeaderClick}
          className="flex items-center gap-1 text-[13px] text-[#a8a49a] hover:text-[#8b887c] transition-colors mb-2"
        >
          <span>{summary}</span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform',
              !isOpen && '-rotate-90'
            )}
          />
        </button>
      ) : (
        // Active / error header — with animated dots and chevron
        <button
          onClick={handleHeaderClick}
          className="flex items-center gap-1.5 text-[13px] text-[#656358] hover:text-[#29261b] transition-colors mb-2"
        >
          <span>{isActive ? summary.replace(/\.{3}$/, '').replace(/…$/, '') : summary}</span>
          {isActive && (
            <span className="inline-flex items-center gap-[3px] ml-0.5">
              <span className="typing-dot w-[3px] h-[3px] rounded-full bg-[#d97757]" />
              <span className="typing-dot w-[3px] h-[3px] rounded-full bg-[#d97757]" />
              <span className="typing-dot w-[3px] h-[3px] rounded-full bg-[#d97757]" />
            </span>
          )}
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform',
              !isOpen && '-rotate-90'
            )}
          />
        </button>
      )}

      {/* Flow Timeline */}
      {isOpen && visibleSteps.length > 0 && (
        <div className="flow-timeline pl-1">
          {visibleSteps.map((step, index) => {
            const isLastVisible = index === visibleSteps.length - 1;
            // Show connector if not the last visible step, or if there are trailing nodes
            const hasTrailingNodes = allCompleted || isActive || hasError;
            const isFullyExpanded = displayMode === 'expanded' || !needsTruncation;
            const showConnector = !isLastVisible || (isFullyExpanded && hasTrailingNodes);

            return (
              <TaskStepItem
                key={step.id}
                step={step}
                showConnector={showConnector}
                locale={locale}
                t={t}
              />
            );
          })}

          {/* Show more / Collapse toggle */}
          {needsTruncation && (
            <div className="flex items-start gap-3">
              <div className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0 pb-2">
                {displayMode === 'preview' ? (
                  <button
                    onClick={handleShowMore}
                    className="text-[12px] text-[#d97757] hover:text-[#c5684a] transition-colors"
                  >
                    {t.task.showMore}
                  </button>
                ) : (
                  <button
                    onClick={handleCollapse}
                    className="text-[12px] text-[#d97757] hover:text-[#c5684a] transition-colors"
                  >
                    {t.task.collapse}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Done node — only in fully expanded or no truncation needed */}
          {allCompleted && (displayMode === 'expanded' || !needsTruncation) && (
            <div className="flex items-start gap-3">
              <div className="w-3.5 h-3.5 mt-0.5 flex items-center justify-center shrink-0">
                <Check className="h-3.5 w-3.5 text-[#8b887c]" />
              </div>
              <div className="flex-1 min-w-0 pb-2">
                <div className="text-[13px] leading-5 text-[#8b887c]">{t.task.done}</div>
              </div>
            </div>
          )}

          {/* Error node */}
          {hasError && !isActive && (displayMode === 'expanded' || !needsTruncation) && (
            <div className="flex items-start gap-3">
              <div className="w-3.5 h-3.5 mt-0.5 flex items-center justify-center shrink-0">
                <AlertCircle className="h-3.5 w-3.5 text-red-400" />
              </div>
              <div className="flex-1 min-w-0 pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] leading-5 text-red-500">
                    {t.task.errorOccurred}
                  </span>
                  {onRetry && (
                    <button
                      onClick={onRetry}
                      className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[#8b887c] hover:text-[#656358] bg-[#e8e5de] hover:bg-[#ddd9d0] rounded transition-colors"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t.task.retryAction}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Running node */}
          {isActive && (
            <div className="flex items-start gap-3">
              <div className="w-3.5 h-3.5 mt-0.5 flex items-center justify-center shrink-0">
                <Loader2 className="h-3.5 w-3.5 text-[#d97757] animate-spin" />
              </div>
              <div className="flex-1 min-w-0 pb-2">
                <div className="text-[13px] leading-5 text-[#8b887c]">
                  {t.task.running}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Individual step item with vertical timeline connector
 */
function TaskStepItem({ step, showConnector, locale, t }: {
  step: UnifiedStep;
  showConnector: boolean;
  locale: string;
  t: TranslationDict;
}) {
  const Icon = getStepIcon(step);
  const typeLabel = getTypeLabel(step, t);
  const isRunning = step.status === 'running';
  const isCompleted = step.status === 'completed';
  const isError = step.status === 'error';
  const isThinking = step.type === 'thinking';

  const taskExecutionStore = useTaskExecutionStore();

  // Generate step label - for thinking steps, show duration
  const stepLabel = useMemo(() => {
    if (isThinking && isCompleted && step.duration) {
      return format(t.task.thoughtFor, { seconds: step.duration });
    }
    return step.label;
  }, [step, isThinking, isCompleted, t]);

  // Generate completion message if we have tool info
  const completionMsg = useMemo(() => {
    if (step.completionMessage) return step.completionMessage;
    if (isCompleted && step.toolName && step.toolInput && step.toolResult) {
      const executionTime = step.duration;
      return generateCompletionMessage(step.toolName, step.toolInput, step.toolResult, locale, executionTime);
    }
    return null;
  }, [step, isCompleted, locale]);

  // Handle detail block toggle
  const handleToggleDetailBlock = (blockId: string) => {
    if (step.executionId) {
      taskExecutionStore.toggleDetailExpanded(step.executionId, step.id, blockId);
    }
  };

  // Render detail blocks if available (new architecture)
  const renderDetailBlocks = () => {
    if (!step.detailBlocks || step.detailBlocks.length === 0) {
      return null;
    }

    return (
      <div className="flex flex-wrap gap-1.5">
        {step.detailBlocks.map((block) => (
          <DetailBlockView
            key={block.id}
            block={block}
            onToggle={() => handleToggleDetailBlock(block.id)}
          />
        ))}
      </div>
    );
  };

  // Render legacy collapsible details (backward compatibility)
  const renderLegacyDetails = () => {
    if (step.detailBlocks && step.detailBlocks.length > 0) {
      return null; // Use new detail blocks instead
    }

    if (!isCompleted || step.type === 'thinking' || (!step.toolInput && !step.toolResult)) {
      return null;
    }

    return (
      <div className="flex flex-wrap gap-1.5">
        {typeLabel && (
          <CollapsibleDetail
            label={typeLabel}
            toolName={step.toolName}
            toolInput={step.toolInput}
            toolResult={undefined}
            t={t}
          />
        )}
        {step.toolResult && (
          <CollapsibleDetail
            label={t.task.result}
            toolName={step.toolName}
            toolInput={undefined}
            toolResult={step.toolResult}
            t={t}
          />
        )}
      </div>
    );
  };

  return (
    <div className="flex items-start gap-3">
      {/* Icon column with vertical line */}
      <div className="flex flex-col items-center">
        <div className="w-3.5 h-3.5 mt-0.5 flex items-center justify-center shrink-0">
          {isRunning ? (
            <Loader2 className="h-3.5 w-3.5 text-[#d97757] animate-spin" />
          ) : isError ? (
            <AlertCircle className="h-3.5 w-3.5 text-red-400" />
          ) : (
            <Icon className="h-3.5 w-3.5 text-[#a8a49a]" />
          )}
        </div>
        {showConnector && (
          <div className="w-px flex-1 min-h-[16px] bg-[#e8e5de] mt-1" />
        )}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0 pb-3">
        {/* Step label */}
        <div
          className={cn(
            'text-[13px] leading-5',
            isRunning ? 'text-[#656358]' : isError ? 'text-red-500' : 'text-[#8b887c]'
          )}
        >
          {stepLabel}
          {/* Token warning for large tool outputs */}
          {isCompleted && step.toolResult && step.toolResult.length > 10000 && (
            <span className="ml-1.5 inline-flex items-center gap-0.5 px-1.5 py-0 rounded bg-amber-50 text-amber-600 text-[10px]" title={`${Math.round(step.toolResult.length / 1000)}K chars`}>
              <AlertCircle className="h-3 w-3" />
              {Math.round(step.toolResult.length / 1000)}K
            </span>
          )}
        </div>

        {/* Detail blocks - prefer new architecture */}
        {renderDetailBlocks() || renderLegacyDetails()}

        {/* Completion message */}
        {isCompleted && completionMsg && (
          <div className="text-[12px] text-[#a8a49a] mt-0.5">
            {completionMsg}
          </div>
        )}

        {/* Step detail (e.g., filename) - only show if no detail blocks or legacy details */}
        {step.detail && !completionMsg && !typeLabel && !step.detailBlocks?.length && (
          <div className="mt-1">
            <span className="inline-flex items-center px-2 py-0.5 rounded bg-[#f5f3ee] text-[12px] text-[#8b887c] font-mono">
              {getFileName(step.detail)}
            </span>
          </div>
        )}

        {/* Nested child steps for delegate (subagent) */}
        {step.type === 'delegate' && step.childSteps && step.childSteps.length > 0 && (
          <div className="mt-2 pl-1 border-l-2 border-[#e8e5de] ml-0.5">
            {step.childSteps.map((childStep, childIndex) => {
              const isLastChild = childIndex === step.childSteps!.length - 1;
              return (
                <TaskStepItem
                  key={childStep.id}
                  step={childStep}
                  showConnector={!isLastChild}
                  locale={locale}
                  t={t}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Legacy Collapsible detail block for backward compatibility
 */
function CollapsibleDetail({
  label,
  toolName,
  toolInput,
  toolResult,
  t,
}: {
  label: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  t: TranslationDict;
}) {
  const [expanded, setExpanded] = useState(false);

  const formattedInput = useMemo(() => {
    if (!toolInput) return null;

    if (toolName && [TOOL_NAMES.RUN_COMMAND, 'bash', 'execute', 'shell'].includes(toolName)) {
      const cmd = toolInput.command || toolInput.cmd;
      return cmd ? String(cmd) : null;
    }

    if (toolName && [TOOL_NAMES.READ_FILE, 'read', TOOL_NAMES.WRITE_FILE, 'write', TOOL_NAMES.EDIT_FILE, 'edit', 'create_file', 'create'].includes(toolName)) {
      const path = toolInput.path || toolInput.file_path || toolInput.filePath;
      return path ? String(path) : null;
    }

    return JSON.stringify(toolInput, null, 2);
  }, [toolName, toolInput]);

  const truncatedResult = useMemo(() => {
    if (!toolResult) return null;
    const maxLength = 500;
    if (toolResult.length > maxLength) {
      return toolResult.slice(0, maxLength) + '...';
    }
    return toolResult;
  }, [toolResult]);

  const hasContent = formattedInput || truncatedResult;
  if (!hasContent) return null;

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-[#e8e5de] text-[#8b887c] hover:bg-[#ddd9d0] hover:text-[#656358] transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {label}
      </button>

      {expanded && (
        <div className="mt-2 rounded-lg bg-[#f5f3ee] border border-[#e8e5de] overflow-hidden">
          {formattedInput && (
            <div className="border-b border-[#e8e5de]">
              <div className="px-3 py-1.5 text-[11px] text-[#8b887c] bg-[#edeae4]">
                {toolName && [TOOL_NAMES.RUN_COMMAND, 'bash', 'execute', 'shell'].includes(toolName)
                  ? 'bash'
                  : t.task.input}
              </div>
              <pre className="px-3 py-2 text-[12px] text-[#656358] font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[200px] overflow-y-auto">
                {formattedInput}
              </pre>
            </div>
          )}

          {truncatedResult && (
            <div>
              <div className="px-3 py-1.5 text-[11px] text-[#8b887c] bg-[#edeae4]">
                {t.task.output}
              </div>
              <pre className="px-3 py-2 text-[12px] text-[#656358] font-mono whitespace-pre-wrap break-all overflow-x-auto max-h-[300px] overflow-y-auto">
                {truncatedResult}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getFileName(path: string): string {
  const segments = path.split(/[/\\]/);
  return segments[segments.length - 1] || path;
}
