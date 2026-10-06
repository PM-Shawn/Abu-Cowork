import { useState, useEffect, useRef, useMemo, useId } from 'react';
import type { ToolCall, ToolResultContent, Message } from '@/types';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { useChatStore } from '@/stores/chatStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { useI18n } from '@/i18n';
import { getBaseName, loadLocalImage } from '@/utils/pathUtils';
import { resolveOutputRefSource } from '@/core/session/outputSnapshots';
import { cn } from '@/lib/utils';

/** True when an ask_user_question tool call is parked waiting on the user. */
function isAwaitingUser(tc: ToolCall): boolean {
  return tc.name === TOOL_NAMES.ASK_USER_QUESTION && tc.result === undefined;
}

interface ToolCallsGroupProps {
  toolCalls: ToolCall[];
  conversationId?: string;
}

// MCP Apps note: an app-backed step's interface is NOT rendered here. Assistant
// turns reach the transcript through `MessageGroup`, which never renders this
// component (a `MessageBubble` for an assistant message returns early in
// `actionsOnly` mode), so a block wired in here would be unreachable for every
// tool call a model makes. `MessageGroup` owns it — see `mcpAppSteps` there.

const SANDBOX_BLOCKED_PREFIX = '[sandbox-blocked]';

/**
 * Split a sandbox-blocked tool result into the reason line and the rest.
 *
 * `annotateSandboxViolations` (electron/commandHost.cjs) prepends
 * `[sandbox-blocked] <reasons>` to the command's *stderr*, and `run_command`
 * then wraps that stderr in a `stderr:` header block, optionally after
 * `stdout:` / recovery blocks. So the marker sits at an arbitrary line index —
 * locate it instead of assuming line 0, and keep every other line as detail.
 */
function splitSandboxBlockedResult(result: string): { reason: string; details: string } | null {
  const lines = result.split('\n');
  const markerIndex = lines.findIndex((line) => line.startsWith(SANDBOX_BLOCKED_PREFIX));
  if (markerIndex === -1) return null;

  // A bare marker carries no reasons to highlight — leave it in the plain block.
  const reason = lines[markerIndex].slice(SANDBOX_BLOCKED_PREFIX.length).trim();
  if (!reason) return null;

  // Drop the marker line plus the blank separator the annotator inserts after it.
  const restStart = lines[markerIndex + 1] === '' ? markerIndex + 2 : markerIndex + 1;
  return {
    reason,
    details: [...lines.slice(0, markerIndex), ...lines.slice(restStart)].join('\n'),
  };
}

type ToolResultImageBlock = Extract<ToolResultContent, { type: 'image' }>;
type OutputRefImageState = 'idle' | 'loading' | 'ready' | 'unavailable';

/**
 * Compact tool calls display - collapsed by default showing a single line
 * with scrolling tool execution status, expandable to show details.
 */
