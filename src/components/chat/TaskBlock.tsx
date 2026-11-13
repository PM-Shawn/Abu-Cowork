import { Fragment, useState, useMemo, useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Link } from '@/components/ds/link';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { NOT_RUN_TOOL_RESULTS, TOOL_RESULT_HOOK_BLOCKED_MARKER } from '@/core/agent/toolResultMarkers';
import type { WorkflowStep, StepType } from '@/utils/workflowExtractor';
import type { ExecutionStep, DetailBlock, StepType as ExecStepType, BatchTaskRef } from '@/types/execution';
import { generateCompletionMessage } from '@/utils/workflowExtractor';
import { getToolLabel, shortUrl, isCommandToolName, isMCPTool, hasNameOnlyLabel } from '@/utils/toolLabels';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { usePreviewStore } from '@/stores/previewStore';
import { getBaseName } from '@/utils/pathUtils';
import type { FileChange } from '@/types/fileChange';
import type { BackgroundCommandRef } from '@/types';
import { DiffLines, type DiffFold } from '@/components/diff/DiffLines';
import DetailBlockView from './DetailBlockView';
import { blockFullText } from './toolResultTexts';
import { StepToolView } from './toolViews/StepToolView';
import { hasToolView, type ToolViewRecord } from './toolViews/toolViewRecords';
import { useStepListScroll } from './useStepListScroll';
import { useEntersAfterRowMount } from './rowMount';

type StepGlyph = ComponentProps<typeof Icon>['icon'];

// Small toggle chip that opens a step's details (thinking text, input, output).
const DETAIL_CHIP = 'inline-flex h-5 items-center gap-1 rounded-control bg-fill px-2 text-caption text-label-secondary hover:bg-fill-hover';

// A step's diff shows its first five and last four rows until the reader asks for all.
const STEP_DIFF_FOLD: DiffFold = { head: 5, tail: 4 };

// The title of a step that opens its tool's view.
const STEP_TITLE_BUTTON = 'inline rounded-control text-left transition-colors duration-fast hover:text-label group-hover/step:text-label';

/**
 * What a step's view reads: its whole result, or the part the conversation
 * kept. A step that holds an error block failed, whatever its status, and its
 * view reads that block. A call that failed records no outcome, so a step with
 * a record and no error status succeeded, and an error block there is a result
 * whose text starts with "Error".
 */
function stepViewText(
  step: UnifiedStep,
  toolResults: ReadonlyMap<string, string> | undefined,
  record: ToolViewRecord | undefined,
): { text: string; fullUnavailable: boolean; failed: boolean } {
  const errorBlock = step.detailBlocks?.find((b) => b.type === 'error');
  const recordedSuccess = step.status !== 'error'
    && (record?.commandOutcome ?? record?.fileReadOutcome ?? record?.httpFetchOutcome) !== undefined;
  const failed = !recordedSuccess && (errorBlock !== undefined || step.status === 'error');
  const block = errorBlock ?? step.detailBlocks?.find((b) => b.type === (failed ? 'error' : 'result') || b.type === 'list');
  const full = block ? blockFullText(block, step, toolResults, true) : undefined;
  let view: { text: string; fullUnavailable: boolean; failed: boolean };
  if (typeof full === 'string') view = { text: full, fullUnavailable: false, failed };
  else if (full === null) view = { text: block!.content, fullUnavailable: true, failed };
  else view = { text: block?.content ?? step.toolResult ?? '', fullUnavailable: false, failed };
  if (failed && view.text.startsWith('Error: ')) view.text = view.text.slice('Error: '.length);
  return view;
}

