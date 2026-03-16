import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { Message, MessageContent, ToolCall, ImageAttachment } from '@/types';
import MessageBubble from './MessageBubble';
import TaskBlock from './TaskBlock';
import MarkdownRenderer from './MarkdownRenderer';
import FileAttachment, { ImagePreviewCard, ImageThumbnail, isImageFile } from './FileAttachment';
import SourcesSection from './SourcesSection';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { extractWorkflowSteps, extractFileOutputs } from '@/utils/workflowExtractor';
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

/**
 * Groups multiple messages from the same agent loop into a single visual block.
 * User messages render standalone, assistant messages share one avatar.
 * Content is rendered in order: workflow chain -> text -> file attachments
 */
export default function MessageGroup({ messages }: MessageGroupProps) {
  // Separate user and assistant messages
  const userMsg = messages.find((m) => m.role === 'user');
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  const agentStatus = useChatStore((s) => s.agentStatus);
  const activeConv = useActiveConversation();
  const { deleteMessagesFrom } = useChatStore();

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
    // Derive assistant messages from `messages` prop directly to keep deps consistent
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
    // 1. Try structured SEARCH_JSON from tool call results
    const fromTools = messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => m.toolCalls || [])
      .flatMap((tc) => {
        if (tc.name !== 'web_search' || !tc.result) return [];
        return parseSearchResults(tc.result) ?? [];
      });
    if (fromTools.length > 0) return fromTools;

    // 2. Fallback: parse sources from the LLM's text output (e.g. Anthropic native web search)
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

  // Cleanup highlight timer on unmount
  useEffect(() => {
    return () => { clearTimeout(highlightTimerRef.current); };
  }, []);

  const handleCitationClick = useCallback((index: number) => {
    setHighlightedSource(index);
    // Scroll to source card scoped to this message group
    requestAnimationFrame(() => {
      const card = groupRef.current?.querySelector(`[data-source-index="${index}"]`);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
    // Clear highlight after animation, cancelling any previous timer
    clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedSource(null), 2000);
  }, []);

  // Aggregate thinking content from all messages
  const thinkingContent = assistantMsgs
    .map((m) => m.thinking)
    .filter(Boolean)
    .join('\n');

  // Get thinking duration (from the message with thinking content)
  const thinkingDuration = assistantMsgs.find((m) => m.thinkingDuration)?.thinkingDuration;

  // Get skill info from user message (if skill was triggered)
  const skillInfo = userMsg?.skill;

  // Extract workflow steps from all tool calls (legacy fallback)
  const workflowSteps = extractWorkflowSteps(allToolCalls, thinkingContent, agentStatus, skillInfo, thinkingDuration);

  // Check if legacy workflow has non-thinking steps (thinking-only shouldn't show TaskBlock)
  const hasNonThinkingSteps = workflowSteps.some((s) => s.type !== 'thinking');

  // Extract file outputs for attachments
  const fileOutputs = useMemo(() => extractFileOutputs(allToolCalls), [allToolCalls]);

  // Build filename -> full path map for inline file chip matching
  const fileOutputMap = useMemo(() => {
    if (fileOutputs.length === 0) return undefined;
    const map = new Map<string, string>();
    for (const f of fileOutputs) {
      const name = f.path.split('/').pop() || f.path;
      map.set(name, f.path);
    }
    return map;
  }, [fileOutputs]);

  // Check if any tool is executing
  const isAnyExecuting = allToolCalls.some((tc) => tc.isExecuting);

  // Check if any tool has error result
  const hasError = allToolCalls.some((tc) => tc.result?.toLowerCase().includes('error'));

  // Handle retry - re-run the agent loop with the same user message (preserving images)
  const handleRetry = async () => {
    if (!userMsg || !activeConv?.id) return;
    const convId = activeConv.id;
    const userContent = getTextContent(userMsg.content);

    // Extract images from the original user message
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

    // Delete all assistant messages in this loop
    const firstAssistantInLoop = assistantMsgs[0];
    if (firstAssistantInLoop) {
      deleteMessagesFrom(convId, firstAssistantInLoop.id);
    }

    // Re-run the agent loop with images
    await runAgentLoop(convId, userContent, { images: retryImages });
  };

  // Collect text content from all assistant messages
  const textContents = assistantMsgs
    .map((msg) => getTextContent(msg.content))
    .filter(Boolean);

  return (
    <div ref={groupRef} className="message-group space-y-4 w-full">
      {/* User message renders standalone */}
      {userMsg && <MessageBubble message={userMsg} />}

      {/* Multiple assistant messages grouped with single avatar */}
      {assistantMsgs.length > 0 && (
        <div className="flex gap-3 w-full overflow-hidden group">
          {/* ABU Avatar - only shown once for the group */}
          <div className="shrink-0 mt-0.5">
            <div className="w-7 h-7 rounded-full overflow-hidden">
              <img src={abuAvatar} alt="Abu" className="w-full h-full object-cover" />
            </div>
          </div>

          {/* Content area: workflow chain -> text -> file attachments */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {/* 1. Task block (workflow progress) - prefer executionSteps > persisted snapshot > legacy */}
            {(executionSteps && executionSteps.length > 0) ? (
              <TaskBlock
                executionSteps={executionSteps}
                isActive={isThisExecutionActive}
                onRetry={hasError && !isStreaming ? handleRetry : undefined}
              />
            ) : persistedExecutionSteps ? (
              <TaskBlock
                executionSteps={persistedExecutionSteps}
                isActive={false}
              />
            ) : hasNonThinkingSteps && (
              <TaskBlock
                steps={workflowSteps}
                isActive={isAnyExecuting}
                onRetry={hasError && !isStreaming ? handleRetry : undefined}
              />
            )}

            {/* Thinking indicator - when streaming but no content yet */}
            {isStreaming && textContents.length === 0 && !hasNonThinkingSteps && !(executionSteps && executionSteps.length > 0) && !persistedExecutionSteps && (
              <div className="flex items-center gap-1.5 py-2">
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[#d97757]/60" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[#d97757]/60" />
                <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[#d97757]/60" />
              </div>
            )}

            {/* 2. Text content from all messages (with images extracted above) */}
            {textContents.map((textContent, index) => {
              const mdImages = extractMarkdownImages(textContent);
              let cleanedText = mdImages.length > 0 ? stripMarkdownImages(textContent) : textContent;
              // Strip LLM-generated sources block when we have structured search results
              if (searchResults.length > 0) {
                cleanedText = stripSourcesBlock(cleanedText);
              }
              return (
                <div key={index}>
                  {mdImages.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-2">
                      {mdImages.map((src, i) => (
                        <ImageThumbnail key={`${src}-${i}`} src={src} />
                      ))}
                    </div>
                  )}
                  {cleanedText && (
                    <div className="text-[#29261b] break-words mb-2">
                      <MarkdownRenderer
                        content={cleanedText}
                        searchResults={searchResults.length > 0 ? searchResults : undefined}
                        onCitationClick={searchResults.length > 0 ? handleCitationClick : undefined}
                        fileOutputMap={fileOutputMap}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {/* 2.5. Sources section - prominent display below text */}
            {searchResults.length > 0 && !isStreaming && (
              <SourcesSection results={searchResults} highlightedIndex={highlightedSource} />
            )}

            {/* Streaming cursor - only when text is actively being streamed */}
            {lastAssistantMsg?.isStreaming && textContents.length > 0 && <span className="streaming-cursor" />}

            {/* 3. File attachments - show created/modified files */}
            {fileOutputs.length > 0 && !isAnyExecuting && (() => {
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

            {/* Token usage - show from last message */}
            {lastAssistantMsg?.usage && !isStreaming && (
              <div className="mt-2 text-[11px] text-[#656358]/70">
                {lastAssistantMsg.usage.inputTokens && `输入: ${lastAssistantMsg.usage.inputTokens}`}
                {lastAssistantMsg.usage.outputTokens && ` · 输出: ${lastAssistantMsg.usage.outputTokens}`}
              </div>
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

