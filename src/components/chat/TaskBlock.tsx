import { useState, useMemo, useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { WorkflowStep, StepType } from '@/utils/workflowExtractor';
import type { ExecutionStep, DetailBlock, StepType as ExecStepType, BatchTaskRef } from '@/types/execution';
import { generateCompletionMessage } from '@/utils/workflowExtractor';
import { getToolLabel } from '@/utils/toolLabels';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import DetailBlockView from './DetailBlockView';

type StepGlyph = ComponentProps<typeof Icon>['icon'];

// Small toggle chip that opens a step's details (thinking text, input, output).
const DETAIL_CHIP = 'inline-flex h-5 items-center gap-1 rounded-control bg-fill px-2 text-caption text-label-secondary hover:bg-fill-hover';

// Unified step type for rendering
export type UnifiedStep = {
  id: string;
  type: StepType | ExecStepType;
  label: string;
  detail?: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'cancelled';
  duration?: number;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  completionMessage?: string;
  // New: detail blocks from ExecutionStep
  detailBlocks?: DetailBlock[];
  /** Batch-progress steps may show a rich image block alongside legacy input/result details. */
  showLegacyDetailsWithDetailBlocks?: boolean;
  // Reference to original execution for toggle actions
  executionId?: string;
  // Delegate (subagent) support
  agentName?: string;
  childSteps?: UnifiedStep[];
  /** Child of a run_agent_batch step: which batch task (member) produced it. */
  batchTask?: BatchTaskRef;
};

// Icon mapping for step types
const stepIcons: Record<string, StepGlyph> = {
  thinking: AppIcons.clock,
  'file-read': AppIcons.fileRead,
  'file-write': AppIcons.fileEdit,
  'file-create': AppIcons.fileCreate,
  tool: AppIcons.tool,
  skill: AppIcons.skill,
  command: AppIcons.terminal,
  search: AppIcons.search,
  mcp: AppIcons.plug,  // MCP tools use Plug icon
  delegate: AppIcons.team,  // Delegate/subagent icon
};

// Get icon for specific tool names
function getStepIcon(step: UnifiedStep): StepGlyph {
  if (step.detail?.includes(TOOL_NAMES.LIST_DIRECTORY) || step.label.includes('目录') || step.label.includes('directory')) {
    return AppIcons.folderOpen;
  }
  if (step.label.includes('搜索') || step.label.includes('search') || step.type === 'search') {
    return AppIcons.webPage;
  }
  if (step.label.includes('系统信息') || step.label.includes('system')) {
    return AppIcons.info;
  }
  return stepIcons[step.type] || AppIcons.tool;
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
// eslint-disable-next-line react-refresh/only-export-components
export function generateSummary(
  steps: UnifiedStep[],
  t: TranslationDict,
  locale: string,
  isActive: boolean,
  isStopped = false,
): string {
  if (isStopped) return t.task.stopped;
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

  // Thinking is its own standalone block now — the collapsed header is the only
  // line, so surface the duration ("思考了 N 秒") at a glance. While the block
  // is still live the label must be "思考中", CONTINUING the placeholder dots
  // row it replaces mid-stream (same words, same spot — the trailing …/... is
  // stripped by the active header before its animated dots); "思考过程" is only
  // for settled blocks whose duration got lost (old persisted history).
  const thinkingStep = steps.find((s) => s.type === 'thinking');
  const onlyThinking = thinkingStep && readCount + writeCount + createCount + commandCount + otherCount === 0 && !skillStep;
  if (onlyThinking) {
    actions.push(
      thinkingStep.duration != null
        ? format(t.task.thoughtFor, { seconds: thinkingStep.duration })
        : isActive ? t.chat.thinking : t.chat.thinkingProcess,
    );
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

// Recompute the tool-call label against the current locale so it follows the
// UI language (including reopened history), instead of the language baked in at
// creation. Non-tool steps (no toolName) keep their original label.
function resolveStepLabel(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  fallback: string,
  locale: string
): string {
  if (!toolName) return fallback;
  // A persisted snapshot carries the label but not the input it was derived
  // from (executionSnapshot.ts strips toolInput); recomputing from an empty
  // input degrades "执行 sleep 180" to the generic "执行命令". Keep the label.
  const hasInput = !!toolInput && Object.keys(toolInput).length > 0;
  if (!hasInput && fallback) return fallback;
  return getToolLabel(toolName, toolInput ?? {}, locale).label;
}

// Convert WorkflowStep to UnifiedStep
function convertWorkflowStep(step: WorkflowStep, locale: string): UnifiedStep {
  return {
    id: step.id,
    type: step.type,
    label: resolveStepLabel(step.toolName, step.toolInput, step.label, locale),
    detail: step.detail,
    status: step.status,
    duration: step.duration,
    toolName: step.toolName,
    toolInput: step.toolInput,
    toolResult: step.toolResult,
  };
}

// Convert ExecutionStep to UnifiedStep (recursive for childSteps)
// eslint-disable-next-line react-refresh/only-export-components
export function convertExecutionStep(step: ExecutionStep, locale: string): UnifiedStep {
  return {
    id: step.id,
    type: step.type,
    label: resolveStepLabel(step.toolName, step.toolInput, step.label, locale),
    detail: step.detail,
    status: step.status,
    duration: step.duration,
    toolName: step.toolName,
    toolInput: step.toolInput,
    toolResult: step.toolResult,
    detailBlocks: step.detailBlocks,
    executionId: step.executionId,
    agentName: step.agentName,
    childSteps: step.childSteps?.map((child) => convertExecutionStep(child, locale)),
    batchTask: step.batchTask,
  };
}

/** run_agent_batch children are per-member records for the member tab; the
 *  batch card (BatchProgress) is their in-chat view, so they are not nested inline. */
// eslint-disable-next-line react-refresh/only-export-components
export function hasBatchTaggedChildren(step: UnifiedStep): boolean {
  return !!step.childSteps?.some((child) => child.batchTask !== undefined);
}

interface TaskBlockProps {
  steps?: WorkflowStep[];
  executionSteps?: ExecutionStep[];
  isActive: boolean;
  isStopped?: boolean;
  onRetry?: () => void;
}

/**
 * TaskBlock component - Cowork-style workflow display with timeline
 * Supports both legacy WorkflowStep[] and new ExecutionStep[]
 */
// Number of steps shown in preview mode
const PREVIEW_LIMIT = 3;

type DisplayMode = 'collapsed' | 'preview' | 'expanded';

export default function TaskBlock({ steps, executionSteps, isActive, isStopped = false, onRetry }: TaskBlockProps) {
  const { t, locale } = useI18n();

  // Convert to unified steps
  const unifiedSteps = useMemo(() => {
    if (executionSteps && executionSteps.length > 0) {
      return executionSteps.map((s) => convertExecutionStep(s, locale));
    }
    if (steps && steps.length > 0) {
      return steps.map((s) => convertWorkflowStep(s, locale));
    }
    return [];
  }, [steps, executionSteps, locale]);

  // Lazy initializer: when the block mounts during a live execution, start in 'preview'
  // so the body (with running thinking content / inline tool steps) is visible without
  // requiring the user to click. The auto-collapse useEffect below handles the
  // active→inactive transition to tuck everything away after the loop ends.
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => isActive ? 'preview' : 'collapsed');

  // Auto-collapse when execution finishes (isActive: true → false)
  const prevIsActiveRef = useRef(isActive);
  useEffect(() => {
    if (prevIsActiveRef.current && !isActive) {
      setDisplayMode('collapsed');
    }
    prevIsActiveRef.current = isActive;
  }, [isActive]);

  const completedCount = unifiedSteps.filter((s) => s.status === 'completed').length;
  const allCompleted = completedCount === unifiedSteps.length && unifiedSteps.length > 0 && !isActive;
  const hasError = unifiedSteps.some((s) => s.status === 'error');
  const summary = useMemo(
    () => generateSummary(unifiedSteps, t, locale, isActive, isStopped),
    [unifiedSteps, t, locale, isActive, isStopped],
  );

  // Determine which steps to display based on mode
  const isOpen = displayMode !== 'collapsed';
  // Timeline mount gate. Blocks that mount already collapsed (history rows
  // remounting during virtualized scrolling) never render the timeline at all
  // — no DOM cost, no risk of a mount animation. But once the timeline HAS
  // been open, collapsing keeps it mounted at grid-rows 0fr so the close is a
  // 280ms roll-up (see .block-expand in index.css). Unmounting here instead
  // made the auto-collapse when the answer starts streaming read as the whole
  // thinking/step block blinking away in one frame.
  // Monotonic latch (false→true) via the render-phase state adjustment
  // pattern: the latch must flip in the SAME render that opens the timeline
  // (an effect would paint the first open one frame without it), and it must
  // be STATE, not a ref mutated during render — ref writes aren't tied to
  // commit, so a discarded concurrent render could latch it for a timeline
  // that never showed (also react-hooks/refs forbids it).
  const [timelineEverOpened, setTimelineEverOpened] = useState(isOpen);
  if (isOpen && !timelineEverOpened) setTimelineEverOpened(true);
  const needsTruncation = unifiedSteps.length > PREVIEW_LIMIT;
  const visibleSteps = (displayMode === 'preview' && needsTruncation)
    ? unifiedSteps.slice(0, PREVIEW_LIMIT)
    : unifiedSteps;

  const handleHeaderClick = () => {
    if ((allCompleted || isStopped) && !hasError) {
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
      {/* Summary header. While the block runs it carries the block's only
          spinner (one per place); the steps below show a still loading icon. */}
      <Pressable
        onClick={handleHeaderClick}
        aria-expanded={isOpen}
        className="mb-2 flex items-center gap-2 rounded-control text-left text-ui text-label-secondary transition-colors duration-fast hover:text-label"
      >
        {isActive && <Spinner size="sm" labelHidden label={t.task.running} />}
        <span>
          {isActive ? summary.replace(/\.{3}$/, '').replace(/…$/, '') : summary}
        </span>
        <Icon
          icon={AppIcons.expand}
          size="sm"
          className={cn('text-label-tertiary transition-transform', !isOpen && '-rotate-90')}
        />
      </Pressable>

      {/* Flow Timeline. block-expand-enter animates the height open when this
          mounts mid-stream (the "思考中" dots swapping to the first thinking/
          tool step while pinned to the bottom must not land in one frame);
          open/closed classes roll it up/down on later toggles — including the
          auto-collapse when the answer starts streaming — while the content
          stays mounted (inert + hidden from a11y when closed). */}
      {timelineEverOpened && visibleSteps.length > 0 && (
        <div
          inert={!isOpen || undefined}
          aria-hidden={!isOpen || undefined}
          className={cn(
            'block-expand',
            isOpen ? 'block-expand-open' : 'block-expand-closed',
            'block-expand-enter',
          )}
        >
        <div className="flow-timeline pl-1">
          {visibleSteps.map((step, index) => {
            const isLastVisible = index === visibleSteps.length - 1;
            // Show connector if not the last visible step, or if there are trailing nodes
            const hasTrailingNodes = allCompleted || isStopped || isActive || hasError;
            const isFullyExpanded = displayMode === 'expanded' || !needsTruncation;
            const showConnector = !isLastVisible || (isFullyExpanded && hasTrailingNodes);
            // For a thinking step, signal whether execution has moved on to a
            // tool step after it — used to auto-collapse the reasoning panel.
            const hasLaterToolStep = unifiedSteps
              .slice(unifiedSteps.indexOf(step) + 1)
              .some((s) => s.type !== 'thinking');

            return (
              <TaskStepItem
                key={step.id}
                step={step}
                showConnector={showConnector}
                hasLaterToolStep={hasLaterToolStep}
                locale={locale}
                t={t}
              />
            );
          })}

          {/* Show more / Collapse toggle */}
          {needsTruncation && (
            <div className="flex items-start gap-3">
              <div className="w-3.5 shrink-0" />
              <div className="flex-1 min-w-0 pb-2">
                <Button variant="plain" size="sm" onClick={displayMode === 'preview' ? handleShowMore : handleCollapse}>
                  {displayMode === 'preview' ? t.task.showMore : t.task.collapse}
                </Button>
              </div>
            </div>
          )}

          {/* Done node — only in fully expanded or no truncation needed */}
          {allCompleted && !isStopped && (displayMode === 'expanded' || !needsTruncation) && (
            <div className="flex items-start gap-3">
              <StepIconSlot>
                <StatusIcon tone="success" size="sm" />
              </StepIconSlot>
              <div className="flex-1 min-w-0 pb-2">
                <div className="text-ui text-label-tertiary">{t.task.done}</div>
              </div>
            </div>
          )}

          {/* User-stopped node — distinct from successful completion. */}
          {isStopped && (displayMode === 'expanded' || !needsTruncation) && (
            <div className="flex items-start gap-3">
              <StepIconSlot>
                <Icon icon={AppIcons.stopped} size="sm" className="text-label-tertiary" />
              </StepIconSlot>
              <div className="flex-1 min-w-0 pb-2">
                <div className="text-ui text-label-tertiary">{t.task.stopped}</div>
              </div>
            </div>
          )}

          {/* Error node */}
          {hasError && !isActive && (displayMode === 'expanded' || !needsTruncation) && (
            <div className="flex items-start gap-3">
              <StepIconSlot>
                <StatusIcon tone="danger" size="sm" />
              </StepIconSlot>
              <div className="flex-1 min-w-0 pb-2">
                <div className="flex items-center gap-2">
                  <span className="text-ui text-danger">
                    {t.task.errorOccurred}
                  </span>
                  {onRetry && (
                    <Button variant="secondary" size="sm" icon={AppIcons.retry} onClick={onRetry}>
                      {t.task.retryAction}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Running node: still icon, the header holds the block's spinner */}
          {isActive && (
            <div className="flex items-start gap-3">
              <StepIconSlot>
                <Icon icon={AppIcons.loading} size="sm" className="text-label-tertiary" />
              </StepIconSlot>
              <div className="flex-1 min-w-0 pb-2">
                <div className="text-ui text-label-tertiary">
                  {t.task.running}
                </div>
              </div>
            </div>
          )}
        </div>
        </div>
      )}
    </div>
  );
}

/** Icon column cell: one text-ui line high, so a 14px icon centers on the
 *  first line of the step label next to it. */
function StepIconSlot({ children }: { children: ReactNode }) {
  return <div className="flex h-lh w-3.5 shrink-0 items-center justify-center text-ui">{children}</div>;
}

/**
 * Individual step item with vertical timeline connector
 */
export interface TaskStepItemProps {
  step: UnifiedStep;
  showConnector: boolean;
  hasLaterToolStep: boolean;
  locale: string;
  t: TranslationDict;
}

export function TaskStepItem({ step, showConnector, hasLaterToolStep, locale, t }: TaskStepItemProps) {
  const stepGlyph = getStepIcon(step);
  const typeLabel = getTypeLabel(step, t);
  const isRunning = step.status === 'running';
  const isCompleted = step.status === 'completed';
  const isError = step.status === 'error';
  const isCancelled = step.status === 'cancelled';
  const isThinking = step.type === 'thinking';
  const isWaitingForAnswer = isRunning && step.toolName === TOOL_NAMES.ASK_USER_QUESTION;

  const taskExecutionStore = useTaskExecutionStore();

  // Generate step label - for thinking steps, show duration; for waiting ask_user_question, show waiting text
  const stepLabel = useMemo(() => {
    if (isWaitingForAnswer) return t.userQuestion.waitingForAnswer;
    if (isThinking) {
      // Thinking steps carry a baked '思考中...' label; localize at render time
      // (mirrors the tool-label render-time approach) so it follows UI locale.
      return (isCompleted && step.duration)
        ? format(t.task.thoughtFor, { seconds: step.duration })
        : t.chat.thinking;
    }
    return step.label;
  }, [step, isThinking, isCompleted, isWaitingForAnswer, t]);

  // Generate completion message if we have tool info
  const completionMsg = useMemo(() => {
    if (step.completionMessage) return step.completionMessage;
    if (isCompleted && step.toolName && step.toolInput && step.toolResult) {
      const executionTime = step.duration;
      return generateCompletionMessage(step.toolName, step.toolInput, step.toolResult, locale, executionTime);
    }
    return null;
  }, [step, isCompleted, locale]);

  // Thinking expanded state — starts true when running so content is visible
  // during streaming, and persists across the running→completed transition
  // so the user doesn't lose sight of thinking content mid-read.
  const [thinkingExpanded, setThinkingExpanded] = useState(isThinking && isRunning);
  const prevThinkingRunning = useRef(isRunning);
  useEffect(() => {
    // Auto-expand when thinking starts running
    if (isThinking && isRunning && !prevThinkingRunning.current) {
      setThinkingExpanded(true);
    }
    prevThinkingRunning.current = isRunning;
  }, [isThinking, isRunning]);
  // Latches true once this step's thinking pane has rendered in its streaming
  // state (set-state-during-render derived-state pattern). The completed-state
  // toggle button animates open only when it replaces the live pane (running →
  // completed swap in this mounted component); history/remount renders show it
  // statically.
  const [thinkingRanLive, setThinkingRanLive] = useState(false);
  if (isThinking && isRunning && !thinkingRanLive) setThinkingRanLive(true);

  // Once thinking is done and execution has moved on to a tool step, auto-collapse
  // the reasoning so attention shifts to the running work. Fires once; the user can
  // still manually re-expand via the "思考过程" toggle without it snapping shut again.
  const didAutoCollapseThinking = useRef(false);
  useEffect(() => {
    if (isThinking && isCompleted && hasLaterToolStep && !didAutoCollapseThinking.current) {
      setThinkingExpanded(false);
      didAutoCollapseThinking.current = true;
    }
  }, [isThinking, isCompleted, hasLaterToolStep]);

  // Auto-scroll the streaming thinking pane to the bottom as new tokens arrive,
  // so the latest reasoning text stays in view instead of being clipped by max-height.
  const thinkingScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isThinking || !isRunning) return;
    const el = thinkingScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [isThinking, isRunning, step.detail]);

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
      <div className="flex flex-wrap gap-2">
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

  // Render thinking content — inline (with cursor) while still streaming reasoning,
  // collapsible once the thinking phase is done (preserves expanded state from streaming).
  const renderThinkingDetail = () => {
    if (!isThinking || !step.detail) return null;
    if (!isRunning && !isCompleted) return null;
    const panelOpen = isRunning || thinkingExpanded;
    return (
      // Running and completed share ONE skeleton (toggle-button slot above a
      // block-expand panel) so the running → completed swap mutates classes on
      // mounted nodes instead of replacing the subtree — the old two-structure
      // version landed a ~24px height change in one frame (below
      // SmoothHeight's 40px threshold), a small residual hop. Now the button
      // slot grows in via block-expand-enter and the panel — kept mounted —
      // rolls up/down over the shared 280ms transition on later toggles,
      // including the auto-collapse when execution moves on to a tool step.
      <div className="mt-1">
        {isCompleted && (
          <div
            className={cn(
              'block-expand block-expand-open',
              thinkingRanLive && 'block-expand-enter',
            )}
          >
            {/* pb-2 (the button→panel gap) sits inside the animated slot so it
                grows in with the button instead of jumping in separately. */}
            <div className="pb-2">
              <Pressable
                onClick={() => setThinkingExpanded(!thinkingExpanded)}
                aria-expanded={thinkingExpanded}
                className={DETAIL_CHIP}
              >
                <Icon icon={thinkingExpanded ? AppIcons.expand : AppIcons.disclose} size="sm" />
                {t.chat.thinkingProcess}
              </Pressable>
            </div>
          </div>
        )}
        {/* block-expand-enter while running: the pane can first mount inside
            an ALREADY open timeline (a later turn's thinking starting after
            tool steps), where the timeline-level mount animation won't fire —
            so the pane animates its own height open too. Same one-frame-jump
            rationale as the timeline wrapper above. */}
        <div
          inert={!panelOpen || undefined}
          aria-hidden={!panelOpen || undefined}
          className={cn(
            'block-expand',
            panelOpen ? 'block-expand-open' : 'block-expand-closed',
            isRunning && 'block-expand-enter',
          )}
        >
          <div className="overflow-hidden rounded-panel border border-separator bg-surface">
            <div ref={thinkingScrollRef} className="px-3 py-2 max-h-48 overflow-y-auto">
              <pre className="m-0 whitespace-pre-wrap break-words font-sans text-ui-sm italic text-label-secondary">
                {step.detail}
                {isRunning && <span aria-hidden="true" className="ml-1 inline-block h-4 w-0.5 bg-label-secondary align-text-bottom" />}
              </pre>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Render legacy collapsible details (backward compatibility)
  const renderLegacyDetails = () => {
    if (step.detailBlocks && step.detailBlocks.length > 0 && !step.showLegacyDetailsWithDetailBlocks) {
      return null; // Use new detail blocks instead
    }

    if (!isCompleted || step.type === 'thinking' || (!step.toolInput && !step.toolResult)) {
      return null;
    }

    return (
      <div className="flex flex-wrap gap-2">
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
        {/* Still icons only: the block header holds the one spinner. */}
        <StepIconSlot>
          {isWaitingForAnswer ? (
            <Icon icon={AppIcons.awaitingAnswer} size="sm" className="text-label-tertiary" />
          ) : isRunning ? (
            <Icon icon={AppIcons.loading} size="sm" className="text-label-tertiary" />
          ) : isError ? (
            <StatusIcon tone="danger" size="sm" />
          ) : isCancelled ? (
            <Icon icon={AppIcons.stopped} size="sm" className="text-label-tertiary" />
          ) : isCompleted ? (
            <StatusIcon tone="success" size="sm" />
          ) : (
            <Icon icon={stepGlyph} size="sm" className="text-label-tertiary" />
          )}
        </StepIconSlot>
        {showConnector && (
          <div className="mt-1 min-h-4 w-px flex-1 bg-separator" />
        )}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0 pb-3">
        {/* Step label */}
        <div
          className={cn(
            'text-ui',
            isRunning
              ? 'text-label-secondary'
              : isError
                ? 'text-danger'
                : 'text-label-tertiary'
          )}
        >
          {stepLabel}
          {isCancelled && (
            <span role="status" aria-label={t.task.cancelled} className="ml-2 inline-flex align-middle">
              <Tag>{t.task.cancelled}</Tag>
            </span>
          )}
          {/* Token warning for large tool outputs */}
          {isCompleted && step.toolResult && step.toolResult.length > 10000 && (
            <span className="ml-2 inline-flex align-middle" title={`${Math.round(step.toolResult.length / 1000)}K chars`}>
              <Tag tone="warning">{Math.round(step.toolResult.length / 1000)}K</Tag>
            </span>
          )}
        </div>

        {/* Thinking content — only for thinking steps; inline while running, toggle when done */}
        {renderThinkingDetail()}

        {/* Detail blocks - prefer new architecture */}
        {renderDetailBlocks()}
        {renderLegacyDetails()}

        {/* Completion message */}
        {isCompleted && completionMsg && (
          <div className="mt-1 text-ui-sm text-label-tertiary">
            {completionMsg}
          </div>
        )}

        {/* Step detail (e.g., filename) - only show if no detail blocks or legacy details.
            Skipped for thinking steps — their detail is the full reasoning text and is
            already rendered above by renderThinkingDetail (inline / collapsible). */}
        {step.detail && !isThinking && !completionMsg && !typeLabel && !step.detailBlocks?.length && (
          <div className="mt-1">
            <span className="inline-flex h-5 items-center rounded-control bg-fill px-2 font-code text-ui-sm text-label-tertiary">
              {getFileName(step.detail)}
            </span>
          </div>
        )}

        {/* Nested child steps for delegate (subagent) */}
        {step.type === 'delegate' && step.childSteps && step.childSteps.length > 0 && !hasBatchTaggedChildren(step) && (
          <div className="mt-2 ml-1 border-l-2 border-separator pl-1">
            {step.childSteps.map((childStep, childIndex) => {
              const isLastChild = childIndex === step.childSteps!.length - 1;
              const childHasLaterToolStep = step.childSteps!
                .slice(childIndex + 1)
                .some((s) => s.type !== 'thinking');
              return (
                <TaskStepItem
                  key={childStep.id}
                  step={childStep}
                  showConnector={!isLastChild}
                  hasLaterToolStep={childHasLaterToolStep}
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
      <Pressable
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={DETAIL_CHIP}
      >
        <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" />
        {label}
      </Pressable>

      {expanded && (
        <div className="mt-2 overflow-hidden rounded-panel bg-code">
          {formattedInput && (
            <div className="border-b border-separator">
              <div className="border-b border-separator px-3 py-1 text-caption text-label-tertiary">
                {toolName && [TOOL_NAMES.RUN_COMMAND, 'bash', 'execute', 'shell'].includes(toolName)
                  ? 'bash'
                  : t.task.input}
              </div>
              <pre className="px-3 py-2 font-code text-mono text-label whitespace-pre-wrap break-all overflow-x-auto max-h-[200px] overflow-y-auto">
                {formattedInput}
              </pre>
            </div>
          )}

          {truncatedResult && (
            <div>
              <div className="border-b border-separator px-3 py-1 text-caption text-label-tertiary">
                {t.task.output}
              </div>
              <pre className="px-3 py-2 font-code text-mono text-label whitespace-pre-wrap break-all overflow-x-auto max-h-[300px] overflow-y-auto">
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
