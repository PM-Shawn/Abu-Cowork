import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { Message, MessageContent, ToolCall, ImageAttachment } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import type { ExecutionStep } from '@/types/execution';
import type { WorkflowStep } from '@/utils/workflowExtractor';
import MessageBubble from './MessageBubble';
import TaskBlock from './TaskBlock';
import MarkdownRenderer from './MarkdownRenderer';
import FileAttachment, { ImagePreviewCard, ImageThumbnail, isImageFile } from './FileAttachment';
import SourcesSection from './SourcesSection';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { MessageErrorBoundary } from '@/components/common/ErrorBoundary';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { extractWorkflowSteps, extractFileOutputs, extractFilePathsFromText } from '@/utils/workflowExtractor';
import { parseSearchResults, stripSourcesBlock, parseSourcesFromText } from '@/utils/searchParser';
import { snapshotToExecutionSteps } from '@/core/agent/executionSnapshot';
import { runAgentLoop } from '@/core/agent/agentLoop';
import abuAvatar from '@/assets/abu-avatar.png';

interface MessageGroupProps {
  messages: Message[];
}

// Helper to get text content from Message
function getTextContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  const textBlock = content.find((c) => c.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '';
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
  | { kind: 'steps'; executionSteps: ExecutionStep[]; legacySteps: WorkflowStep[]; isLastGroup: boolean };

/**
 * Build render segments from assistant messages and their steps.
 *
 * Produces alternating text and steps segments. Consecutive tool-only turns
 * are merged into a single 'steps' segment so they render as one TaskBlock.
 *
 * Order: text → merged steps → text → merged steps → ...
 */
function buildRenderSegments(
  assistantMsgs: Message[],
  allExecSteps: ExecutionStep[],
  allLegacySteps: WorkflowStep[],
): RenderSegment[] {
  if (assistantMsgs.length === 0) return [];

  // Separate thinking steps from tool steps
  const thinkingExecSteps = allExecSteps.filter((s) => s.type === 'thinking');
  const toolExecSteps = allExecSteps.filter((s) => s.type !== 'thinking');
  const thinkingLegacySteps = allLegacySteps.filter((s) => s.type === 'thinking');
  const toolLegacySteps = allLegacySteps.filter((s) => s.type !== 'thinking');

  const segments: RenderSegment[] = [];
  let pendingExecSteps: ExecutionStep[] = [...thinkingExecSteps]; // thinking goes first
  let pendingLegacySteps: WorkflowStep[] = [...thinkingLegacySteps];

  let execOffset = 0;
  let legacyOffset = 0;

  for (let idx = 0; idx < assistantMsgs.length; idx++) {
    const msg = assistantMsgs[idx];
    const isLastTurn = idx === assistantMsgs.length - 1;
    const text = getTextContent(msg.content);
    const visibleToolCount = (msg.toolCalls || []).filter((tc) => !tc.hidden).length;

    // Slice this turn's steps
    const turnExecSteps = toolExecSteps.slice(execOffset, execOffset + visibleToolCount);
    execOffset += visibleToolCount;
    const turnLegacySteps = toolLegacySteps.slice(legacyOffset, legacyOffset + visibleToolCount);
    legacyOffset += visibleToolCount;

    if (text) {
      // Flush accumulated steps before this text
      if (pendingExecSteps.length > 0 || pendingLegacySteps.some((s) => s.type !== 'thinking')) {
        segments.push({
          kind: 'steps',
          executionSteps: pendingExecSteps,
          legacySteps: pendingLegacySteps,
          isLastGroup: false, // not last yet, there's text after
        });
        pendingExecSteps = [];
        pendingLegacySteps = [];
      }

      // Emit text segment
      segments.push({ kind: 'text', text, message: msg, isLastTurn });

      // Start accumulating this turn's steps
      pendingExecSteps = [...turnExecSteps];
      pendingLegacySteps = [...turnLegacySteps];
    } else {
      // No text — accumulate steps
      pendingExecSteps.push(...turnExecSteps);
      pendingLegacySteps.push(...turnLegacySteps);
    }
  }

  // Flush remaining accumulated steps
  if (pendingExecSteps.length > 0 || pendingLegacySteps.some((s) => s.type !== 'thinking')) {
    segments.push({
      kind: 'steps',
      executionSteps: pendingExecSteps,
      legacySteps: pendingLegacySteps,
      isLastGroup: true,
    });
  }

  // Mark the last 'steps' segment
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i].kind === 'steps') {
      (segments[i] as Extract<RenderSegment, { kind: 'steps' }>).isLastGroup = true;
      break;
    }
  }

  return segments;
}

/**
 * Groups multiple messages from the same agent loop into a single visual block.
 * User messages render standalone, assistant messages share one avatar.
 * Renders text → merged tool steps, with consecutive tool-only turns combined.
 */
