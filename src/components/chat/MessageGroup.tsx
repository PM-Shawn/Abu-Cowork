import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import type { Message, MessageContent, ToolCall, ImageAttachment } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { ExecutionStep } from '@/types/execution';
import type { WorkflowStep } from '@/utils/workflowExtractor';
import MessageBubble from './MessageBubble';
import SkillProposalCard from './SkillProposalCard';
import UserQuestionCard from './UserQuestionCard';
import PlanStepsCard from './PlanStepsCard';
import TaskBlock from './TaskBlock';
import BatchProgress from './BatchProgress';
import MarkdownRenderer from './MarkdownRenderer';
import FileAttachment, { ImagePreviewCard, ImageThumbnail, isImageFile } from './FileAttachment';
import SourcesSection from './SourcesSection';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n, format } from '@/i18n';
import { MessageErrorBoundary } from '@/components/common/ErrorBoundary';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { extractWorkflowSteps, extractFileOutputs, extractFilePathsFromText, parsePlanSteps } from '@/utils/workflowExtractor';
import { parseSearchResults, stripSourcesBlock, parseSourcesFromText } from '@/utils/searchParser';
import { snapshotToExecutionSteps } from '@/core/agent/executionSnapshot';
import { runAgentLoop } from '@/core/agent/agentLoop';
import { allWorkingDirectories } from '@/core/permissions/workingDirs';
import { homeDir } from '@tauri-apps/api/path';
import abuAvatar from '@/assets/abu-avatar.png';
import { cn } from '@/lib/utils';

interface MessageGroupProps {
  messages: Message[];
  isLastGroup?: boolean;
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
        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-xs text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-elevated)] transition-colors"
      >
        <Sparkles className="h-3.5 w-3.5 text-[var(--abu-clay)] flex-shrink-0" />
        <span className="flex-1 text-left">
          {t.toolbox.skillPatchGroupLabel}{' '}
          <span className="font-medium text-[var(--abu-text-primary)]">{skillName}</span>
          <span className="text-[var(--abu-text-muted)]">（{calls.length} 处）</span>
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
              <div key={tc.id} className="text-[11px] text-[var(--abu-text-muted)] px-2 py-0.5">
                {msg}
              </div>
            ) : null;
          })}
        </div>
      )}
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

// --- Render segment types ---

type RenderSegment =
  | { kind: 'text'; text: string; message: Message; isLastTurn: boolean }
  | { kind: 'steps'; executionSteps: ExecutionStep[]; legacySteps: WorkflowStep[]; isLastGroup: boolean; stepsMsgs: Message[] }
  | { kind: 'plan'; toolCall: ToolCall }
  | { kind: 'user'; message: Message };

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
): RenderSegment[] {
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  if (assistantMsgs.length === 0) return [];

  // Tool steps only. Thinking is rebuilt per-message from msg.thinking so it
  // renders in true chronological position; any thinking-typed step from
  // upstream (synth or eventRouter) is discarded here.
  const toolExecSteps = allExecSteps.filter((s) => s.type !== 'thinking');
  const toolLegacySteps = allLegacySteps.filter((s) => s.type !== 'thinking');

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

  let execOffset = 0;
  let legacyOffset = 0;
  let passedFirstAssistant = false;
  let assistantIdx = 0;

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

    // Slice this message's tool steps (hidden report_plan excluded — see plan segment).
    const visibleToolCount = (msg.toolCalls || []).filter((tc) => !tc.hidden).length;
    const turnExecSteps = toolExecSteps.slice(execOffset, execOffset + visibleToolCount);
    execOffset += visibleToolCount;
    const turnLegacySteps = toolLegacySteps.slice(legacyOffset, legacyOffset + visibleToolCount);
    legacyOffset += visibleToolCount;

    // 2. Text — flush accumulated tool steps, then emit text.
    const text = getTextContent(msg.content);
    if (text) {
      flushSteps();
      segments.push({ kind: 'text', text, message: msg, isLastTurn });
    }

    // 3. Plan — a report_plan call becomes a dedicated collapsed plan card at its real position.
    const planCall = (msg.toolCalls || []).find(
      (tc) => tc.name === TOOL_NAMES.REPORT_PLAN && parsePlanSteps(tc).length > 0,
    );
    if (planCall) {
      flushSteps();
      segments.push({ kind: 'plan', toolCall: planCall });
    }

    // 4. Accumulate this message's tool steps (merges with adjacent tool-only turns).
    pendingExecSteps.push(...turnExecSteps);
    pendingLegacySteps.push(...turnLegacySteps);
    if (visibleToolCount > 0) pendingStepsMsgs.push(msg);
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
// group. Segments [0, foldEnd) fold; [foldEnd, end) render inline (the final
// answer). Returns null when nothing should fold: group not done, no final
// text answer, or the answer is the first/only segment.
// eslint-disable-next-line react-refresh/only-export-components
export function computeWorkProcessFold(segments: RenderSegment[], isDone: boolean): number | null {
  if (!isDone) return null;
  let lastTextIdx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'text') { lastTextIdx = i; break; }
  }
  if (lastTextIdx <= 0) return null;
  return lastTextIdx;
}