export default function ToolCallsGroup({ toolCalls, conversationId }: ToolCallsGroupProps) {
  // Filter out hidden tool calls (like report_plan)
  const visibleToolCalls = useMemo(() => toolCalls.filter((tc) => !tc.hidden), [toolCalls]);

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
  const anyFailed = visibleToolCalls.some((tc) => tc.result !== undefined && tc.isError);

  // Get current tool to display in collapsed state
  const currentTool = visibleToolCalls[currentDisplayIndex] || visibleToolCalls[0];
  const isAnyExecuting = executingIndex !== -1;
  // When the in-flight tool is an ask_user_question awaiting the user, show a
  // static "waiting" state rather than a spinner — the model isn't working.
  const isAwaitingUserCurrent = !!currentTool && isAwaitingUser(currentTool);
  const { t } = useI18n();

  if (visibleToolCalls.length === 0) return null;

  return (
    <div className="my-2 space-y-2">
      {/* Tool calls block */}
      <div className="overflow-hidden rounded-panel border border-separator bg-surface">
        {/* Collapsed header - single line. While tools run it carries the
            group's only spinner; the rows below show a still loading icon. */}
        <Pressable
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui text-label transition-colors hover:bg-fill-hover"
        >
        {/* Expand/collapse chevron */}
        <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" className="text-label-tertiary" />

        {/* Group status: one spinner, a check when done, a cross when a tool failed */}
        {isAwaitingUserCurrent ? (
          <Icon icon={AppIcons.awaitingAnswer} size="sm" className="text-label-tertiary" />
        ) : isAnyExecuting ? (
          <Spinner size="sm" labelHidden label={t.task.running} />
        ) : allCompleted ? (
          <StatusIcon tone={anyFailed ? 'danger' : 'success'} size="sm" />
        ) : (
          <Icon icon={AppIcons.tool} size="sm" className="text-label-tertiary" />
        )}

        {/* Scrolling tool name display */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <div
            ref={scrollRef}
            className="flex items-center gap-2 transition-transform duration-slow"
          >
            {isAwaitingUserCurrent ? (
              <span className="text-ui-sm text-label-secondary truncate">
                {t.userQuestion.waitingForAnswer}
              </span>
            ) : allCompleted ? (
              <span className="text-ui-sm text-label-secondary">
                {totalCount === 1 ? (
                  <span className="font-code">{currentTool?.name}</span>
                ) : (
                  `${totalCount} tools completed`
                )}
              </span>
            ) : (
              <span className="font-code text-ui-sm text-label truncate">
                {currentTool?.name}
              </span>
            )}
          </div>
        </div>

        {/* Status badge */}
        <div className="shrink-0">
          {isAwaitingUserCurrent ? (
            <Tag>{t.userQuestion.waitingForAnswer}</Tag>
          ) : allCompleted ? (
            <span className="text-ui-sm text-label-tertiary">Done</span>
          ) : (
            <Tag>{completedCount}/{totalCount}</Tag>
          )}
        </div>
      </Pressable>

      {/* Expanded content - tool list with details */}
      {expanded && (
        <div className="border-t border-separator">
          {visibleToolCalls.map((tc, index) => (
            <ToolCallItem
              key={tc.id}
              toolCall={tc}
              isLast={index === visibleToolCalls.length - 1}
              conversationId={conversationId}
            />
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
function ToolCallItem({
  toolCall,
  isLast,
  conversationId,
}: {
  toolCall: ToolCall;
  isLast: boolean;
  conversationId?: string;
}) {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const awaitingUser = isAwaitingUser(toolCall);
  const isExecuting = toolCall.isExecuting && !awaitingUser;
  const [batchResultExpanded, setBatchResultExpanded] = useState(false);
  const isCompleted = toolCall.result !== undefined;
  const sandboxBlocked = useMemo(
    () => (showDetails && toolCall.result !== undefined
      ? splitSandboxBlockedResult(toolCall.result)
      : null),
    [showDetails, toolCall.result],
  );

  return (
    <div className={cn("border-b border-separator", isLast && "border-b-0")}>
      {/* Tool header */}
      <Pressable
        onClick={() => setShowDetails(!showDetails)}
        aria-expanded={showDetails}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-ui text-label transition-colors hover:bg-fill-hover"
      >
        {/* Status indicator: still icons only, the group header holds the spinner */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {isCompleted && <StatusIcon tone={toolCall.isError ? 'danger' : 'success'} size="sm" />}
          {awaitingUser && <Icon icon={AppIcons.awaitingAnswer} size="sm" className="text-label-tertiary" />}
          {isExecuting && <Icon icon={AppIcons.loading} size="sm" className="text-label-tertiary" />}
          {!isCompleted && !isExecuting && !awaitingUser && <span className="size-1.5 rounded-full bg-label-tertiary" />}
        </span>

        {/* Tool name */}
        <span className={cn(
          "font-code text-ui-sm truncate flex-1",
          isCompleted || isExecuting || awaitingUser ? "text-label" : "text-label-tertiary"
        )}>
          {toolCall.name}
          {awaitingUser && (
            <span className="ml-2 font-sans text-caption text-label-secondary">
              · {t.userQuestion.waitingForAnswer}
            </span>
          )}
        </span>

        {/* Expand indicator for details */}
        {(isCompleted || isExecuting || awaitingUser) && (
          <Icon
            icon={AppIcons.disclose}
            size="sm"
            className={cn("text-label-tertiary transition-transform", showDetails && "rotate-90")}
          />
        )}
      </Pressable>

      {/* Details panel */}
      {showDetails && (isCompleted || isExecuting || awaitingUser) && (
        <div className="mx-3 mb-3 space-y-2 rounded-control bg-code px-3 py-2">
          {/* Input */}
          <div>
            <div className="mb-1 text-caption font-medium uppercase tracking-wider text-label-tertiary">Input</div>
            <pre className="font-code text-mono text-label whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>
          {/* Output */}
          {toolCall.result !== undefined && (
            <div className="border-t border-separator pt-2">
              <div className="mb-1 text-caption font-medium uppercase tracking-wider text-label-tertiary">Output</div>
              {toolCall.name === TOOL_NAMES.RUN_AGENT_BATCH ? (
                <div>
                  {/* Collapsed summary line with expand toggle */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-ui-sm text-label">
                      {toolCall.result.split('\n')[0]}
                    </span>
                    <Button
                      variant="plain"
                      size="sm"
                      icon={batchResultExpanded ? AppIcons.expand : AppIcons.disclose}
                      aria-expanded={batchResultExpanded}
                      onClick={() => setBatchResultExpanded((v) => !v)}
                    >
                      {batchResultExpanded ? t.batch.collapse : t.batch.expand}
                    </Button>
                  </div>
                  {batchResultExpanded && (
                    <pre className="mt-2 font-code text-mono text-label whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                      {toolCall.result}
                    </pre>
                  )}
                </div>
              ) : (
                <>
                  {/* Screenshot thumbnail from resultContent — Computer Use only.
                      Non-computer image results (e.g. read_file PNGs / QR codes) render
                      inline in the message bubble via InlineToolResultImages instead. */}
                  {toolCall.name === TOOL_NAMES.COMPUTER
                    && toolCall.resultContent?.some(b => b.type === 'image')
                    && !toolCall.hideScreenshot && (
                    <ScreenshotThumbnail resultContent={toolCall.resultContent} conversationId={conversationId} />
                  )}
                  {sandboxBlocked ? (
                    <div className="space-y-2">
                      <div className="flex items-start gap-2 rounded-control bg-danger-soft px-2 py-1">
                        <span className="flex h-4 shrink-0 items-center">
                          <StatusIcon tone="danger" size="sm" />
                        </span>
                        <p data-testid="sandbox-blocked-reason" className="font-code text-caption text-danger">
                          {sandboxBlocked.reason}
                        </p>
                      </div>
                      <pre data-testid="sandbox-blocked-details" className="font-code text-mono text-label-secondary whitespace-pre-wrap break-words max-h-24 overflow-y-auto">
                        {sandboxBlocked.details}
                      </pre>
                    </div>
                  ) : (
                    <pre className="font-code text-mono text-label whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                      {toolCall.result}
                    </pre>
                  )}
                </>
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
 * Click to open it in the app's image viewer.
 */
export function ToolResultImagePreview({
  block,
  conversationId,
  alt,
  thumbnailClassName,
  frameClassName,
}: {
  block: ToolResultImageBlock;
  conversationId?: string;
  alt: string;
  thumbnailClassName: string;
  frameClassName: string;
}) {
  const { t } = useI18n();
  const thumbnailId = useId();
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  // The file `resolvedSrc` was read from.
  const resolvedPathRef = useRef<string | null>(null);
  const [state, setState] = useState<OutputRefImageState>(() => (
    block.outputRef?.relPath && !block.source.data ? 'loading' : 'idle'
  ));
  const [retryNonce, setRetryNonce] = useState(0);
  const objectUrlRef = useRef<string | null>(null);

  const inlineSrc = block.source.data
    ? `data:${block.source.media_type};base64,${block.source.data}`
    : null;
  const src = inlineSrc ?? resolvedSrc;

  useEffect(() => {
    resolvedPathRef.current = null;
    if (inlineSrc || !block.outputRef?.relPath) {
      setState('idle');
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      setResolvedSrc(null);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    setState('loading');
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setResolvedSrc(null);

    resolveOutputRefSource(conversationId, block.outputRef.relPath)
      .then(async (resolved) => {
        if (cancelled) return;
        if (resolved.status !== 'available') {
          setState('unavailable');
          return;
        }
        createdUrl = await loadLocalImage(resolved.path);
        if (cancelled) {
          URL.revokeObjectURL(createdUrl);
          return;
        }
        objectUrlRef.current = createdUrl;
        resolvedPathRef.current = resolved.path;
        setResolvedSrc(createdUrl);
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('unavailable');
      });

    return () => {
      cancelled = true;
      if (createdUrl && objectUrlRef.current !== createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [block.outputRef?.relPath, conversationId, inlineSrc, retryNonce]);

  useEffect(() => () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  const unavailable = state === 'unavailable';
  if (!src) {
    return (
      <div className={cn(frameClassName, 'flex items-center justify-center bg-fill')}>
        {state === 'loading' ? (
          <Spinner size="sm" labelHidden label={t.chat.imageLoading} />
        ) : unavailable ? (
          <div className="flex flex-col items-center gap-1 px-3 text-center text-caption text-label-tertiary">
            <Icon icon={AppIcons.imageMissing} size="lg" />
            <span>{t.chat.imageUnavailable}</span>
            {block.outputRef?.basename && <span className="max-w-full truncate">{block.outputRef.basename}</span>}
            <Button
              variant="plain"
              size="sm"
              icon={AppIcons.retry}
              onClick={(e) => {
                e.stopPropagation();
                setRetryNonce((value) => value + 1);
              }}
            >
              {t.chat.imageRetry}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <Pressable
      className={cn('relative group inline-block cursor-pointer', frameClassName)}
      // The app's image viewer shows it enlarged. A saved image goes there as the very file this
      // thumbnail read: the viewer finds files by name, and two tool images can share one name.
      onClick={(event) => useImageLightboxStore.getState().open([{
        // An inline image is named after this thumbnail, never after its bytes.
        id: block.outputRef?.relPath ?? `${alt}:${thumbnailId}`,
        mediaType: block.source.media_type,
        data: block.source.data,
        filePath: resolvedPathRef.current ?? undefined,
        conversationId,
        workspacePath: undefined,
      }], 0, event.currentTarget)}
    >
      <img
        src={src}
        alt={alt}
        className={thumbnailClassName}
      />
      <span className="absolute inset-0 flex items-center justify-center transition-colors group-hover:bg-scrim group-focus-visible:bg-scrim">
        <span className="rounded-control bg-raised p-1 text-label opacity-0 shadow-float transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          <Icon icon={AppIcons.enlarge} size="md" />
        </span>
      </span>
    </Pressable>
  );
}

function ScreenshotThumbnail({ resultContent, conversationId }: {
  resultContent: ToolResultContent[] | undefined;
  conversationId?: string;
}) {
  if (!resultContent) return null;

  // Same "first image" intent as firstImageContent (core/tools/toolResultContent),
  // minus its empty-source.data guard. Kept local for now — migrating it would
  // change what this thumbnail does with a zero-byte payload.
  const imageBlock = resultContent.find(b => b.type === 'image');
  if (!imageBlock || imageBlock.type !== 'image') return null;

  return (
    <ToolResultImagePreview
      block={imageBlock}
      conversationId={conversationId}
      alt="Screenshot"
      frameClassName="mb-2 rounded-control border border-separator max-w-[280px] max-h-[180px] min-w-[120px] min-h-[80px] overflow-hidden"
      thumbnailClassName="rounded-control max-w-[280px] max-h-[180px] object-contain"
    />
  );
}

/** File references the user themselves brought into the conversation. */
interface UserFileRefs {
  /** Raw text from user messages (matched as substrings against basenames). */
  texts: string[];
  /** Basenames of files the user uploaded as attachments. */
  uploads: Set<string>;
}

/** Collect file references the user supplied — message text + uploaded image filenames. */
function collectUserFileRefs(messages: Message[]): UserFileRefs {
  const texts: string[] = [];
  const uploads = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      texts.push(m.content);
    } else {
      for (const c of m.content) {
        if (c.type === 'text') texts.push(c.text);
        else if (c.type === 'image' && c.filePath) uploads.add(getBaseName(c.filePath));
      }
    }
  }
  return { texts, uploads };
}

/** Whether a read_file basename was supplied by the user (so it shouldn't be re-shown). */
function isUserProvided(basename: string, refs: UserFileRefs): boolean {
  if (refs.uploads.has(basename)) return true;
  return refs.texts.some((t) => t.includes(basename));
}

/**
 * Renders images returned by non-Computer-Use tool results inline in the message
 * bubble, so they stay visible in the conversation flow instead of being buried
 * in the collapsible tool panel.
 *
 * Only surfaces images Abu fetched/produced on its own (e.g. a QR code it
 * generated via CLI, then read back). Images whose path the user supplied —
 * either by naming the file or uploading it — are skipped: the user already has
 * that file, so re-posting it is noise. Computer Use screenshots are also
 * excluded; they keep their own thumbnail UX inside ToolCallsGroup.
 */
export function InlineToolResultImages({ toolCalls, conversationId }: { toolCalls: ToolCall[]; conversationId?: string }) {
  const messages = useChatStore((s) => (conversationId ? s.conversations[conversationId]?.messages : undefined));
  const userRefs = useMemo(() => collectUserFileRefs(messages ?? []), [messages]);

  // Collects EVERY image block, so it deliberately does not use
  // firstImageContent (core/tools/toolResultContent) — different semantics, not
  // a duplicate of it.
  const images: ToolResultImageBlock[] = [];
  for (const tc of toolCalls) {
    // generate_image is excluded here: its saved file already renders once as a
    // rich ImagePreviewCard (from fileOutputs), so surfacing its resultContent
    // image block here too would double the image. Old messages generated before
    // generate_image stopped returning an image block still have one stored, so
    // this guard (not just the tool's return change) is what dedupes them.
    if (tc.hidden || tc.name === TOOL_NAMES.COMPUTER || tc.name === TOOL_NAMES.GENERATE_IMAGE) continue;
    if (!tc.resultContent?.some((b) => b.type === 'image')) continue;
    const path = typeof tc.input?.path === 'string' ? tc.input.path : '';
    const base = path ? getBaseName(path) : '';
    if (base && isUserProvided(base, userRefs)) continue;
    for (const block of tc.resultContent) {
      if (block.type === 'image' && (block.source.data || block.outputRef?.relPath)) {
        images.push(block);
      }
    }
  }
  if (images.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((block, i) => (
        <ToolResultImagePreview
          key={`${block.outputRef?.relPath ?? block.source.data.slice(0, 24)}:${i}`}
          block={block}
          conversationId={conversationId}
          alt="Image"
          frameClassName="rounded-panel overflow-hidden border border-separator bg-surface min-w-24 min-h-24"
          thumbnailClassName="block w-auto max-w-[240px] max-h-[240px] object-contain"
        />
      ))}
    </div>
  );
}