// Unified step type for rendering
export type UnifiedStep = {
  id: string;
  /** Id of the tool call behind the step; joins it to that call's file change. */
  toolCallId?: string;
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
  // The header names the kind of work; the rows below name the specifics, so
  // the two never read the same. A block waiting on the user's answer is named
  // by that wait whether or not it is live (MessageGroup drops the live signal,
  // and with it the spinner, while only the question runs). Otherwise a live
  // block is titled by what is happening now; a settled block by the kinds of
  // work it did, counted.
  const running = [...steps].reverse().find((s) => s.status === 'running');
  if (running?.toolName === TOOL_NAMES.ASK_USER_QUESTION) return t.userQuestion.waitingForAnswer;
  if (isActive) return currentActivityLabel(running, t);

  const separator = locale.startsWith('zh') ? '，' : ', ';
  const counts = { skill: 0, presented: 0, create: 0, modify: 0, read: 0, command: 0, other: 0 };
  for (const step of steps) {
    if (step.type === 'thinking') continue;
    if (step.type === 'skill') counts.skill++;
    else if (step.toolName === TOOL_NAMES.PRESENT_FILES) counts.presented++;
    else if (step.type === 'file-read') counts.read++;
    else if (step.type === 'file-write') counts.modify++;
    else if (step.type === 'file-create') counts.create++;
    else if (step.type === 'command') counts.command++;
    else counts.other++;
  }

  const actions: string[] = [];
  if (counts.skill > 0) {
    actions.push(counts.skill === 1 ? t.task.usedSkill : format(t.task.usedSkills, { count: counts.skill }));
  }
  if (counts.presented > 0) {
    actions.push(t.task.presentedFiles);
  }
  if (counts.create > 0) {
    actions.push(counts.create === 1 ? t.task.createdFile : format(t.task.createdFiles, { count: counts.create }));
  }
  if (counts.modify > 0) {
    actions.push(counts.modify === 1 ? t.task.modifiedFile : format(t.task.modifiedFiles, { count: counts.modify }));
  }
  if (counts.read > 0) {
    actions.push(counts.read === 1 ? t.task.readFile : format(t.task.readFiles, { count: counts.read }));
  }
  if (counts.command > 0) {
    actions.push(counts.command === 1 ? t.task.executedCommand : format(t.task.executedCommands, { count: counts.command }));
  }
  if (counts.other > 0) {
    actions.push(counts.other === 1 ? t.task.calledTool : format(t.task.calledTools, { count: counts.other }));
  }
  if (actions.length > 0) return actions.join(separator);

  // Only thinking: the settled header carries the duration ("思考了 N 秒"); a
  // saved block whose duration was lost is named by the phase alone.
  const thinkingStep = steps.find((s) => s.type === 'thinking');
  if (thinkingStep) {
    return thinkingStep.duration != null
      ? format(t.task.thoughtFor, { seconds: thinkingStep.duration })
      : t.task.thinkingDone;
  }
  return t.task.completed;
}

// What a live block is doing now: the latest running step's kind of work, or
// thinking between steps. The thinking label keeps the words of the placeholder
// dots row the header replaces mid-stream (the active header strips its
// trailing …/... before its animated dots).
function currentActivityLabel(running: UnifiedStep | undefined, t: TranslationDict): string {
  if (!running || running.type === 'thinking') return t.chat.thinking;
  if (running.toolName === TOOL_NAMES.PRESENT_FILES) return t.task.nowPresentingFiles;
  switch (running.type) {
    case 'file-read':
      return t.task.nowReadingFile;
    case 'file-write':
      return t.task.nowModifyingFile;
    case 'file-create':
      return t.task.nowCreatingFile;
    case 'command':
      return t.task.nowRunningCommand;
    case 'search':
      return t.task.nowSearching;
    case 'skill':
      return t.task.nowUsingSkill;
    case 'delegate':
      return t.task.nowDelegating;
    default:
      return t.task.nowCallingTool;
  }
}

// Recompute the tool-call label against the current locale so it follows the
// UI language (including reopened history), instead of the language baked in at
// creation. Non-tool steps (no toolName) keep their original label.
function resolveStepLabel(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  fallback: string,
  locale: string,
  backgroundCommand?: BackgroundCommandRef,
): string {
  if (!toolName) return fallback;
  // A persisted snapshot carries the label but not the input it was derived
  // from (executionSnapshot.ts strips toolInput); recomputing from an empty
  // input degrades "执行 sleep 180" to the generic "执行命令". Keep the label.
  // A background-command step is named by the command its tool call recorded.
  // Exception: a command or connector step's saved label may be an old one that shows the command
  // or the tool's id ("执行 python3 …", "[gh] list", "调用 manage_goal"), and a tool whose title needs
  // only its name is always rebuilt. A command title is rebuilt from what the snapshot kept (the
  // purpose), else read as a generic sentence; the command stays in the details.
  const hasInput = !!toolInput && Object.keys(toolInput).length > 0;
  const titleNeedsRebuild = isCommandToolName(toolName) || hasNameOnlyLabel(toolName) || isMCPTool(toolName);
  if (!hasInput && fallback && !backgroundCommand && !titleNeedsRebuild) return fallback;
  return getToolLabel(toolName, toolInput ?? {}, locale, { backgroundCommand }).label;
}