/**
 * Groups multiple messages from the same agent loop into a single visual block.
 * User messages render standalone, assistant messages share one avatar.
 * Renders text → merged tool steps, with consecutive tool-only turns combined.
 */
export default function MessageGroup({ messages, isLastGroup: isLastGroupProp = false }: MessageGroupProps) {
  const { t } = useI18n();
  // Separate user and assistant messages
  const userMsg = messages.find((m) => m.role === 'user');
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  const agentStatus = useChatStore((s) => s.agentStatus);
  const activeConv = useActiveConversation();
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
    return snapshotToExecutionSteps(msgWithSnapshot.executionSteps);
  }, [executionSteps, messages]);

  // Check if THIS execution is active (not global status)
  const isThisExecutionActive = execution?.status === 'running';

  // Check if any message is still streaming
  const isStreaming = assistantMsgs.some((m) => m.isStreaming);

  // Get last message for actions
  const lastAssistantMsg = assistantMsgs[assistantMsgs.length - 1];

  // Aggregate all tool calls from assistant messages
  const allToolCalls = useMemo<ToolCall[]>(
    () => assistantMsgs.flatMap((m) => m.toolCalls || []),
    [assistantMsgs]
  );

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
  // Only pass agentStatus to the currently streaming group — prevents the global
  // 'thinking' status from injecting a phantom thinking step into completed groups
  const workflowSteps = extractWorkflowSteps(allToolCalls, thinkingContent, isStreaming ? agentStatus : undefined, skillInfo, thinkingDuration);

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

  // Handle retry
  const handleRetry = async () => {
    if (!userMsg || !activeConv?.id) return;
    const convId = activeConv.id;
    const userContent = getTextContent(userMsg.content);

    let retryImages: ImageAttachment[] | undefined;
    if (Array.isArray(userMsg.content)) {
      const imgBlocks = userMsg.content.filter((c): c is Extract<MessageContent, { type: 'image' }> => c.type === 'image');
      if (imgBlocks.length > 0) {
        retryImages = imgBlocks.map((img, i) => ({
          id: `retry-${i}`,
          data: img.source.data,
          mediaType: img.source.media_type,
        }));
      }
    }

    const firstAssistantInLoop = assistantMsgs[0];
    if (firstAssistantInLoop) {
      useChatStore.getState().deleteMessagesFrom(convId, firstAssistantInLoop.id);
    }

    await runAgentLoop(convId, userContent, { images: retryImages });
  };

  // Tool execution steps for this loop. Thinking is rebuilt per-message inside
  // buildRenderSegments, so no synthesized thinking step is prepended here.
  const activeExecSteps = useMemo(() => {
    return (executionSteps && executionSteps.length > 0)
      ? executionSteps
      : persistedExecutionSteps ?? [];
  }, [executionSteps, persistedExecutionSteps]);

  // Build render segments: text and merged step groups
  const segments = useMemo(
    () => buildRenderSegments(messages, activeExecSteps, workflowSteps),
    [messages, activeExecSteps, workflowSteps]
  );

  // Check if we have any content (for thinking indicator fallback)
  const hasAnyContent = segments.length > 0;

  // Codex-style turn collapse: once a turn is done and has a final text answer,
  // fold all intermediate segments (thinking/plan/steps) behind a single row.
  const workFoldEnd = useMemo(() => computeWorkProcessFold(segments, isGroupDone), [segments, isGroupDone]);
  const [workExpanded, setWorkExpanded] = useState(false);
  // Fold header label: Codex-style duration + completed/aborted variant. Prefer
  // the execution's start/end timing; fall back to message timestamps when the
  // execution has been evicted (older groups). Aborted = execution cancelled.
  const workStart = execution?.startTime ?? assistantMsgs[0]?.timestamp ?? userMsg?.timestamp;
  const workEnd = execution?.endTime ?? lastAssistantMsg?.timestamp;
  const workDurationMs = workStart != null && workEnd != null ? workEnd - workStart : 0;
  const workLabel = execution?.status === 'cancelled'
    ? format(t.chat.stoppedAfter, { duration: formatWorkDuration(workDurationMs) })
    : format(t.chat.workedFor, { duration: formatWorkDuration(workDurationMs) });

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
      const mdImages = extractMarkdownImages(seg.text);
      let cleanedText = mdImages.length > 0 ? stripMarkdownImages(seg.text) : seg.text;
      if (searchResults.length > 0 && cleanedText) {
        cleanedText = stripSourcesBlock(cleanedText);
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

    // Live run_agent_batch progress cards for this steps segment (tc.id = LLM
    // call id, matches the batchProgressStore key set by the tool's execute)
    const segActiveBatches = seg.stepsMsgs
      .flatMap((m) => m.toolCalls ?? [])
      .filter((tc) => tc.name === TOOL_NAMES.RUN_AGENT_BATCH && tc.isExecuting && tc.result === undefined);

    return (
      <div key={`steps-${segIdx}`}>
        {hasExecSteps ? (
          <TaskBlock
            executionSteps={seg.executionSteps}
            isActive={execIsActive}
            onRetry={seg.isLastGroup && hasError && !isStreaming ? handleRetry : undefined}
          />
        ) : hasLegacySteps && (
          <TaskBlock
            steps={seg.legacySteps}
            isActive={legacyIsActive}
            onRetry={seg.isLastGroup && hasError && !isStreaming ? handleRetry : undefined}
          />
        )}
        {segActiveBatches.map((tc) => (
          <BatchProgress key={`batch-${tc.id}`} toolCallId={tc.id} />
        ))}
        {segSettledUQCards.map((tc) => (
          <UserQuestionCard key={`uq-${tc.id}`} toolCall={tc} />
        ))}
      </div>
    );
  };

  return (
    <div ref={groupRef} className="message-group space-y-4 w-full">
      {/* User message renders standalone */}
      {userMsg && <MessageErrorBoundary><MessageBubble message={userMsg} /></MessageErrorBoundary>}

      {/* Multiple assistant messages grouped with single avatar */}
      {assistantMsgs.length > 0 && (
        <div className="flex gap-3 w-full overflow-hidden group">
          {/* ABU Avatar - only shown once for the group */}
          <div className="shrink-0 mt-0.5">
            <div className="w-7 h-7 rounded-full overflow-hidden">
              <img src={abuAvatar} alt="Abu" className="w-full h-full object-cover" />
            </div>
          </div>

          {/* Content area */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {/* Typing dots — shown only before any thinking or text bytes have arrived.
                Once thinking starts streaming, segments will be populated (thinking step
                inside a TaskBlock) and hasAnyContent flips true, hiding these dots. */}
            {isStreaming && !hasAnyContent && (
              <div className="flex items-center gap-1.5 py-2">
                <span className="text-[12px] text-[var(--abu-text-muted)]">{t.status.thinking}</span>
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
              </div>
            )}

            {/* Render segments: text blocks and merged step groups.
                When the turn is done and has a final text answer, all
                intermediate segments (thinking/plan/steps) are folded
                behind a single collapsible "工作过程" row (Codex-style). */}
            {workFoldEnd == null ? (
              segments.map(renderSegment)
            ) : (
              <>
                {/* Lightweight fold header — matches the thinking/step block
                    style (muted text + trailing chevron, no card background). */}
                <button
                  onClick={() => setWorkExpanded((v) => !v)}
                  className="flex items-center gap-1 text-[13px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-muted)] transition-colors mb-2"
                >
                  <span>{workLabel}</span>
                  <ChevronDown
                    className={cn('h-3.5 w-3.5 transition-transform', !workExpanded && '-rotate-90')}
                  />
                </button>
                {workExpanded && segments.slice(0, workFoldEnd).map((seg, i) => renderSegment(seg, i))}
                {segments.slice(workFoldEnd).map((seg, i) => renderSegment(seg, workFoldEnd + i))}
              </>
            )}

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
