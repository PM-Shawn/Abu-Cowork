import { useState, useEffect, useRef } from 'react';
import { Wrench, ChevronDown, ChevronRight, CheckCircle2, Loader2, Circle, Maximize2 } from 'lucide-react';
import type { ToolCall, ToolResultContent } from '@/types';
import { cn } from '@/lib/utils';

interface ToolCallsGroupProps {
  toolCalls: ToolCall[];
}

/**
 * Compact tool calls display - collapsed by default showing a single line
 * with scrolling tool execution status, expandable to show details.
 */
export default function ToolCallsGroup({ toolCalls }: ToolCallsGroupProps) {
  // Filter out hidden tool calls (like report_plan)
  const visibleToolCalls = toolCalls.filter((tc) => !tc.hidden);

  const [expanded, setExpanded] = useState(false);
  const [currentDisplayIndex, setCurrentDisplayIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Find the currently executing tool, or the last completed one
  const executingIndex = visibleToolCalls.findIndex((tc) => tc.isExecuting);
  const allCompleted = visibleToolCalls.every((tc) => tc.result !== undefined);

  // Auto-scroll to show current executing tool
  useEffect(() => {
    if (executingIndex !== -1) {
      setCurrentDisplayIndex(executingIndex);
    } else if (allCompleted && visibleToolCalls.length > 0) {
      setCurrentDisplayIndex(visibleToolCalls.length - 1);
    }
  }, [executingIndex, allCompleted, visibleToolCalls.length]);

  // Count completed tools
  const completedCount = visibleToolCalls.filter((tc) => tc.result !== undefined).length;
  const totalCount = visibleToolCalls.length;

  // Get current tool to display in collapsed state
  const currentTool = visibleToolCalls[currentDisplayIndex] || visibleToolCalls[0];
  const isAnyExecuting = executingIndex !== -1;

  if (visibleToolCalls.length === 0) return null;

  return (
    <div className="my-2 space-y-2">
      {/* Tool calls block */}
      <div className="rounded-lg overflow-hidden border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)]">
        {/* Collapsed header - single line */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="btn-ghost w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--abu-bg-muted)] transition-colors"
        >
        {/* Expand/collapse chevron */}
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        )}

        {/* Tool icon with status color */}
        <div className="relative shrink-0">
          <Wrench className={cn(
            "h-3.5 w-3.5",
            isAnyExecuting ? "text-[var(--abu-clay)]" : allCompleted ? "text-emerald-600" : "text-[var(--abu-text-tertiary)]"
          )} />
        </div>

        {/* Scrolling tool name display */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div
            ref={scrollRef}
            className="flex items-center gap-1.5 transition-transform duration-300"
          >
            {isAnyExecuting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin text-[var(--abu-clay)] shrink-0" />
                <span className="font-mono text-[12px] text-[var(--abu-text-primary)] truncate">
                  {currentTool?.name}
                </span>
              </>
            ) : allCompleted ? (
              <span className="text-[12px] text-[var(--abu-text-tertiary)]">
                {totalCount === 1 ? (
                  <span className="font-mono">{currentTool?.name}</span>
                ) : (
                  `${totalCount} tools completed`
                )}
              </span>
            ) : (
              <span className="font-mono text-[12px] text-[var(--abu-text-primary)] truncate">
                {currentTool?.name}
              </span>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div className="shrink-0">
          {isAnyExecuting ? (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--abu-clay-bg)] text-[var(--abu-clay)] font-medium">
              {completedCount}/{totalCount}
            </span>
          ) : allCompleted ? (
            <span className="flex items-center gap-1 text-[10px] text-emerald-600">
              <CheckCircle2 className="h-3 w-3" />
              Done
            </span>
          ) : (
            <span className="text-[10px] text-[var(--abu-text-tertiary)]">
              {completedCount}/{totalCount}
            </span>
          )}
        </div>
      </button>

      {/* Expanded content - tool list with details */}
      {expanded && (
        <div className="border-t border-[var(--abu-border-subtle)]">
          {visibleToolCalls.map((tc, index) => (
            <ToolCallItem key={tc.id} toolCall={tc} isLast={index === visibleToolCalls.length - 1} />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * Individual tool call item in expanded view
 */
function ToolCallItem({ toolCall, isLast }: { toolCall: ToolCall; isLast: boolean }) {
  const [showDetails, setShowDetails] = useState(false);
  const isExecuting = toolCall.isExecuting;
  const isCompleted = toolCall.result !== undefined;

  return (
    <div className={cn("border-b border-[var(--abu-border-subtle)]", isLast && "border-b-0")}>
      {/* Tool header */}
      <button
        onClick={() => setShowDetails(!showDetails)}
        className="btn-ghost w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-[var(--abu-bg-muted)]"
      >
        {/* Status indicator */}
        <div className={cn(
          "w-4 h-4 rounded-full flex items-center justify-center shrink-0",
          isCompleted && "bg-emerald-500/15",
          isExecuting && "bg-[var(--abu-clay-bg-15)]",
          !isCompleted && !isExecuting && "bg-[var(--abu-bg-hover)]"
        )}>
          {isCompleted && <CheckCircle2 className="h-2.5 w-2.5 text-emerald-600" />}
          {isExecuting && <Loader2 className="h-2.5 w-2.5 text-[var(--abu-clay)] animate-spin" />}
          {!isCompleted && !isExecuting && <Circle className="h-1.5 w-1.5 text-[var(--abu-text-muted)] fill-current" />}
        </div>

        {/* Tool name */}
        <span className={cn(
          "font-mono text-[12px] truncate flex-1 text-left",
          isCompleted && "text-[var(--abu-text-primary)]",
          isExecuting && "text-[var(--abu-clay)] font-medium",
          !isCompleted && !isExecuting && "text-[var(--abu-text-muted)]"
        )}>
          {toolCall.name}
        </span>

        {/* Expand indicator for details */}
        {(isCompleted || isExecuting) && (
          <ChevronRight className={cn(
            "h-3 w-3 text-[var(--abu-text-muted)] transition-transform",
            showDetails && "rotate-90"
          )} />
        )}
      </button>

      {/* Details panel */}
      {showDetails && (isCompleted || isExecuting) && (
        <div className="bg-[#1c1c1e] px-3 py-2.5 space-y-2">
          {/* Input */}
          <div>
            <div className="text-[9px] font-semibold text-white/30 uppercase tracking-wider mb-1">Input</div>
            <pre className="text-[11px] font-mono text-[#a8c5da] whitespace-pre-wrap break-words leading-relaxed">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>
          {/* Output */}
          {toolCall.result !== undefined && (
            <div className="border-t border-white/10 pt-2">
              <div className="text-[9px] font-semibold text-white/30 uppercase tracking-wider mb-1">Output</div>
              {/* Screenshot thumbnail from resultContent */}
              {toolCall.resultContent?.some(b => b.type === 'image') && !toolCall.hideScreenshot && (
                <ScreenshotThumbnail resultContent={toolCall.resultContent} />
              )}
              {toolCall.result.includes('[sandbox-blocked]') ? (
                <div className="space-y-1.5">
                  <div className="px-2 py-1.5 rounded bg-red-500/20 border border-red-500/30">
                    <p className="text-[11px] font-mono text-red-300 leading-relaxed">
                      {toolCall.result.split('\n')[0].replace('[sandbox-blocked] ', '')}
                    </p>
                  </div>
                  <pre className="text-[11px] font-mono text-[#b5c9a8]/70 whitespace-pre-wrap break-words leading-relaxed max-h-24 overflow-y-auto">
                    {toolCall.result.split('\n').slice(2).join('\n')}
                  </pre>
                </div>
              ) : (
                <pre className="text-[11px] font-mono text-[#b5c9a8] whitespace-pre-wrap break-words leading-relaxed max-h-32 overflow-y-auto">
                  {toolCall.result}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders a clickable screenshot thumbnail from tool result image content.
 * Click to expand to full size in a modal overlay.
 */
function ScreenshotThumbnail({ resultContent }: { resultContent: ToolResultContent[] | undefined }) {
  const [expanded, setExpanded] = useState(false);
  if (!resultContent) return null;

  const imageBlock = resultContent.find(b => b.type === 'image');
  if (!imageBlock || imageBlock.type !== 'image') return null;

  const src = `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`;

  return (
    <>
      <div
        className="relative group cursor-pointer mb-2 inline-block"
        onClick={() => setExpanded(true)}
      >
        <img
          src={src}
          alt="Screenshot"
          className="rounded border border-white/20 max-w-[280px] max-h-[180px] object-contain"
        />
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors rounded flex items-center justify-center">
          <Maximize2 className="h-5 w-5 text-white opacity-0 group-hover:opacity-80 transition-opacity" />
        </div>
      </div>
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-8 cursor-pointer"
          onClick={() => setExpanded(false)}
        >
          <img
            src={src}
            alt="Screenshot (full)"
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </>
  );
}