// Convert WorkflowStep to UnifiedStep
function convertWorkflowStep(
  step: WorkflowStep,
  locale: string,
  backgroundCommands?: ReadonlyMap<string, BackgroundCommandRef>,
): UnifiedStep {
  return {
    id: step.id,
    // A legacy step built from a tool call carries that call's id as its own.
    toolCallId: step.toolName ? step.id : undefined,
    type: step.type,
    label: resolveStepLabel(
      step.toolName, step.toolInput, step.label, locale,
      step.toolName ? backgroundCommands?.get(step.id) : undefined,
    ),
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
export function convertExecutionStep(
  step: ExecutionStep,
  locale: string,
  backgroundCommands?: ReadonlyMap<string, BackgroundCommandRef>,
): UnifiedStep {
  return {
    id: step.id,
    toolCallId: step.toolCallId,
    type: step.type,
    label: resolveStepLabel(
      step.toolName, step.toolInput, step.label, locale,
      step.toolCallId ? backgroundCommands?.get(step.toolCallId) : undefined,
    ),
    detail: step.detail,
    status: step.status,
    duration: step.duration,
    toolName: step.toolName,
    toolInput: step.toolInput,
    toolResult: step.toolResult,
    detailBlocks: step.detailBlocks,
    executionId: step.executionId,
    agentName: step.agentName,
    childSteps: step.childSteps?.map((child) => convertExecutionStep(child, locale, backgroundCommands)),
    batchTask: step.batchTask,
  };
}

/** What Stop writes on a call that was still running, in either locale. */
const STOPPED_RESULTS: ReadonlySet<string> = new Set(
  [...NOT_RUN_TOOL_RESULTS].filter((result) => result !== TOOL_RESULT_HOOK_BLOCKED_MARKER),
);

/** The error toolExecutor records for a call that Stop's abort signal ended. */
const ABORTED_BY_STOP = 'AbortError: Aborted';

const isAbortedByStop = (text: string) => text.replace(/^Error: /, '') === ABORTED_BY_STOP;

/**
 * A step of a stopped turn that did not end on its own: still running, never
 * started, failed with no text kept but the abort of Stop, or holding the
 * result Stop writes on a call that was still running.
 */
function asStoppedStep(step: UnifiedStep): UnifiedStep {
  const kept = [
    ...(step.detailBlocks ?? []).filter((b) => b.type === 'result' || b.type === 'error').map((b) => b.content),
    ...(step.toolResult !== undefined ? [step.toolResult] : []),
  ];
  const endedByStop = step.status === 'running'
    || step.status === 'pending'
    || (step.status === 'error' && kept.every(isAbortedByStop))
    || (step.toolResult !== undefined && STOPPED_RESULTS.has(step.toolResult));
  const childSteps = step.childSteps?.map(asStoppedStep);
  return { ...step, status: endedByStop ? 'cancelled' : step.status, childSteps };
}

/** run_agent_batch children are per-member records for the member tab; the
 *  batch card (BatchProgress) is their in-chat view, so they are not nested inline. */
// eslint-disable-next-line react-refresh/only-export-components
export function hasBatchTaggedChildren(step: UnifiedStep): boolean {
  return !!step.childSteps?.some((child) => child.batchTask !== undefined);
}

interface TaskBlockProps {
  compactRows?: { index: number; content: ReactNode }[];
  steps?: WorkflowStep[];
  executionSteps?: ExecutionStep[];
  isActive: boolean;
  isStopped?: boolean;
  onRetry?: () => void;
  /** File changes of this turn's own tool calls, by tool call id. */
  fileChanges?: ReadonlyMap<string, FileChange>;
  /** Each step's whole result as Abu read it, by tool call id. */
  toolResults?: ReadonlyMap<string, string>;
  /** The command each background-command tool call acted on, by tool call id. */
  backgroundCommands?: ReadonlyMap<string, BackgroundCommandRef>;
  /** Input and outcome records of this turn's own tool calls, by tool call id. */
  toolViewRecords?: ReadonlyMap<string, ToolViewRecord>;
}

type DisplayMode = 'collapsed' | 'expanded';

// The step list's scroll area: at most 240px or half the window, with 24px
// fades at the ends that have more steps beyond them.
const STEP_LIST = 'max-h-[min(240px,50vh)] overflow-y-auto';
const STEP_LIST_FADE_TOP = 'mask-t-from-(--ds-scroll-fade-start)';
const STEP_LIST_FADE_BOTTOM = 'mask-b-from-(--ds-scroll-fade-start)';

/**
 * TaskBlock component - Cowork-style workflow display with timeline
 * Supports both legacy WorkflowStep[] and new ExecutionStep[]
 */
export default function TaskBlock({ steps, executionSteps, isActive, isStopped = false, onRetry, fileChanges, toolResults, backgroundCommands, toolViewRecords, compactRows }: TaskBlockProps) {
  const { t, locale } = useI18n();

  // Convert to unified steps
  const unifiedSteps = useMemo(() => {
    let converted: UnifiedStep[] = [];
    if (executionSteps && executionSteps.length > 0) {
      converted = executionSteps.map((s) => convertExecutionStep(s, locale, backgroundCommands));
    } else if (steps && steps.length > 0) {
      converted = steps.map((s) => convertWorkflowStep(s, locale, backgroundCommands));
    }
    return isStopped ? converted.map(asStoppedStep) : converted;
  }, [steps, executionSteps, locale, backgroundCommands, isStopped]);

  // Lazy initializer: when the block mounts during a live execution, start in 'expanded'
  // so the body (with running thinking content / inline tool steps) is visible without
  // requiring the user to click. The auto-collapse useEffect below handles the
  // active→inactive transition to tuck everything away after the loop ends.
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => isActive ? 'expanded' : 'collapsed');

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
  const timelineEnters = useEntersAfterRowMount(timelineEverOpened);
  const stepListRef = useRef<HTMLDivElement>(null);
  const { edges, onScroll } = useStepListScroll(stepListRef, isOpen, isActive);

  const handleHeaderClick = () => {
    setDisplayMode(displayMode === 'collapsed' ? 'expanded' : 'collapsed');
  };

  if (unifiedSteps.length === 0) return <>{compactRows?.map((row) => row.content)}</>;

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
      {!isOpen && compactRows?.map((row) => row.content)}

      {/* Flow Timeline. block-expand-enter animates the height open when this
          mounts mid-stream (the "思考中" dots swapping to the first thinking/
          tool step while pinned to the bottom must not land in one frame);
          a timeline that shows together with its list row (switching to a
          running conversation) is already open and does not animate.
          open/closed classes roll it up/down on later toggles — including the
          auto-collapse when the answer starts streaming — while the content
          stays mounted (inert + hidden from a11y when closed). */}
      {timelineEverOpened && (
        <div
          inert={!isOpen || undefined}
          aria-hidden={!isOpen || undefined}
          className={cn(
            'block-expand',
            isOpen ? 'block-expand-open' : 'block-expand-closed',
            timelineEnters && 'block-expand-enter',
          )}
        >
          <div
            ref={stepListRef}
            data-step-list
            onScroll={onScroll}
            className={cn(
              STEP_LIST,
              edges.canScrollUp && STEP_LIST_FADE_TOP,
              edges.canScrollDown && STEP_LIST_FADE_BOTTOM,
            )}
          >
            <div className="flow-timeline pl-1">
              {unifiedSteps.map((step, index) => {
                const isLast = index === unifiedSteps.length - 1;
                // Show connector if not the last step, or if there are trailing nodes
                const hasTrailingNodes = allCompleted || isStopped || hasError;
                const showConnector = !isLast || hasTrailingNodes;
                // For a thinking step, signal whether execution has moved on to a
                // tool step after it — used to auto-collapse the reasoning panel.
                const hasLaterToolStep = unifiedSteps
                  .slice(unifiedSteps.indexOf(step) + 1)
                  .some((s) => s.type !== 'thinking');

                return (
                  <Fragment key={step.id}>
                  {isOpen && compactRows?.filter((row) => row.index === index).map((row) => row.content)}
                  <TaskStepItem
                    step={step}
                    showConnector={showConnector}
                    hasLaterToolStep={hasLaterToolStep}
                    locale={locale}
                    t={t}
                    fileChange={step.toolCallId ? fileChanges?.get(step.toolCallId) : undefined}
                    toolResults={toolResults}
                    toolViewRecord={step.toolCallId ? toolViewRecords?.get(step.toolCallId) : undefined}
                    timelineOpen={isOpen}
                  />
                  </Fragment>
                );
              })}
              {isOpen && compactRows?.filter((row) => row.index >= unifiedSteps.length).map((row) => row.content)}

              {/* Done node */}
              {allCompleted && !isStopped && (
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
              {isStopped && (
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
              {hasError && !isActive && (
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
            </div>
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
  /** What the step's write_file, edit_file or delete_file call did to its file. */
  fileChange?: FileChange;
  /** Whole results by tool call id; left out for an expert's nested steps. */
  toolResults?: ReadonlyMap<string, string>;
  /** Input and outcome records of the step's tool call; left out for an expert's nested steps. */
  toolViewRecord?: ToolViewRecord;
  /** The timeline around the step is open; false folds the step's view. */
  timelineOpen?: boolean;
}

export function TaskStepItem({ step, showConnector, hasLaterToolStep, locale, t, fileChange, toolResults, toolViewRecord, timelineOpen }: TaskStepItemProps) {
  const stepGlyph = getStepIcon(step);
  const typeLabel = getTypeLabel(step, t);
  const isRunning = step.status === 'running';
  const isCompleted = step.status === 'completed';
  const isError = step.status === 'error';
  const isCancelled = step.status === 'cancelled';
  const isThinking = step.type === 'thinking';
  const isWaitingForAnswer = isRunning && step.toolName === TOOL_NAMES.ASK_USER_QUESTION;

  const taskExecutionStore = useTaskExecutionStore();
  const [diffExpanded, setDiffExpanded] = useState(false);

  // A step whose tool has a view opens it from its title; an image read keeps its image block.
  const viewToolName = hasToolView(step.toolName) && !step.detailBlocks?.some((b) => b.type === 'image')
    ? step.toolName
    : undefined;
  const showsToolView = viewToolName !== undefined;
  const [viewExpanded, setViewExpanded] = useState(false);
  useEffect(() => {
    if (timelineOpen === false) setViewExpanded(false);
  }, [timelineOpen]);
  const fetchUrl = step.toolName === TOOL_NAMES.HTTP_FETCH ? toolViewRecord?.input.url ?? step.toolInput?.url : undefined;
  const exitCode = toolViewRecord?.commandOutcome?.exitCode;
  const httpStatus = toolViewRecord?.httpFetchOutcome?.status;

  // Generate step label - a thinking step is the row of the reasoning text, so
  // it is named by what it holds (the header names the phase and duration);
  // for waiting ask_user_question, show waiting text
  const stepLabel = useMemo(() => {
    if (isWaitingForAnswer) return t.userQuestion.waitingForAnswer;
    if (isThinking) return t.chat.thinkingProcess;
    return step.label;
  }, [step, isThinking, isWaitingForAnswer, t]);

  // Generate completion message if we have tool info
  const completionMsg = useMemo(() => {
    if (step.completionMessage) return step.completionMessage;
    if (isCompleted && step.toolName && step.toolInput && step.toolResult) {
      const executionTime = step.duration;
      return generateCompletionMessage(step.toolName, step.toolInput, step.toolResult, locale, executionTime, { exitCode });
    }
    return null;
  }, [step, isCompleted, locale, exitCode]);

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
  // Once thinking is done and execution has moved on to a tool step, auto-collapse
  // the reasoning so attention shifts to the running work. Fires once; the user can
  // still manually re-expand from the row's label without it snapping shut again.
  const didAutoCollapseThinking = useRef(false);
  useEffect(() => {
    if (isThinking && isCompleted && hasLaterToolStep && !didAutoCollapseThinking.current) {
      setThinkingExpanded(false);
      didAutoCollapseThinking.current = true;
    }
  }, [isThinking, isCompleted, hasLaterToolStep]);
  // The streaming pane grows open only when it appears inside a list row that
  // was already there; shown together with its row it is simply open.
  const thinkingPaneEnters = useEntersAfterRowMount(isThinking && isRunning && Boolean(step.detail));

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
    const blocks = showsToolView ? step.detailBlocks?.filter((block) => block.type === 'image') : step.detailBlocks;
    if (!blocks || blocks.length === 0) {
      return null;
    }

    return (
      <div className="flex flex-wrap gap-2">
        {blocks.map((block) => (
          <DetailBlockView
            key={block.id}
            block={block}
            onToggle={() => handleToggleDetailBlock(block.id)}
            fullText={blockFullText(block, step, toolResults)}
          />
        ))}
      </div>
    );
  };

  // Render thinking content — inline (with cursor) while still streaming reasoning,
  // folded from the row's label once the thinking phase is done (preserves
  // expanded state from streaming).
  const renderThinkingDetail = () => {
    if (!isThinking || !step.detail) return null;
    if (!isRunning && !isCompleted) return null;
    const panelOpen = isRunning || thinkingExpanded;
    return (
      // Running and completed share ONE panel so the running → completed swap
      // mutates classes on mounted nodes instead of replacing the subtree; the
      // panel — kept mounted — rolls up/down over the shared 280ms transition
      // on later toggles, including the auto-collapse when execution moves on
      // to a tool step. Its gap above lives inside the rolled-up row, so a
      // folded panel takes no room under the row.
      <div>
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
            isRunning && thinkingPaneEnters && 'block-expand-enter',
          )}
        >
          {/* The rolled-up grid row is the borderless wrapper: a bordered box
              there keeps its two border lines on screen at zero height. */}
          <div className="overflow-hidden">
            <div className="pt-1">
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
        </div>
      </div>
    );
  };

  // Render legacy collapsible details (backward compatibility)
  const renderLegacyDetails = () => {
    if (showsToolView) return null;
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

  // What a press on the step's line opens: the same thing its title button
  // (or, on a file row, its "+N −M") opens; nothing on a line that opens nothing.
  const rowToggle = isThinking && isCompleted && step.detail
    ? () => setThinkingExpanded((open) => !open)
    : showsToolView
      ? () => setViewExpanded((open) => !open)
      : fileChange?.hunks?.length && fileChange.added !== undefined && fileChange.deleted !== undefined
        ? () => setDiffExpanded((open) => !open)
        : undefined;

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
        {/* Step label. A press anywhere on the line opens what its title button
            opens; the title button stays the keyboard's control, and the
            line's links and other buttons keep their own presses. */}
        <div
          onClick={rowToggle ? (event) => {
            if ((event.target as HTMLElement).closest('button, a')) return;
            if (window.getSelection()?.toString()) return;
            rowToggle();
          } : undefined}
          className={cn(
            'text-ui',
            rowToggle && 'group/step cursor-pointer',
            isRunning
              ? 'text-label-secondary'
              : isError
                ? 'text-danger'
                : 'text-label-tertiary'
          )}
        >
          {isThinking && isCompleted && step.detail ? (
            <Pressable
              onClick={() => setThinkingExpanded((open) => !open)}
              aria-expanded={thinkingExpanded}
              className={STEP_TITLE_BUTTON}
            >
              {stepLabel}
              <StepDisclosure expanded={thinkingExpanded} />
            </Pressable>
          ) : !showsToolView ? (
            fileChange ? <StepFileLabel label={stepLabel} fileChange={fileChange} t={t} /> : stepLabel
          ) : typeof fetchUrl === 'string' ? (
            <StepUrlLabel label={stepLabel} url={fetchUrl} expanded={viewExpanded} onToggle={() => setViewExpanded((open) => !open)} />
          ) : (
            <Pressable
              onClick={() => setViewExpanded((open) => !open)}
              aria-expanded={viewExpanded}
              aria-label={stepLabel}
              className={STEP_TITLE_BUTTON}
            >
              {stepLabel}
              <StepDisclosure expanded={viewExpanded} />
            </Pressable>
          )}
          {fileChange && fileChange.added !== undefined && fileChange.deleted !== undefined && (
            <StepLineCounts
              added={fileChange.added}
              deleted={fileChange.deleted}
              expanded={fileChange.hunks?.length ? diffExpanded : undefined}
              onToggle={() => setDiffExpanded((open) => !open)}
            />
          )}
          {isCancelled && (
            <span role="status" aria-label={t.task.stopped} className="ml-2 inline-flex align-middle">
              <Tag>{t.task.stopped}</Tag>
            </span>
          )}
          {exitCode !== undefined && exitCode !== 0 && isCompleted && (
            <span className="ml-2 inline-flex align-middle">
              <Tag data-exit-code={exitCode}>{format(t.task.exitCode, { code: exitCode })}</Tag>
            </span>
          )}
          {httpStatus !== undefined && (httpStatus < 200 || httpStatus >= 300) && (
            <span className="ml-2 inline-flex align-middle">
              <Tag data-http-status={httpStatus}>{httpStatus}</Tag>
            </span>
          )}
          {/* Token warning for large tool outputs */}
          {isCompleted && step.toolResult && step.toolResult.length > 10000 && (
            <span className="ml-2 inline-flex align-middle" title={`${Math.round(step.toolResult.length / 1000)}K chars`}>
              <Tag tone="warning">{Math.round(step.toolResult.length / 1000)}K</Tag>
            </span>
          )}
        </div>

        {fileChange?.hunks && diffExpanded && (
          <DiffLines hunks={fileChange.hunks} fold={STEP_DIFF_FOLD} cut={fileChange.cut} className="my-2" />
        )}

        {/* Thinking content — only for thinking steps; inline while running, toggle when done */}
        {renderThinkingDetail()}

        {/* Detail blocks - prefer new architecture */}
        {renderDetailBlocks()}
        {renderLegacyDetails()}

        {viewToolName !== undefined && viewExpanded && (() => {
          const { text, fullUnavailable, failed } = stepViewText(step, toolResults, toolViewRecord);
          return (
            <div className="mt-2">
              <StepToolView
                toolName={viewToolName}
                status={failed && !isCancelled ? 'error' : step.status}
                input={toolViewRecord?.input ?? step.toolInput ?? {}}
                record={toolViewRecord}
                text={text}
                fullUnavailable={fullUnavailable}
              />
            </div>
          );
        })()}

        {/* Completion message */}
        {isCompleted && completionMsg && (
          <div className="mt-1 text-ui-sm text-label-tertiary">
            {completionMsg}
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
                  timelineOpen={timelineOpen}
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

/**
 * Label of a step that changed a file. The file name opens the file in the
 * side preview; a deleted file has nothing to open, so its name is plain text.
 */
function StepFileLabel({ label, fileChange, t }: { label: string; fileChange: FileChange; t: TranslationDict }) {
  const fileName = getBaseName(fileChange.path);
  const leading = label.endsWith(fileName) ? label.slice(0, label.length - fileName.length) : `${label} `;
  return (
    <>
      {leading}
      {fileChange.kind === 'delete' ? (
        <span className="break-all">{fileName}</span>
      ) : (
        <Pressable
          onClick={() => usePreviewStore.getState().openPreview(fileChange.path)}
          aria-label={format(t.chat.openFileInPreview, { name: fileName })}
          className="inline max-w-full break-all rounded-control text-left text-link underline-offset-2 hover:underline"
        >
          {fileName}
        </Pressable>
      )}
    </>
  );
}

/**
 * Title of a page fetch: the words before the address open the step's view,
 * and the address beside them opens the page.
 */
function StepUrlLabel({ label, url, expanded, onToggle }: {
  label: string;
  url: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const address = shortUrl(url);
  const leading = label.endsWith(address) ? label.slice(0, label.length - address.length).trimEnd() : label;
  return (
    <>
      <Pressable onClick={onToggle} aria-expanded={expanded} aria-label={label} className={STEP_TITLE_BUTTON}>
        {leading}
        <StepDisclosure expanded={expanded} />
      </Pressable>
      {' '}
      <Link
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="break-all"
      >
        {address}
      </Link>
    </>
  );
}

/** The arrow after a step title that opens something: right while folded, down while open. */
function StepDisclosure({ expanded }: { expanded: boolean }) {
  return <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" className="ml-1 inline-block align-middle" />;
}

/** "+N −M" of a step; a toggle for the step's diff when `expanded` is given. */
function StepLineCounts({ added, deleted, expanded, onToggle }: {
  added: number;
  deleted: number;
  expanded?: boolean;
  onToggle: () => void;
}) {
  const counts = (
    <>
      <span className="text-success">+{added}</span>
      <span className="text-danger">−{deleted}</span>
    </>
  );
  if (expanded === undefined) {
    return <span className="ml-2 inline-flex items-center gap-1 align-middle font-code text-ui-sm">{counts}</span>;
  }
  return (
    <Pressable
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={`+${added} −${deleted}`}
      className="ml-2 inline-flex items-center gap-1 rounded-control align-middle font-code text-ui-sm text-label-tertiary group-hover/step:text-label"
    >
      <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" />
      {counts}
    </Pressable>
  );
}