export default function MessageGroup({ messages }: MessageGroupProps) {
  // Separate user and assistant messages
  const userMsg = messages.find((m) => m.role === 'user');
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  const agentStatus = useChatStore((s) => s.agentStatus);
  const activeConv = useActiveConversation();

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
  const workflowSteps = extractWorkflowSteps(allToolCalls, thinkingContent, agentStatus, skillInfo, thinkingDuration);

  // Extract file outputs for attachments
  // Source 1: tool calls (reliable). Source 2: last assistant message text (for announced paths)
  const fileOutputs = useMemo(() => {
    const files = extractFileOutputs(allToolCalls);
    // Deduplicate by both full path and basename
    const seenPaths = new Set(files.map(f => f.path));
    const seenBasenames = new Set(files.map(f => f.path.split('/').pop() || f.path));
    // Only check the LAST assistant message for file paths (final result, not intermediate narration)
    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    if (lastMsg) {
      const text = getTextContent(lastMsg.content);
      if (text) {
        const textPaths = extractFilePathsFromText(text);
        for (const rawP of textPaths) {
          // Normalize to match the same normalization in extractFileOutputs
          // Strip markdown formatting (**, __, ``) that wraps filenames in LLM text
          const p = rawP
            .replace(/^[*_`~]+/, '')
            .replace(/[*_`~)）\]】}"'。，,;；:：.]+$/, '')
            .trim().replace(/\\/g, '/');
          if (!p) continue;
          const basename = p.split('/').pop() || p;
          if (!seenPaths.has(p) && !seenBasenames.has(basename)) {
            seenPaths.add(p);
            seenBasenames.add(basename);
            files.push({ path: p, operation: 'create' });
          }
        }
      }
    }
    return files;
  }, [allToolCalls, assistantMsgs]);

  // Check if any tool is executing
  const isAnyExecuting = allToolCalls.some((tc) => tc.isExecuting);

  // Check if any tool has error result
  const hasError = allToolCalls.some((tc) => tc.result?.toLowerCase().includes('error'));

  // Auto-preview: only when agent transitions from running → done (not on mount/conversation switch)
  const openPreview = usePreviewStore((s) => s.openPreview);
  const isAgentDone = !isStreaming && !isThisExecutionActive && activeConv?.status !== 'running';
  const prevAgentDoneRef = useRef(isAgentDone);
  useEffect(() => {
    const wasDone = prevAgentDoneRef.current;
    prevAgentDoneRef.current = isAgentDone;
    // Only trigger on false→true transition (agent just finished, not already done on mount/switch)
    if (wasDone || !isAgentDone || fileOutputs.length === 0) return;
    const nonImageFiles = fileOutputs.filter((f) => !isImageFile(f.path));
    const previewableFile = nonImageFiles[nonImageFiles.length - 1] || fileOutputs[fileOutputs.length - 1];
    if (previewableFile) {
      openPreview(previewableFile.path);
    }
  }, [isAgentDone, fileOutputs, openPreview]);

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

  // Determine which step data source to use
  const activeExecSteps = useMemo(
    () => (executionSteps && executionSteps.length > 0)
      ? executionSteps
      : persistedExecutionSteps ?? [],
    [executionSteps, persistedExecutionSteps]
  );

  // Build render segments: text and merged step groups
  const segments = useMemo(
    () => buildRenderSegments(assistantMsgs, activeExecSteps, workflowSteps),
    [assistantMsgs, activeExecSteps, workflowSteps]
  );

  // Check if we have any content (for thinking indicator fallback)
  const hasAnyContent = segments.length > 0;

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
            {/* Thinking indicator - when streaming but no content yet */}
            {isStreaming && !hasAnyContent && (
              <div className="flex items-center gap-1.5 py-2">
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[var(--abu-clay-60)]" />
              </div>
            )}

            {/* Render segments: text blocks and merged step groups */}
            {segments.map((seg, segIdx) => {
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
                      <div className="text-[var(--abu-text-primary)] break-words mb-2">
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

              // kind === 'steps' — merged TaskBlock
              const hasExecSteps = seg.executionSteps.length > 0;
              const hasLegacyNonThinking = seg.legacySteps.some((s) => s.type !== 'thinking');

              return (
                <div key={`steps-${segIdx}`}>
                  {hasExecSteps ? (
                    <TaskBlock
                      executionSteps={seg.executionSteps}
                      isActive={seg.isLastGroup && isThisExecutionActive}
                      onRetry={seg.isLastGroup && hasError && !isStreaming ? handleRetry : undefined}
                    />
                  ) : hasLegacyNonThinking && (
                    <TaskBlock
                      steps={seg.legacySteps}
                      isActive={seg.isLastGroup && isAnyExecuting}
                      onRetry={seg.isLastGroup && hasError && !isStreaming ? handleRetry : undefined}
                    />
                  )}
                </div>
              );
            })}

            {/* File attachments - only show after agent loop fully ends
                (ensures intermediate scripts are properly filtered out) */}
            {fileOutputs.length > 0 && isAgentDone && (() => {
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
