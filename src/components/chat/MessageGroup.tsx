import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import type { BatchIdentity, Message, MessageContent, ToolCall } from '@/types';
import { makeBatchKey } from '@/types';
import { TOOL_NAMES, isDisplayHiddenStepBackedTool } from '@/core/tools/toolNames';
import type { ExecutionStep } from '@/types/execution';
import type { WorkflowStep } from '@/utils/workflowExtractor';
import MessageBubble from './MessageBubble';
import SkillProposalCard from './SkillProposalCard';
import SandboxRecoveryCard from './SandboxRecoveryCard';
import UserQuestionCard from './UserQuestionCard';
import PlanStepsCard from './PlanStepsCard';
import ShowWidgetCard from './ShowWidgetCard';
import TaskBlock from './TaskBlock';
import SmoothHeight from './SmoothHeight';
import BatchProgress from './BatchProgress';
import MarkdownRenderer from './MarkdownRenderer';
import FileAttachment, { ImagePreviewCard, ImageThumbnail, isImageFile } from './FileAttachment';
import SourcesSection from './SourcesSection';
import { getConversationAgentState, useChatStore, useActiveConversation } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n, format } from '@/i18n';
import { MessageErrorBoundary } from '@/components/common/ErrorBoundary';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { computeRewindImpact } from '@/utils/rewindImpact';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useBatchProgressStore } from '@/stores/batchProgressStore';
import { makeWorkProcessFoldKey, useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import { extractWorkflowSteps, extractFileOutputs, extractFilePathsFromText, parsePlanSteps } from '@/utils/workflowExtractor';
import { parseSearchResults, stripSourcesBlock, parseSourcesFromText } from '@/utils/searchParser';
import { backfillDetailBlockImages, snapshotToExecutionSteps } from '@/core/agent/executionSnapshot';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { allWorkingDirectories } from '@/core/permissions/workingDirs';
import { homeDir } from '@tauri-apps/api/path';
import { cn } from '@/lib/utils';
import { ThinkingStatusLine, AssistantRowAvatar } from './ThinkingStatusLine';
import { GROUP_CONTENT_GAP } from './chatSpacing';
import { rebuildImageAttachments } from './imageAttachmentRebuild';
import {
  rollupBatchRows,
  compactBatchRollupSummary,
  rowsFromLiveBatch,
  rowsFromLegacyResult,
  rowsFromPersistedSummary,
  rowsFromUnknown,
  shouldRenderBatchProgressCard,
  type BatchRowsRollup,
} from './batchProgressViewModel';

interface MessageGroupProps {
  conversationId: string;
  messages: Message[];
  isLastGroup?: boolean;
  // When set and this group contains that message, briefly ring-highlight the
  // group (search-hit jump target). Cleared by the parent after a timeout.
  highlightMessageId?: string | null;
}

// Home dir is resolved once per app session and cached at module level so the
// common case (subsequent message groups) gets it synchronously. Used to expand
// `~/...` cp/mv destinations when deciding whether a copy escaped the workspace.
let cachedHome: string | null = null;
function useHomeDir(): string | null {
  const [home, setHome] = useState<string | null>(cachedHome);
  useEffect(() => {
    if (cachedHome !== null) return;
    homeDir().then((h) => { cachedHome = h; setHome(h); }).catch(() => {});
  }, []);
  return home;
}

/** Collapsed fold-row summarising all patch/edit calls for one skill. */
function SkillPatchSummaryRow({ skillName, calls }: { skillName: string; calls: ToolCall[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-elevated)] transition-colors"
      >
        <Sparkles className="h-3.5 w-3.5 text-[var(--abu-clay)] flex-shrink-0" />
        <span className="flex-1 text-left">
          {t.toolbox.skillPatchGroupLabel}{' '}
          <span className="font-medium text-[var(--abu-text-primary)]">{skillName}</span>
          <span className="text-[var(--abu-text-muted)]">{format(t.toolbox.skillPatchGroupCount, { count: calls.length })}</span>
        </span>
        {expanded
          ? <ChevronDown className="h-3 w-3 flex-shrink-0" />
          : <ChevronRight className="h-3 w-3 flex-shrink-0" />
        }
      </button>
      {expanded && (
        <div className="mt-0.5 ml-5 space-y-0.5">
          {calls.map((tc) => {
            let msg = '';
            try { msg = (JSON.parse(tc.result ?? '{}') as { message?: string }).message ?? ''; } catch { /* empty */ }
            return msg ? (
              <div key={tc.id} className="text-caption text-[var(--abu-text-muted)] px-2 py-0.5">
                {msg}
              </div>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

// Elapsed time for the in-run status divider ("已处理 Ns"), ticking once per
// second while `active` — the same 1s-interval + wall-clock pattern Codex uses
// for its "Working for {time}" divider. Inert (0, no interval) when inactive,
// so settled groups and pure-text runs pay nothing.
function useRunElapsedMs(startMs: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  if (!active || startMs == null) return 0;
  return Math.max(0, now - startMs);
}

/**
 * In-run ticking status divider ("处理中" / "已处理 Ns"), Codex-aligned: plain
 * text, not a button — no fold exists until the run settles, when the fold
 * header button takes this exact slot as a 1:1 row swap.
 *
 * ALWAYS grows in on mount (Codex animates its "Working for" divider the same
 * way). The dots slot is NOT this row's to take: when the first process
 * segment lands, TaskBlock's own header row is the dots row's designated
 * same-slot successor (see ThinkingStatusLine), so at that commit the instant
 * height budget is already spent (dots out, TaskBlock header in, net zero) —
 * a non-animated divider on top was measured as the same one-frame +46px jump
 * as the original bug. Growing in keeps every frame continuous: the thinking
 * row slides down one row-height over 200ms instead of teleporting.
 */
function RunStatusDivider({ label }: { label: string }) {
  return (
    <div className="block-expand block-expand-open block-expand-enter">
      <div className="mb-2 text-body text-[var(--abu-text-muted)] tabular-nums">
        {label}
      </div>
    </div>
  );
}

// Codex-style compact duration for the work-process fold label: "1m 4s" / "39s".
function formatWorkDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function emptyBatchRollup(): BatchRowsRollup {
  return { total: 0, succeeded: 0, failed: 0, stopped: 0, incomplete: 0, running: 0, queued: 0, unknown: 0 };
}

function addBatchRollup(target: BatchRowsRollup, source: BatchRowsRollup): BatchRowsRollup {
  target.total += source.total;
  target.succeeded += source.succeeded;
  target.failed += source.failed;
  target.stopped += source.stopped;
  target.incomplete += source.incomplete;
  target.running += source.running;
  target.queued += source.queued;
  target.unknown += source.unknown;
  return target;
}

// Helper to get text content from Message
function getTextContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  const textBlock = content.find((c) => c.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '';
}

// Build a standalone thinking ExecutionStep from a message's own thinking.
// Thinking is rebuilt per-message (not hoisted) so it renders in true order.
function buildThinkingStep(msg: Message): ExecutionStep {
  return {
    id: `thinking-${msg.id}`,
    executionId: '',
    type: 'thinking',
    label: '思考中...',
    detail: msg.thinking ?? '',
    status: msg.thinkingDuration != null ? 'completed' : (msg.isStreaming ? 'running' : 'completed'),
    toolName: '',
    toolInput: {},
    source: 'agent',
    detailBlocks: [],
    duration: msg.thinkingDuration,
  };
}

// Extract image src from markdown ![alt](src) syntax
function extractMarkdownImages(text: string): string[] {
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  const srcs: string[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    srcs.push(m[1]);
  }
  return srcs;
}

function stripMarkdownImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]+\)\n?/g, '').trim();
}

const LEGACY_STOP_MARKER = /\s*\*\[已停止\]\*\s*$/;

/** Backward compatibility for transcripts written before runState terminals. */
// eslint-disable-next-line react-refresh/only-export-components
export function hasPersistedStopState(messages: Message[]): boolean {
  return messages.some((message) =>
    (message.role === 'user' && message.runState === 'interrupted')
    || (message.role === 'assistant' && message.stopReason === 'user')
    || (message.role === 'assistant'
      && typeof message.content === 'string'
      && LEGACY_STOP_MARKER.test(message.content)),
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function stripLegacyStopMarker(text: string): string {
  return text.replace(LEGACY_STOP_MARKER, '').trimEnd();
}

// --- Render segment types ---

type RenderSegment =
  | { kind: 'text'; text: string; message: Message; isLastTurn: boolean }
  | { kind: 'steps'; executionSteps: ExecutionStep[]; legacySteps: WorkflowStep[]; isLastGroup: boolean; stepsMsgs: Message[] }
  | { kind: 'plan'; toolCall: ToolCall }
  | { kind: 'widget'; toolCall: ToolCall }
  | { kind: 'batch'; toolCall: ToolCall; message: Message }
  | { kind: 'user'; message: Message };

function isBatchToolCall(toolCall: ToolCall): boolean {
  return toolCall.name === TOOL_NAMES.RUN_AGENT_BATCH;
}

function isStepBackedToolCall(toolCall: ToolCall): boolean {
  return !toolCall.hidden || isDisplayHiddenStepBackedTool(toolCall.name);
}

function claimExecutionStepIndex(
  toolCall: ToolCall,
  steps: ExecutionStep[],
  claimed: Set<number>,
  nominalIndex: number,
): number | undefined {
  const exactIndex = steps.findIndex((step, index) =>
    !claimed.has(index) && step.toolCallId === toolCall.id);
  if (exactIndex >= 0) {
    claimed.add(exactIndex);
    return exactIndex;
  }

  const positional = steps[nominalIndex];
  if (
    positional
    && !claimed.has(nominalIndex)
    && positional.toolCallId === undefined
    && positional.toolName === toolCall.name
  ) {
    claimed.add(nominalIndex);
    return nominalIndex;
  }
  return undefined;
}

function claimLegacyStepIndex(
  toolCall: ToolCall,
  steps: WorkflowStep[],
  claimed: Set<number>,
): number | undefined {
  const exactIndex = steps.findIndex((step, index) =>
    !claimed.has(index) && step.id === toolCall.id && step.toolName === toolCall.name);
  if (exactIndex >= 0) {
    claimed.add(exactIndex);
    return exactIndex;
  }
  return undefined;
}

/**
 * Build render segments from assistant messages and their steps.
 *
 * Produces alternating text and steps segments. Consecutive tool-only turns
 * are merged into a single 'steps' segment so they render as one TaskBlock.
 *
 * Order: text → merged steps → text → merged steps → ...
 *
 * Exported for unit testing (pure, no React).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function buildRenderSegments(
  messages: Message[],
  allExecSteps: ExecutionStep[],
  allLegacySteps: WorkflowStep[],
  hasBatchCardState: (message: Message, toolCall: ToolCall) => boolean = (_message, toolCall) =>
    shouldRenderBatchProgressCard(toolCall),
): RenderSegment[] {
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  if (assistantMsgs.length === 0) return [];

  // Tool steps only. Thinking is rebuilt per-message from msg.thinking so it
  // renders in true chronological position; any thinking-typed step from
  // upstream (synth or eventRouter) is discarded here.
  const toolExecSteps = allExecSteps.filter((s) => s.type !== 'thinking');
  const toolLegacySteps = allLegacySteps.filter((s) => {
    if (s.type === 'thinking' || typeof s.toolName !== 'string') return false;
    return true;
  });

  const segments: RenderSegment[] = [];
  let pendingExecSteps: ExecutionStep[] = [];
  let pendingLegacySteps: WorkflowStep[] = [];
  let pendingStepsMsgs: Message[] = [];

  const flushSteps = () => {
    if (pendingExecSteps.length > 0 || pendingLegacySteps.length > 0) {
      segments.push({
        kind: 'steps',
        executionSteps: pendingExecSteps,
        legacySteps: pendingLegacySteps,
        isLastGroup: false,
        stepsMsgs: pendingStepsMsgs,
      });
      pendingExecSteps = [];
      pendingLegacySteps = [];
      pendingStepsMsgs = [];
    }
  };

  let nominalStepIndex = 0;
  let passedFirstAssistant = false;
  let assistantIdx = 0;
  const seenBatchKeys = new Set<string>();
  const claimedExecStepIndices = new Set<number>();
  const claimedLegacyStepIndices = new Set<number>();

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (!passedFirstAssistant) continue; // leading user → rendered by top bubble
      flushSteps();
      segments.push({ kind: 'user', message: msg });
      continue;
    }
    if (msg.role !== 'assistant') continue;

    passedFirstAssistant = true;
    const isLastTurn = assistantIdx === assistantMsgs.length - 1;
    assistantIdx++;

    // 1. Thinking — accumulate as the first step of this message's block (in true
    //    order, before its tools). NOT a flush boundary, so consecutive
    //    thinking+tool turns merge into one collapsible block instead of many
    //    separate "思考了 N 秒" rows. Only text/plan/user break the block.
    if (msg.thinking && msg.thinking.trim().length > 0) {
      pendingExecSteps.push(buildThinkingStep(msg));
    }

    // Match this message's tool calls against the global raw step streams.
    // Exact toolCallId matches can be anywhere still unclaimed; old snapshots
    // without toolCallId only fall back to the same absolute declared position
    // and same tool name, so a missing earlier step cannot shift later tools.
    const toolCalls = msg.toolCalls || [];

    // 2. Text — flush accumulated tool steps, then emit text.
    const text = getTextContent(msg.content);
    if (text) {
      flushSteps();
      segments.push({ kind: 'text', text, message: msg, isLastTurn });
    }

    // 3. Tool calls — consume every raw step-backed position first, then route
    // special UI calls (plan/widget/batch) at their exact call site. Generic
    // steps exclude raw slots claimed by those special calls, preventing a
    // duplicate generic row plus the dedicated card.
    const addPendingStepsMessage = () => {
      if (!pendingStepsMsgs.some((pendingMsg) => pendingMsg.id === msg.id)) {
        pendingStepsMsgs.push(msg);
      }
    };
    for (const toolCall of toolCalls) {
      if (!isStepBackedToolCall(toolCall)) {
        if (toolCall.name === TOOL_NAMES.REPORT_PLAN && parsePlanSteps(toolCall).length > 0) {
          flushSteps();
          segments.push({ kind: 'plan', toolCall });
        }
        continue;
      }

      const batchKey = `${msg.id}\u0000${toolCall.id}`;
      if (isBatchToolCall(toolCall) && seenBatchKeys.has(batchKey)) {
        continue;
      }

      const currentNominalIndex = nominalStepIndex;
      nominalStepIndex++;
      const execStepIndex = claimExecutionStepIndex(toolCall, toolExecSteps, claimedExecStepIndices, currentNominalIndex);
      const legacyStepIndex = claimLegacyStepIndex(toolCall, toolLegacySteps, claimedLegacyStepIndices);
      const execStep = execStepIndex === undefined ? undefined : toolExecSteps[execStepIndex];
      const legacyStep = legacyStepIndex === undefined ? undefined : toolLegacySteps[legacyStepIndex];

      if (isDisplayHiddenStepBackedTool(toolCall.name)) {
        flushSteps();
        segments.push({ kind: 'widget', toolCall });
        continue;
      }

      if (isBatchToolCall(toolCall)) {
        if (hasBatchCardState(msg, toolCall) && !seenBatchKeys.has(batchKey)) {
          flushSteps();
          segments.push({ kind: 'batch', toolCall, message: msg });
          seenBatchKeys.add(batchKey);
          continue;
        }
        // A terminal legacy call whose result does not match either historical
        // batch contract falls back to the generic tool step. This keeps its
        // actual result text visible instead of manufacturing "unknown" rows.
        if (execStep && !isDisplayHiddenStepBackedTool(execStep.toolName)) {
          pendingExecSteps.push(execStep);
          addPendingStepsMessage();
        }
        if (legacyStep && !isDisplayHiddenStepBackedTool(legacyStep.toolName)) {
          pendingLegacySteps.push(legacyStep);
          addPendingStepsMessage();
        }
        seenBatchKeys.add(batchKey);
        continue;
      }

      if (execStep && !isDisplayHiddenStepBackedTool(execStep.toolName)) {
        pendingExecSteps.push(execStep);
        addPendingStepsMessage();
      }
      if (legacyStep && !isDisplayHiddenStepBackedTool(legacyStep.toolName)) {
        pendingLegacySteps.push(legacyStep);
        addPendingStepsMessage();
      }
    }
  }

  flushSteps();

  // Mark the last 'steps' segment (pulse/collapse logic in the consumer).
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'steps') {
      (segments[i] as Extract<RenderSegment, { kind: 'steps' }>).isLastGroup = true;
      break;
    }
  }

  return segments;
}

// Index (exclusive) up to which segments fold into the collapsible "工作过程"
// group. Segments [0, foldEnd) fold; [foldEnd, end) render inline. When the
// turn is done and ends in a text answer, the fold stops at that answer;
// otherwise (text-first with no closing answer, process after the last text)
// the whole group folds. Authored content is still never hidden: the collapsed
// render branch filters segments by kind and keeps text/user segments visible
// unconditionally — the swallow bug this replaced lived in that filter, not in
// the fold range.
//
// While the run is still in progress the fold does not exist at all (null):
// the settled "用时 Xs" header is a completed-turn summary, and mounting the
// header row mid-run inserted ~28px above the live thinking/step block — under
// SmoothHeight's 40px threshold, so it landed as a one-frame jump. Deferring
// the whole wrapper keeps the in-run row structure stable (the typing dots
// swap 1:1 with TaskBlock's first row) and the header only appears together
// with the completion collapse, which SmoothHeight bridges.
// eslint-disable-next-line react-refresh/only-export-components
export function computeWorkProcessFold(segments: RenderSegment[], isDone: boolean): number | null {
  if (!isDone) return null;
  const hasProcess = segments.some((segment) =>
    segment.kind === 'steps' || segment.kind === 'plan' || segment.kind === 'batch');
  if (!hasProcess) return null;
  let lastTextIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'text') { lastTextIdx = i; break; }
  }
  const hasProcessAfterLastText = lastTextIdx >= 0 && segments
    .slice(lastTextIdx + 1)
    .some((segment) => segment.kind === 'steps' || segment.kind === 'plan' || segment.kind === 'batch');
  if (lastTextIdx > 0 && !hasProcessAfterLastText) return lastTextIdx;
  return segments.length;
}

/**
 * Whether the still-streaming assistant message has emitted anything the
 * timeline will render yet — text, thinking, or a step/plan/widget-backed tool
 * call. Drives the "思考中…" typing dots, which must track the CURRENT turn, not
 * the whole group: agentLoop spawns a fresh empty assistant placeholder per turn,
 * so once a plan card (or any earlier segment) renders, a group-wide "has
 * content" gate would silence the next turn's empty placeholder — leaving dead
 * space under the plan card while the agent is actively generating the next tool
 * call. A report_plan with empty steps renders nothing, so it does not count.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function streamingTurnHasRenderableContent(msg: Message | undefined): boolean {
  if (!msg) return false;
  if (getTextContent(msg.content).trim().length > 0) return true;
  if (msg.thinking && msg.thinking.trim().length > 0) return true;
  return (msg.toolCalls || []).some((tc) =>
    tc.name === TOOL_NAMES.REPORT_PLAN ? parsePlanSteps(tc).length > 0 : true,
  );
}

/**
 * Groups multiple messages from the same agent loop into a single visual block.
 * User messages render standalone, assistant messages share one avatar.
 * Renders text → merged tool steps, with consecutive tool-only turns combined.
 */
export default function MessageGroup({ conversationId, messages, isLastGroup: isLastGroupProp = false, highlightMessageId = null }: MessageGroupProps) {
  const { t } = useI18n();
  // Separate user and assistant messages
  const userMsg = messages.find((m) => m.role === 'user');
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  const activeConv = useActiveConversation();
  const activeConversationId = activeConv?.id ?? null;
  const agentStatus = useChatStore((s) => getConversationAgentState(s.agentStates, activeConversationId).status);
  const home = useHomeDir();

  // Get loopId from messages (all messages in group share same loopId)
  const loopId = messages[0]?.loopId;

  // Try to get execution from TaskExecutionStore (new architecture)
  const execution = useTaskExecutionStore((s) => {
    if (!loopId) return undefined;
    return s.getExecutionByLoopId(loopId);
  });
  const executionSteps = execution?.steps;

  // Fallback: if no live execution data, try persisted snapshot from message
  const persistedExecutionSteps = useMemo(() => {
    if (executionSteps && executionSteps.length > 0) return undefined;
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const msgWithSnapshot = [...assistantMessages].reverse().find((m) => m.executionSteps && m.executionSteps.length > 0);
    if (!msgWithSnapshot?.executionSteps) return undefined;
    // Image payloads are not stored in the snapshot (it stays lean); look them
    // back up from the group's tool calls. The snapshot lives on the LAST
    // assistant message while the tool call that produced the image sits on an
    // earlier one, so the lookup must span the whole group, not just
    // msgWithSnapshot.
    //
    // `messages` is a fresh array every render (ChatView builds messageGroups
    // unmemoized on purpose), so this memo does recompute often. That is kept
    // deliberately: narrowing the dep to the snapshot array alone would miss a
    // tool result that lands or changes after the snapshot exists, and a missed
    // recompute brings the placeholder-instead-of-image bug back silently. The
    // cost it would save is already gone — backfillDetailBlockImages hands back
    // the SAME imageData object for an unchanged tool call (WeakMap), so the
    // expensive part downstream (DetailBlockView's data-URL useMemo over a
    // multi-MB base64) stays cached across these recomputes.
    return backfillDetailBlockImages(
      snapshotToExecutionSteps(msgWithSnapshot.executionSteps),
      messages,
    );
  }, [executionSteps, messages]);

  // Check if THIS execution is active (not global status)
  const isThisExecutionActive = execution?.status === 'running';

  // Reliable-run state on the user message is the canonical persisted
  // terminal. Assistant stopReason and the old markdown marker remain only as
  // compatibility fallbacks for transcripts written before that protocol.
  const isStopped = execution?.status === 'cancelled'
    || hasPersistedStopState(messages);

  // Check if any message is still streaming
  const isStreaming = assistantMsgs.some((m) => m.isStreaming);

  // Get last message for actions
  const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];

  // Aggregate all tool calls from assistant messages
  const allToolCalls = useMemo<ToolCall[]>(
    () => assistantMsgs.flatMap((m) => m.toolCalls || []),
    [assistantMsgs]
  );
  const legacyWorkflowToolCalls = useMemo<ToolCall[]>(() => {
    const seenBatchKeys = new Set<string>();
    return assistantMsgs.flatMap((message) => (message.toolCalls || []).filter((toolCall) => {
      if (!isBatchToolCall(toolCall)) return true;
      const batchKey = `${message.id}\u0000${toolCall.id}`;
      if (seenBatchKeys.has(batchKey)) return false;
      seenBatchKeys.add(batchKey);
      return true;
    }));
  }, [assistantMsgs]);
  // Extract search results: prefer structured data from tool calls, fallback to text parsing
  const searchResults = useMemo(() => {
    const fromTools = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.toolCalls || [])
      .flatMap((tc) => {
        if (tc.name !== TOOL_NAMES.WEB_SEARCH || !tc.result) return [];
        return parseSearchResults(tc.result) ?? [];
      });
    if (fromTools.length > 0) return fromTools;

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;
      const text = typeof msg.content === 'string'
        ? msg.content
        : getTextContent(msg.content);
      if (!text) continue;
      const fromText = parseSourcesFromText(text);
      if (fromText && fromText.length > 0) return fromText;
    }

    return [];
  }, [messages]);

  // Highlighted source index for citation click
  const [highlightedSource, setHighlightedSource] = useState<number | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const workProcessRef = useRef<HTMLDivElement>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    return () => { clearTimeout(highlightTimerRef.current); };
  }, []);

  const handleCitationClick = useCallback((index: number) => {
    setHighlightedSource(index);
    requestAnimationFrame(() => {
      const card = groupRef.current?.querySelector(`[data-source-index="${index}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedSource(null), 2000);
  }, []);

  // Aggregate thinking content from all messages
  const thinkingContent = assistantMsgs
    .map((m) => m.thinking)
    .filter(Boolean)
    .join('\n');

  const thinkingDuration = assistantMsgs.find((m) => m.thinkingDuration)?.thinkingDuration;

  // Get skill info from user message (if skill was triggered)
  const skillInfo = userMsg?.skill;

  // Extract workflow steps from all tool calls (legacy fallback)
  // Only pass the active conversation's agent status to the currently streaming
  // group — prevents another running conversation from injecting a phantom
  // thinking step into completed groups.
  const workflowSteps = extractWorkflowSteps(legacyWorkflowToolCalls, thinkingContent, isStreaming ? agentStatus : undefined, skillInfo, thinkingDuration);

  // Extract file outputs for attachments — deliverables semantics: only show
  // what the AI actually produced this turn. extractFileOutputs (deliverables
  // mode) applies the DOCUMENT_EXTENSIONS whitelist + script filtering.
  //
  // Source 1: tool calls (reliable, primary). Source 2: last assistant message
  // text — fallback for paths the LLM announces in prose ("已保存到 X") but
  // never appear in toolCall.input.path (e.g. python subprocess writing files
  // not visible to the agent loop).
  const fileOutputs = useMemo(() => {
    const files = extractFileOutputs(allToolCalls, {
      mode: 'deliverables',
      // Drop cards for files cp/mv'd outside the workspace boundary — those are
      // duplicates at a location the user already knows, not fresh artifacts.
      // Only applied here (chat cards); right-panel audit + snapshots keep them.
      ...(home ? { dropCopiesOutside: { dirs: allWorkingDirectories(), home } } : {}),
    });
    // Path-only dedup for the text fallback. basename dedup was removed
    // (cross-turn same-basename writes are legitimate, e.g. todo skill
    // writing 2026-04-{28,29,30}.md).
    const seenPaths = new Set(files.map(f => f.path));
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    if (lastMsg) {
      const text = getTextContent(lastMsg.content);
      if (text) {
        const textPaths = extractFilePathsFromText(text);
        for (const rawP of textPaths) {
          // Normalize to match the same normalization in extractFileOutputs.
          // Strip markdown formatting (**, __, ``) that wraps filenames in LLM text.
          // NOTE: do NOT strip leading `~` — it could be a real ~/path home-relative reference.
          const p = rawP
            .replace(/^[*_`]+/, '')
            .replace(/[*_`~)）\]】}"'。，,;；:：.]+$/, '')
            .trim().replace(/\\/g, '/');
          if (!p) continue;
          if (!seenPaths.has(p)) {
            seenPaths.add(p);
            files.push({ path: p, operation: 'create' });
          }
        }
      }
    }
    return files;
  }, [allToolCalls, assistantMsgs, home]);

  // Check if any tool is executing
  const isAnyExecuting = allToolCalls.some((tc) => tc.isExecuting);

  // Check if any tool has error result
  const hasError = allToolCalls.some((tc) => tc.result?.toLowerCase().includes('error'));

  // Auto-preview: only when agent transitions from running → done (not on mount/conversation switch)
  const openPreview = usePreviewStore((s) => s.openPreview);
  const isAgentDone = !isStreaming && !isThisExecutionActive && activeConv?.status !== 'running';
  // File card display: previous groups are already done — only the last group needs the
  // global conversation status check to filter intermediate temp files during execution.
  const isGroupDone = !isStreaming && !isThisExecutionActive &&
    (!isLastGroupProp || activeConv?.status !== 'running');
  const prevAgentDoneRef = useRef(isAgentDone);
  useEffect(() => {
    const wasDone = prevAgentDoneRef.current;
    prevAgentDoneRef.current = isAgentDone;
    // Only trigger on false→true transition for the LAST group (prevent old groups from re-triggering)
    if (!isLastGroupProp || wasDone || !isAgentDone || fileOutputs.length === 0) return;
    const nonImageFiles = fileOutputs.filter((f) => !isImageFile(f.path));
    const previewableFile = nonImageFiles[nonImageFiles.length - 1] || fileOutputs[fileOutputs.length - 1];
    if (previewableFile) {
      // Resolve through outputSnapshots so we never hand a non-absolute / missing
      // path to openPreview (which would trigger a Tauri capability error).
      import('@/core/session/outputSnapshots').then(({ resolveFileSource }) => {
        resolveFileSource(activeConv?.id, previewableFile.path).then((r) => {
          if (r.status === 'available') openPreview(r.path);
        }).catch(() => {});
      }).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- isLastGroupProp omitted: adding it would re-trigger preview when a new group demotes this one
  }, [isAgentDone, fileOutputs, openPreview, activeConv?.id]);

  // Rewind confirm state: handleRetry's deleteMessagesFrom truncates from
  // this loop's first assistant message onward, discarding anything after —
  // silently, if this isn't the conversation's last loop. See
  // computeRewindImpact for the "later turns exist" check.
  const [pendingRewind, setPendingRewind] = useState<{ laterTurnsCount: number; run: () => void } | null>(null);

  // Handle retry
  const handleRetry = async () => {
    if (!userMsg || !activeConv?.id) return;
    const convId = activeConv.id;
    const userContent = getTextContent(userMsg.content);

    const retryImages = rebuildImageAttachments(userMsg.content, 'retry');

    const firstAssistantInLoop = assistantMsgs[0];

    const proceed = async () => {
      if (firstAssistantInLoop) {
        useChatStore.getState().deleteMessagesFrom(convId, firstAssistantInLoop.id);
      }
      announceChatTurnScrollIntent({ conversationId: convId, source: 'run-retry' });
      await runAgentLoopDispatched(convId, userContent, { images: retryImages });
    };

    const impact = computeRewindImpact(activeConv.messages, loopId, userMsg.id);
    if (impact.hasLaterTurns) {
      setPendingRewind({ laterTurnsCount: impact.laterTurnsCount, run: proceed });
      return;
    }
    await proceed();
  };

  // Tool execution steps for this loop. Thinking is rebuilt per-message inside
  // buildRenderSegments, so no synthesized thinking step is prepended here.
  const activeExecSteps = useMemo(() => {
    return (executionSteps && executionSteps.length > 0)
      ? executionSteps
      : persistedExecutionSteps ?? [];
  }, [executionSteps, persistedExecutionSteps]);

  const liveBatches = useBatchProgressStore((s) => s.batches);

  // Build render segments: text and merged step groups
  const segments = useMemo(
    () => buildRenderSegments(messages, activeExecSteps, workflowSteps, (message, toolCall) => {
      const identity: BatchIdentity = {
        conversationId,
        assistantMessageId: message.id,
        batchToolCallId: toolCall.id,
      };
      return liveBatches[makeBatchKey(identity)] !== undefined
        || shouldRenderBatchProgressCard(toolCall, identity);
    }),
    [messages, activeExecSteps, workflowSteps, conversationId, liveBatches]
  );
  const batchSegments = useMemo(
    () => segments.filter((seg): seg is Extract<RenderSegment, { kind: 'batch' }> => seg.kind === 'batch'),
    [segments],
  );
  const batchRollup = useMemo(() => {
    return batchSegments.reduce<BatchRowsRollup>((rollup, segment) => {
      const identity: BatchIdentity = {
        conversationId,
        assistantMessageId: segment.message.id,
        batchToolCallId: segment.toolCall.id,
      };
      const liveBatch = liveBatches[makeBatchKey(identity)];
      const rows = liveBatch
        ? rowsFromLiveBatch(liveBatch, Date.now())
        : rowsFromPersistedSummary(identity, segment.toolCall, t)
          ?? rowsFromLegacyResult(segment.toolCall, t)
          ?? (segment.toolCall.isExecuting ? rowsFromUnknown(segment.toolCall, t) : undefined);
      if (!rows) return rollup;
      return addBatchRollup(rollup, rollupBatchRows(rows));
    }, emptyBatchRollup());
  }, [batchSegments, conversationId, liveBatches, t]);

  // Typing-dots gate: track the message that is actually streaming, NOT the
  // whole group. agentLoop spawns a fresh empty assistant message per turn, so a
  // finished plan card earlier in the group must not silence the next turn's
  // empty placeholder (else: dead space under the plan card while the agent is
  // actively generating). See streamingTurnHasRenderableContent.
  const streamingMsg = assistantMsgs.find((m) => m.isStreaming);
  const streamingHasContent = streamingTurnHasRenderableContent(streamingMsg);

  // Codex-style turn collapse: once a turn is done and has a final text answer,
  // fold all intermediate segments (thinking/plan/steps) behind a single row.
  const workFoldEnd = useMemo(() => computeWorkProcessFold(segments, isGroupDone), [segments, isGroupDone]);
  const foldKey = useMemo(
    () => makeWorkProcessFoldKey(conversationId, loopId, userMsg?.id, assistantMsgs[0]?.id),
    [conversationId, loopId, userMsg?.id, assistantMsgs],
  );
  const foldEntry = useWorkProcessFoldStore((s) => s.entries[foldKey]);
  const [foldFocusVersion, setFoldFocusVersion] = useState(0);
  useEffect(() => {
    useWorkProcessFoldStore.getState().touch(conversationId, foldKey);
  }, [conversationId, foldKey]);
  // Fold header label: Codex-style duration + completed/aborted variant. Prefer
  // the execution's start/end timing; fall back to message timestamps when the
  // execution has been evicted (older groups). Aborted = execution cancelled.
  const workStart = execution?.startTime ?? userMsg?.timestamp ?? assistantMsgs[0]?.timestamp;
  const workEnd = execution?.endTime ?? userMsg?.runEndedAt ?? lastAssistantMsg?.timestamp;
  const workSpanMs = workStart != null && workEnd != null ? Math.max(0, workEnd - workStart) : 0;
  // The message-timestamp span under-counts (the last message's own thinking/
  // generation isn't captured — its timestamp is set at creation — and the live
  // execution with the accurate endTime is usually evicted by the time this
  // settled fold renders). Floor the total at the sum of visible step durations
  // so "用时 X" is never less than the thinking/tool times the user can add up.
  const workStepsSec =
    assistantMsgs.reduce((a, m) => a + (m.thinkingDuration ?? 0), 0) +
    activeExecSteps.filter((s) => s.type !== 'thinking').reduce((a, s) => a + (s.duration ?? 0), 0);
  const workDurationMs = Math.max(workSpanMs, workStepsSec * 1000);
  const stoppedLabel = workDurationMs > 0
    ? format(t.chat.stoppedAfter, { duration: formatWorkDuration(workDurationMs) })
    : t.chat.runInterrupted;
  const workLabel = isStopped
    ? stoppedLabel
    : format(t.chat.workedFor, { duration: formatWorkDuration(workDurationMs) });
  const batchAggregateLabel = batchRollup.total > 0
    ? format(t.batch.foldBatchAggregate, {
      total: batchRollup.total,
      summary: compactBatchRollupSummary(batchRollup, t),
    })
    : '';
  const foldHeaderLabel = batchAggregateLabel ? `${workLabel} · ${batchAggregateLabel}` : workLabel;
  // Codex-aligned in-run status divider: appears (animated) with the first
  // process segment, ticks every second, and is NOT interactive — collapse
  // only exists once the run settles and the fold header takes this exact
  // slot ("已处理 Ns" → "用时 Ns" as a 1:1 row swap, no layout change).
  const hasProcessSegments = segments.some(
    (seg) => seg.kind === 'steps' || seg.kind === 'plan' || seg.kind === 'batch');
  const showRunStatusLine = !isGroupDone && !isStopped && hasProcessSegments;
  const runElapsedMs = useRunElapsedMs(workStart, showRunStatusLine);
  // Sub-second elapsed shows the plain "处理中" (Codex: "Working") so the very
  // first paint never reads "已处理 0s".
  const runStatusLabel = runElapsedMs >= 1000
    ? format(t.chat.workingFor, { duration: formatWorkDuration(runElapsedMs) })
    : t.chat.working;
  const foldMode = foldEntry?.mode ?? 'auto';
  const workExpanded = foldMode === 'expanded' || (foldMode === 'auto' && !(foldEntry?.autoCollapseHandled ?? false));
  const hasFinalAnswerOutsideFold = workFoldEnd !== null && workFoldEnd < segments.length && segments[workFoldEnd]?.kind === 'text';
  const canAutoCollapseFold =
    foldMode === 'auto'
    && !(foldEntry?.autoCollapseHandled ?? false)
    && isGroupDone
    && !isStopped
    && userMsg?.runState !== 'failed'
    && userMsg?.runState !== 'connection-failed'
    && userMsg?.runState !== 'interrupted'
    && hasFinalAnswerOutsideFold
    && batchRollup.failed === 0
    && batchRollup.stopped === 0
    && batchRollup.incomplete === 0
    && batchRollup.running === 0
    && batchRollup.queued === 0
    && batchRollup.unknown === 0;

  useEffect(() => {
    if (!canAutoCollapseFold) return;
    if (workProcessRef.current?.contains(document.activeElement)) return;
    useWorkProcessFoldStore.getState().markAutoCollapsed(conversationId, foldKey);
  }, [canAutoCollapseFold, conversationId, foldKey, foldFocusVersion]);

  // Per-segment render callback — extracted from the map so it can be reused
  // against two slices (folded + tail) without duplicating logic. Closes over
  // all the variables it needs from the component scope.
  const renderSegment = (seg: RenderSegment, segIdx: number) => {
    if (seg.kind === 'user') {
      return (
        <MessageErrorBoundary key={`user-mid-${seg.message.id}`}>
          <MessageBubble message={seg.message} />
        </MessageErrorBoundary>
      );
    }

    if (seg.kind === 'text') {
      const allMdImages = extractMarkdownImages(seg.text);
      // Drop markdown images that point to a file this turn already renders as a
      // file-output card (e.g. generate_image's saved PNG that the model also
      // helpfully embedded as ![](path)) — otherwise the same image shows twice
      // (thumbnail + ImagePreviewCard). Match by basename since generated files
      // have unique timestamped names. Non-output images (web URLs, pre-existing
      // files) still render as thumbnails.
      const baseOf = (p: string) => (p.split(/[/\\]/).pop() || p).trim();
      const outputBasenames = new Set(fileOutputs.map((f) => baseOf(f.path)));
      const mdImages = allMdImages.filter((src) => !outputBasenames.has(baseOf(src)));
      // Always strip ALL markdown images from the rendered text (MarkdownRenderer
      // drops <img> anyway); the ones we keep are shown as ImageThumbnail below.
      let cleanedText = allMdImages.length > 0 ? stripMarkdownImages(seg.text) : seg.text;
      if (searchResults.length > 0 && cleanedText) {
        cleanedText = stripSourcesBlock(cleanedText);
      }
      if (isStopped) {
        cleanedText = stripLegacyStopMarker(cleanedText);
      }
      const showCursor = seg.isLastTurn && seg.message.isStreaming && !!cleanedText;

      return (
        <div key={`text-${seg.message.id || segIdx}`}>
          {mdImages.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {mdImages.map((src, i) => (
                <ImageThumbnail key={`${src}-${i}`} src={src} />
              ))}
            </div>
          )}
          {cleanedText && (
            <div className="text-[var(--abu-text-primary)] break-words mb-2 select-text">
              <MarkdownRenderer
                content={cleanedText}
                searchResults={searchResults.length > 0 ? searchResults : undefined}
                onCitationClick={searchResults.length > 0 ? handleCitationClick : undefined}
              />
            </div>
          )}
          {showCursor && <span className="streaming-cursor" />}
        </div>
      );
    }

    if (seg.kind === 'plan') {
      return (
        <MessageErrorBoundary key={`plan-${seg.toolCall.id}`}>
          <PlanStepsCard toolCall={seg.toolCall} />
        </MessageErrorBoundary>
      );
    }

    if (seg.kind === 'widget') {
      return (
        <MessageErrorBoundary key={`widget-${seg.toolCall.id}`}>
          <ShowWidgetCard toolCall={seg.toolCall} />
        </MessageErrorBoundary>
      );
    }

    if (seg.kind === 'batch') {
      const identity: BatchIdentity = {
        conversationId,
        assistantMessageId: seg.message.id,
        batchToolCallId: seg.toolCall.id,
      };
      return (
        <MessageErrorBoundary key={`batch-${makeBatchKey(identity)}`}>
          <BatchProgress
            identity={identity}
            toolCall={seg.toolCall}
          />
        </MessageErrorBoundary>
      );
    }

    // kind === 'steps' — merged TaskBlock
    const hasExecSteps = seg.executionSteps.length > 0;
    const hasLegacySteps = seg.legacySteps.length > 0;

    // "Active" means the steps area should still pulse / show live state.
    // Trust isStreaming as a per-group signal — it's always accurate after
    // the finishStreaming(msgId) fix. Gate isThisExecutionActive on
    // isLastGroupProp because the per-loop TaskExecution status can stay
    // stale on older groups (this was the original "执行中..." stuck bug).
    const execActive = isLastGroupProp && isThisExecutionActive;
    const toolActive = isLastGroupProp && isAnyExecuting;
    const groupActive = seg.isLastGroup && (execActive || toolActive || isStreaming);

    // Auto-collapse rule for *non-trailing* steps segments (e.g. the
    // thinking block when body text is already streaming after it):
    // once all steps in this segment have completed, drop the active
    // signal so TaskBlock collapses, since the work has clearly moved
    // past this segment.
    //
    // For the *trailing* steps segment (no later segment in this group),
    // trust groupActive directly — even if the current step batch
    // happens to be momentarily complete (e.g. between a tool batch
    // finishing and the next LLM turn starting), we still want the
    // dots to keep pulsing so the user knows the loop is still going.
    const hasLaterSegment = segIdx < segments.length - 1;
    // Exclude ask_user_question from "running" check — that step is
    // waiting for user input, not processing, so we don't pulse while blocked.
    const execStepsRunning = seg.executionSteps.some(
      (s) => (s.status === 'running' || s.status === 'pending') && s.toolName !== TOOL_NAMES.ASK_USER_QUESTION,
    );
    const legacyStepsRunning = seg.legacySteps.some(
      (s) => s.status === 'running' || s.status === 'pending',
    );
    // For the trailing segment, only suppress pulsing if the sole running
    // step is ask_user_question (otherwise keep pulsing to show loop is alive).
    const onlyAskUserQuestionRunning =
      seg.executionSteps.some((s) => s.status === 'running' && s.toolName === TOOL_NAMES.ASK_USER_QUESTION) &&
      !execStepsRunning;
    const execIsActive = hasLaterSegment
      ? (groupActive && execStepsRunning)
      : (groupActive && !onlyAskUserQuestionRunning);
    const legacyIsActive = hasLaterSegment ? (groupActive && legacyStepsRunning) : groupActive;

    // Settled ask_user_question answers that belong to this steps segment
    const segSettledUQCards = activeConv?.id
      ? seg.stepsMsgs
          .flatMap((m) => m.toolCalls ?? [])
          .filter((tc) => tc.name === TOOL_NAMES.ASK_USER_QUESTION && tc.userQuestionAnswers)
      : [];

    return (
      <div key={`steps-${segIdx}`}>
        {hasExecSteps ? (
          <TaskBlock
            executionSteps={seg.executionSteps}
            isActive={execIsActive}
            isStopped={isStopped}
            onRetry={seg.isLastGroup && hasError && !isStreaming ? handleRetry : undefined}
          />
        ) : hasLegacySteps && (
          <TaskBlock
            steps={seg.legacySteps}
            isActive={legacyIsActive}
            isStopped={isStopped}
            onRetry={seg.isLastGroup && hasError && !isStreaming ? handleRetry : undefined}
          />
        )}
        {segSettledUQCards.map((tc) => (
          <UserQuestionCard key={`uq-${tc.id}`} toolCall={tc} />
        ))}
      </div>
    );
  };

  return (
    <div
      ref={groupRef}
      onBlur={() => {
        queueMicrotask(() => setFoldFocusVersion((version) => version + 1));
      }}
      className={cn(
        // transition-colors lives on the base class so the highlight fades both
        // in AND out (a conditional transition class vanishes with the bg and
        // makes the removal instant).
        'message-group w-full rounded-lg transition-colors duration-700',
        GROUP_CONTENT_GAP,
        highlightMessageId != null &&
          messages.some((m) => m.id === highlightMessageId) &&
          'bg-[var(--abu-clay-bg-15)]',
      )}
    >
      <ConfirmDialog
        open={!!pendingRewind}
        title={t.chat.rewindConfirmTitle}
        message={pendingRewind ? format(t.chat.rewindConfirmMessage, { count: String(pendingRewind.laterTurnsCount) }) : ''}
        confirmText={t.common.confirm}
        cancelText={t.common.cancel}
        onConfirm={() => {
          const run = pendingRewind?.run;
          setPendingRewind(null);
          run?.();
        }}
        onCancel={() => setPendingRewind(null)}
        variant="danger"
      />

      {/* User message renders standalone */}
      {userMsg && <MessageErrorBoundary><MessageBubble message={userMsg} /></MessageErrorBoundary>}

      {/* Multiple assistant messages grouped with single avatar */}
      {(assistantMsgs.length > 0 || isStopped) && (
        <div className="flex gap-3 w-full overflow-hidden group">
          {/* ABU Avatar - only shown once for the group */}
          <AssistantRowAvatar />

          {/* Content area */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {/* A stopped run is a turn terminal, not assistant-authored text.
                Render it even when Stop arrived before the first model token
                and the empty assistant placeholder was durably deleted. */}
            {isStopped && workFoldEnd == null && (
              <div className="text-body text-[var(--abu-text-muted)] mb-2">
                {stoppedLabel}
              </div>
            )}

            {/* SmoothHeight bridges the layout SWAPS inside this region — most
                importantly the completion fold: the expanded thinking/step
                block unmounts and the one-line "用时 Xs" header takes its
                place in the same render, a -100~200px one-frame shrink that
                (while pinned to the bottom) used to clamp scrollTop and jump
                the whole view down. Streamed token growth stays instant (it's
                under the wrapper's threshold); mount-direction growth is
                handled by .block-expand-enter inside TaskBlock. Enabled only
                for the last group — that's the only place the completion swap
                happens; settled history groups keep the wrapper (stable DOM,
                no child remounts when a new turn arrives) but observe nothing. */}
            <SmoothHeight enabled={isLastGroupProp}>
            {/* Typing dots — shown while the current turn is streaming but has not
                yet emitted any renderable content. Tracks the streaming message
                itself, so a plan card from an earlier turn in the same group does
                not suppress the dots for the fresh empty turn that follows. */}
            {isStreaming && !streamingHasContent && (
              /* mb-2 matches the TaskBlock header / "用时 Xs" fold header
                 buttons that replace this row in later states; the label
                 geometry itself lives in the shared ThinkingStatusLine. */
              <ThinkingStatusLine label={t.status.thinking} className="mb-2" />
            )}

            {/* Render segments: text blocks and merged step groups.
                When the turn is done and has a final text answer, all
                intermediate segments (thinking/plan/steps) are folded
                behind a single collapsible "工作过程" row (Codex-style).
                While the run is in progress workFoldEnd is null: everything
                renders inline and no header row exists yet — but the
                workProcessRef wrapper stays mounted either way, so the
                process subtree keeps its DOM parent when the fold appears
                at completion (no remount = keyboard focus survives, which
                the focus-deferred auto-collapse below relies on). */}
            <div ref={workProcessRef}>
              {showRunStatusLine && (
                <RunStatusDivider label={runStatusLabel} />
              )}
              {workFoldEnd != null && (
                /* Lightweight fold header — matches the thinking/step block
                    style (muted text + trailing chevron, no card background). */
                <button
                  type="button"
                  aria-expanded={workExpanded}
                  onClick={() => {
                    useWorkProcessFoldStore.getState().setMode(
                      conversationId,
                      foldKey,
                      workExpanded ? 'collapsed' : 'expanded',
                    );
                  }}
                  className="flex items-center gap-1 text-body text-[var(--abu-text-muted)] hover:text-[var(--abu-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-focus-ring)] rounded-sm transition-colors mb-2"
                >
                  <span>{foldHeaderLabel}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={cn('h-3.5 w-3.5 transition-transform', !workExpanded && '-rotate-90')}
                  />
                </button>
              )}
              {workFoldEnd == null || workExpanded
                ? segments.slice(0, workFoldEnd ?? segments.length).map((seg, i) => renderSegment(seg, i))
                : segments.slice(0, workFoldEnd)
                    /* Collapsing hides PROCESS segments only. Assistant text
                       and mid-loop user messages are authored conversation
                       content and must survive any fold state — hiding them
                       here was the "collapse swallows the answer" bug. Keep
                       the original segment index so keys stay stable across
                       fold toggles. */
                    .map((seg, i) => ({ seg, i }))
                    .filter(({ seg }) => seg.kind === 'widget' || seg.kind === 'text' || seg.kind === 'user')
                    .map(({ seg, i }) => renderSegment(seg, i))}
            </div>
            {workFoldEnd != null && segments.slice(workFoldEnd).map((seg, i) => renderSegment(seg, workFoldEnd + i))}
            </SmoothHeight>

            {/* Interactive notice cards (Module I) — skill proposals etc.
                MessageBubble's tool-call branch doesn't fire for assistant
                messages (MessageGroup renders TaskBlock + an actionsOnly
                MessageBubble), so the card has to be emitted here where
                `allToolCalls` is aggregated from every assistant message
                in this group. Rendered between the task workflow and the
                file outputs so proposals stay colocated with the agent
                turn that produced them. */}
            {activeConv?.id && allToolCalls.filter((tc) => tc.noticeCard).map((tc) => {
              const owningMsg = assistantMsgs.find((m) => m.toolCalls?.some((x) => x.id === tc.id));
              if (!owningMsg) return null;
              return (
                <SkillProposalCard
                  key={`notice-${tc.id}`}
                  conversationId={activeConv.id}
                  messageId={owningMsg.id}
                  toolCallId={tc.id}
                  card={tc.noticeCard!}
                  settledAction={tc.noticeCardAction}
                />
              );
            })}

            {activeConv?.id && allToolCalls.filter((tc) => tc.sandboxRecovery).map((tc) => {
              const owningMsg = assistantMsgs.find((m) => m.toolCalls?.some((x) => x.id === tc.id));
              if (!owningMsg) return null;
              return (
                <SandboxRecoveryCard
                  key={`sandbox-recovery-${tc.id}`}
                  conversationId={activeConv.id}
                  messageId={owningMsg.id}
                  toolCallId={tc.id}
                  recovery={tc.sandboxRecovery!}
                  settledAction={tc.sandboxRecoveryAction}
                />
              );
            })}

            {/* Grouped skill-patch summary — one collapsible fold-row per
                skill, replacing the old per-patch floating pills. */}
            {(() => {
              const patchCalls = allToolCalls.filter(
                (tc) =>
                  tc.name === TOOL_NAMES.SKILL_MANAGE &&
                  (tc.input?.['action'] === 'patch' || tc.input?.['action'] === 'edit'),
              );
              if (patchCalls.length === 0) return null;
              const bySkill = new Map<string, ToolCall[]>();
              for (const tc of patchCalls) {
                const key = (tc.input?.['name'] as string) || '?';
                if (!bySkill.has(key)) bySkill.set(key, []);
                bySkill.get(key)!.push(tc);
              }
              return Array.from(bySkill.entries()).map(([skillName, calls]) => (
                <SkillPatchSummaryRow key={`patch-${skillName}`} skillName={skillName} calls={calls} />
              ));
            })()}

            {/* File attachments - show when this group's execution is done.
                Previous groups always show; last group waits for global status
                to ensure intermediate scripts are properly filtered out. */}
            {fileOutputs.length > 0 && isGroupDone && (() => {
              const imageFiles = fileOutputs.filter((f) => isImageFile(f.path));
              const otherFiles = fileOutputs.filter((f) => !isImageFile(f.path));
              return (
                <>
                  {imageFiles.length > 0 && (
                    <div className="flex flex-wrap gap-3 mt-2">
                      {imageFiles.map((file) => (
                        <ImagePreviewCard key={file.path} filePath={file.path} />
                      ))}
                    </div>
                  )}
                  {otherFiles.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {otherFiles.map((file) => (
                        <FileAttachment key={file.path} filePath={file.path} operation={file.operation} />
                      ))}
                    </div>
                  )}
                </>
              );
            })()}

            {/* Sources section - below file attachments */}
            {searchResults.length > 0 && !isStreaming && (
              <SourcesSection results={searchResults} highlightedIndex={highlightedSource} />
            )}

            {/* Actions - use lastAssistantMsg for regenerate/delete */}
            {!isStreaming && activeConv?.status !== 'running' && lastAssistantMsg && (
              <div className="mt-2">
                <MessageBubble message={lastAssistantMsg} hideAvatar={true} actionsOnly={true} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
