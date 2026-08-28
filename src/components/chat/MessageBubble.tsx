import { ChevronDown, ChevronRight, ChevronUp, Copy, Pencil, RefreshCw, Check, Brain, Wand2, AtSign, FileText, FolderOpen, ImageOff, ThumbsUp, ThumbsDown, CheckSquare } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { Message, MessageContent } from '@/types';
import MarkdownRenderer from './MarkdownRenderer';
import ToolCallsGroup, { InlineToolResultImages } from './ToolCallsGroup';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { sendFeedback } from '@/utils/consoleFeedback';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { usePreviewStore } from '@/stores/previewStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { useTodosStore } from '@/stores/todosStore';
import { useLabsFlag } from '@/core/labs/resolve';
import { LABS_TODOS_INBOX } from '@/core/labs/registry';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { useI18n, format } from '@/i18n';
import { getBaseName, loadLocalImage } from '@/utils/pathUtils';
import { formatRelativeTime } from '@/utils/messageTime';
import { computeRewindImpact } from '@/utils/rewindImpact';
import { rebuildImageAttachments } from './imageAttachmentRebuild';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import abuAvatar from '@/assets/abu-avatar.png';

// Regex to match [Attachment: `path`] patterns in user messages
const ATTACHMENT_PATTERN = /\[Attachment:\s*`([^`]+)`\]/g;

// Threshold for auto-collapsing long user messages
const LONG_TEXT_CHARS = 500;
const LONG_TEXT_LINES = 8;

/** Extract attachment paths and clean text from user message content */
function extractAttachments(text: string): { cleanText: string; attachmentPaths: string[] } {
  const paths: string[] = [];
  const cleanText = text.replace(ATTACHMENT_PATTERN, (_, path) => {
    paths.push(path);
    return '';
  }).trim();
  return { cleanText, attachmentPaths: paths };
}

/** Image thumbnail that loads from base64 data, disk filePath, or snapshot fallback */
type UserImageBlock = Extract<MessageContent, { type: 'image' }>;

function UserImageThumbnail({
  image,
  images,
  index,
  messageId,
}: {
  image: UserImageBlock;
  images: UserImageBlock[];
  index: number;
  messageId: string;
}) {
  const { t } = useI18n();
  const conversationId = useChatStore((s) => s.activeConversationId) ?? undefined;
  const workspacePath = useChatStore((s) => {
    const id = s.activeConversationId;
    return id ? (s.conversations[id]?.workspacePath ?? null) : null;
  });
  const hasData = !!image.source.data;
  const [diskSrc, setDiskSrc] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (hasData || !image.filePath) return;
    let cancelled = false;
    let revoke: string | null = null;

    // Try original first; fall back to snapshot via resolveFileSource
    (async () => {
      const { resolveFileSource } = await import('@/core/session/outputSnapshots');
      const resolved = await resolveFileSource(conversationId, image.filePath!, workspacePath);
      if (cancelled) return;
      if (resolved.status !== 'available') {
        setExpired(true);
        return;
      }
      try {
        const url = await loadLocalImage(resolved.path);
        if (cancelled) { URL.revokeObjectURL(url); return; }
        revoke = url;
        setDiskSrc(url);
      } catch {
        if (!cancelled) setExpired(true);
      }
    })();

    return () => { cancelled = true; if (revoke) URL.revokeObjectURL(revoke); };
  }, [hasData, image.filePath, conversationId, workspacePath]);

  const src = hasData
    ? `data:${image.source.media_type};base64,${image.source.data}`
    : diskSrc;

  if (expired) {
    return (
      <div
        className="w-8 h-8 rounded overflow-hidden border border-[var(--abu-bg-pressed)] flex items-center justify-center bg-[var(--abu-bg-muted)]"
        title={t.chat.imageExpired}
      >
        <ImageOff className="w-4 h-4 text-[var(--abu-text-muted)]" />
      </div>
    );
  }

  if (!src) {
    return (
      <div className="w-8 h-8 rounded overflow-hidden border border-[var(--abu-bg-pressed)] bg-[var(--abu-bg-muted)] animate-pulse" />
    );
  }

  return (
    <button
      type="button"
      className="w-8 h-8 rounded overflow-hidden border border-[var(--abu-border-subtle)] hover:border-[var(--abu-border-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-clay)]"
      onClick={(event) => {
        useImageLightboxStore.getState().open(
          images.map((item, imageIndex) => ({
            id: `${messageId}:image:${imageIndex}`,
            data: item.source.data,
            mediaType: item.source.media_type,
            filePath: item.filePath,
            conversationId,
            workspacePath,
          })),
          index,
          event.currentTarget,
        );
      }}
      title={t.chat.clickToViewFull}
      aria-label={t.chat.clickToViewFull}
    >
      <img src={src} alt="" className="w-full h-full object-cover" />
    </button>
  );
}

/** Clickable file chip for user message attachments */
function UserAttachmentChip({ filePath }: { filePath: string }) {
  const openPreview = usePreviewStore((s) => s.openPreview);
  const fileName = getBaseName(filePath);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    openPreview(filePath);
  };

  const handleReveal = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(filePath);
    } catch { /* ignore in non-Tauri env */ }
  };

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[var(--abu-bg-muted)] border border-[var(--abu-bg-pressed)] hover:border-[var(--abu-clay-40)] cursor-pointer transition-all text-body group/chip"
      title={filePath}
      onClick={handleClick}
    >
      <FileText className="w-3.5 h-3.5 text-[var(--abu-text-muted)] shrink-0" />
      <span className="text-[var(--abu-text-primary)] truncate max-w-[200px]">{fileName}</span>
      <button
        onClick={handleReveal}
        className="p-0.5 rounded hover:bg-[var(--abu-bg-pressed)] opacity-0 group-hover/chip:opacity-100 transition-opacity shrink-0"
      >
        <FolderOpen className="w-3 h-3 text-[var(--abu-text-muted)]" />
      </button>
    </span>
  );
}

// Helper to get text content from Message
function getTextContent(content: string | MessageContent[]): string {
  if (typeof content === 'string') return content;
  const textBlock = content.find((c) => c.type === 'text');
  return textBlock?.type === 'text' ? textBlock.text : '';
}

// Helper to get image blocks from Message content
function getImageBlocks(content: string | MessageContent[]): Extract<MessageContent, { type: 'image' }>[] {
  if (typeof content === 'string') return [];
  return content.filter((c): c is Extract<MessageContent, { type: 'image' }> => c.type === 'image');
}

/**
 * Re-attach the original routing prefix (`@expert` or `/skill`) to user text
 * for edit / regenerate paths. The user message we store is post-routing
 * cleanInput (without the prefix), so resending raw text would fall back to
 * the default route and lose the expert / skill association.
 */
function reattachRoutingPrefix(body: string, original: Message): string {
  const trimmed = body.trim();
  if (original.delegateAgent) {
    return trimmed ? `@${original.delegateAgent.name} ${trimmed}` : `@${original.delegateAgent.name}`;
  }
  if (original.skill) {
    return trimmed ? `/${original.skill.name} ${trimmed}` : `/${original.skill.name}`;
  }
  return body;
}

// Thinking block component for extended thinking
function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] max-w-full">
      <button
        onClick={() => setExpanded(!expanded)}
        className="btn-ghost w-full flex items-center gap-2 px-3.5 py-2.5 text-body hover:bg-[var(--abu-bg-hover)]"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
        )}
        <Brain className="h-3.5 w-3.5 text-purple-500 shrink-0" />
        <span className="text-body font-medium text-[var(--abu-text-primary)]">{t.chat.thinkingProcess}</span>
      </button>
      {expanded && (
        <div className="border-t border-[var(--abu-border-subtle)] px-4 py-3">
          <pre className="text-minor text-[var(--abu-text-tertiary)] whitespace-pre-wrap break-words leading-relaxed">
            {thinking}
          </pre>
        </div>
      )}
    </div>
  );
}

// Message action toolbar
interface MessageActionsProps {
  message: Message;
  onEdit: () => void;
  onRegenerate: () => void;
  isUser: boolean;
  conversationId?: string;
}

/**
 * Hover-only timestamp shown next to / below a message bubble.
 * Inline so callers can position it per role (user → below bubble right-aligned,
 * assistant → alongside actions). Lives inside a `group` parent that toggles
 * opacity on hover.
 */
function MessageTimestamp({ timestamp, className = '' }: { timestamp: number; className?: string }) {
  return (
    <span
      className={`text-caption text-[var(--abu-text-muted)] tabular-nums select-none whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity ${className}`}
      title={new Date(timestamp).toLocaleString()}
    >
      {formatRelativeTime(timestamp)}
    </span>
  );
}

function MessageActions({ message, onEdit, onRegenerate, isUser, conversationId }: MessageActionsProps) {
  const { t } = useI18n();
  const showTodosInbox = useLabsFlag(LABS_TODOS_INBOX);
  const [copied, setCopied] = useState(false);
  const [addedToTodos, setAddedToTodos] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<'positive' | 'negative' | null>(null);
  const activeSkill = useChatStore((s) => {
    const conv = conversationId ? s.conversations[conversationId] : undefined;
    return conv?.activeSkills?.[0] ?? null;
  });

  const handleCopy = async () => {
    const text = getTextContent(message.content);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      {/* Copy button */}
      <button
        onClick={handleCopy}
        className="btn-ghost p-1.5 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
        title={t.chat.copy}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-[var(--abu-success)]" /> : <Copy className="h-3.5 w-3.5" />}
      </button>

      {/* Edit button - only for user messages */}
      {isUser && (
        <button
          onClick={onEdit}
          className="btn-ghost p-1.5 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
          title={t.chat.edit}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Regenerate button - only for assistant messages */}
      {!isUser && (
        <button
          onClick={onRegenerate}
          className="btn-ghost p-1.5 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]"
          title={t.chat.regenerate}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Feedback buttons - only for assistant messages */}
      {!isUser && (
        <>
          <button
            onClick={() => {
              const next = feedbackRating === 'positive' ? null : 'positive';
              setFeedbackRating(next);
              sendFeedback(next ?? 'cancel', conversationId, message.id, activeSkill);
            }}
            className={cn(
              'btn-ghost p-1.5 rounded-md transition-colors',
              feedbackRating === 'positive'
                ? 'text-[var(--abu-success)] bg-[var(--abu-bg-hover)]'
                : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
            )}
            title={t.chat.feedbackPositive}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              const next = feedbackRating === 'negative' ? null : 'negative';
              setFeedbackRating(next);
              sendFeedback(next ?? 'cancel', conversationId, message.id, activeSkill);
            }}
            className={cn(
              'btn-ghost p-1.5 rounded-md transition-colors',
              feedbackRating === 'negative'
                ? 'text-[var(--abu-danger)] bg-[var(--abu-bg-hover)]'
                : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
            )}
            title={t.chat.feedbackNegative}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
        </>
      )}

      {/* Add to Todos button - only for assistant messages */}
      {showTodosInbox && !isUser && (
        <button
          onClick={() => {
            const text = getTextContent(message.content).slice(0, 60).trim();
            if (!text) return;
            useTodosStore.getState().createTodo({
              title: text,
              source: 'conversation',
              sourceConversationId: conversationId ?? undefined,
            });
            setAddedToTodos(true);
            setTimeout(() => setAddedToTodos(false), 1500);
          }}
          className={cn(
            'btn-ghost p-1.5 rounded-md transition-colors',
            addedToTodos
              ? 'text-[var(--abu-success)] bg-[var(--abu-bg-hover)]'
              : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-clay)] hover:bg-[var(--abu-bg-hover)]',
          )}
          title={addedToTodos ? t.todos.addedToTodos : t.todos.addToTodos}
        >
          {addedToTodos ? <Check className="h-3.5 w-3.5" /> : <CheckSquare className="h-3.5 w-3.5" />}
        </button>
      )}

    </div>
  );
}

// Edit input for user messages — card style
function EditInput({
  initialContent,
  delegateAgentName,
  skillName,
  onSave,
  onCancel
}: {
  initialContent: string;
  delegateAgentName?: string;
  skillName?: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialContent);
  const { t } = useI18n();
  const routingChip = delegateAgentName
    ? { label: `@${delegateAgentName}`, color: 'text-[var(--abu-info)] bg-[var(--abu-info-bg)]' }
    : skillName
      ? { label: `/${skillName}`, color: 'text-purple-600 bg-purple-50' }
      : null;

  return (
    <div className="min-w-[280px] rounded-2xl border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] overflow-hidden">
      {routingChip && (
        <div className="flex items-center px-4 pt-3 pb-1 bg-[var(--abu-bg-muted)]">
          <span className={cn('inline-flex items-center px-2 py-0.5 rounded-md text-minor font-medium', routingChip.color)}>
            {routingChip.label}
          </span>
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full min-h-[80px] px-4 py-3 bg-[var(--abu-bg-muted)] text-body text-[var(--abu-text-primary)] resize-none focus:outline-none border-none"
        autoFocus
      />
      <div className="flex items-center justify-end gap-3 px-4 py-2.5 border-t border-[var(--abu-bg-pressed)]">
        <button
          onClick={onCancel}
          className="btn-ghost text-body text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] transition-colors"
        >
          {t.common.cancel}
        </button>
        <button
          onClick={() => onSave(text)}
          className="btn-ghost flex items-center gap-1.5 px-4 py-1.5 rounded-full text-body bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t.chat.saveAndResend}
        </button>
      </div>
    </div>
  );
}

export default function MessageBubble({
  message,
  hideAvatar = false,
  actionsOnly = false
}: {
  message: Message;
  hideAvatar?: boolean;
  actionsOnly?: boolean;
}) {
  const { t } = useI18n();
  const isUser = message.role === 'user';
  const [isEditing, setIsEditing] = useState(false);
  const [isTextExpanded, setIsTextExpanded] = useState(false);
  const activeConv = useActiveConversation();
  const isConvRunning = activeConv?.status === 'running';
  const hasRunFailure = message.runState === 'failed' || message.runState === 'connection-failed';

  // Rewind (edit-resend / regenerate / run-retry) truncates the conversation
  // from the redone turn onward via deleteMessagesFrom, durably discarding
  // anything after it. When that redone turn isn't the conversation's last,
  // later turns would be silently lost — gate those cases behind a confirm.
  // `run` holds the exact same delete+resend steps the unconfirmed path would
  // have executed immediately.
  const [pendingRewind, setPendingRewind] = useState<{ laterTurnsCount: number; run: () => void } | null>(null);
  const rewindConfirmDialog = (
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
  );

  const textContent = getTextContent(message.content);
  const imageBlocks = getImageBlocks(message.content);
  const convId = activeConv?.id;

  const handleEdit = () => {
    setIsEditing(true);
  };

  const handleSaveEdit = async (newContent: string) => {
    if (!convId) return;
    const imageAttachments = rebuildImageAttachments(message.content, `edit-${Date.now()}`);
    setIsEditing(false);

    const proceed = async () => {
      // Delete this message and all subsequent messages, then runAgentLoopDispatched creates a fresh one
      useChatStore.getState().deleteMessagesFrom(convId, message.id);
      // Re-attach the original routing prefix (@expert or /skill) so the
      // edited resend stays on the same agent / skill — otherwise the message
      // falls back to the default `general` route and the expert is lost.
      const routedContent = reattachRoutingPrefix(newContent, message);
      await runAgentLoopDispatched(convId, routedContent, imageAttachments ? { images: imageAttachments } : undefined);
    };

    // `message` is a user message and, per the invariant documented on
    // handleRunRetry below, is itself the first message of its loop — so its
    // loopId directly identifies the turn being redone.
    const impact = activeConv
      ? computeRewindImpact(activeConv.messages, message.loopId, message.id)
      : { hasLaterTurns: false, laterTurnsCount: 0 };
    if (impact.hasLaterTurns) {
      setPendingRewind({ laterTurnsCount: impact.laterTurnsCount, run: proceed });
      return;
    }
    await proceed();
  };

  const handleRunRetry = async () => {
    if (!convId || !activeConv || message.role !== 'user') return;
    const imageAttachments = rebuildImageAttachments(message.content, `run-retry-${Date.now()}`);
    const routedContent = reattachRoutingPrefix(getTextContent(message.content), message);
    // Rewind semantics (plan stage 3): truncate from the retried turn's FIRST
    // message. `message` is itself that first message when it belongs to a
    // loop (the user message is always added before any assistant message of
    // the same loop — see agentLoop.ts), so finding the earliest message
    // sharing its loopId is equivalent to using `message.id` directly; doing
    // the lookup explicitly keeps this correct even if that invariant ever
    // changes upstream.
    const truncateFromId = message.loopId
      ? activeConv.messages.find((m) => m.loopId === message.loopId)?.id ?? message.id
      : message.id;

    const proceed = async () => {
      useChatStore.getState().deleteMessagesFrom(convId, truncateFromId);
      await runAgentLoopDispatched(
        convId,
        routedContent,
        imageAttachments ? { images: imageAttachments } : undefined,
      );
    };

    const impact = computeRewindImpact(activeConv.messages, message.loopId, message.id);
    if (impact.hasLaterTurns) {
      setPendingRewind({ laterTurnsCount: impact.laterTurnsCount, run: proceed });
      return;
    }
    await proceed();
  };

  const handleRegenerate = async () => {
    if (!convId || !activeConv) return;
    const messages = activeConv.messages;

    // Find the user message to regenerate from
    // If this message has a loopId, find the user message with the same loopId
    // Otherwise, fall back to finding the previous user message
    let userMsgToRegenerate: Message | undefined;

    if (message.loopId) {
      // Find user message with the same loopId
      userMsgToRegenerate = messages.find(
        (m) => m.role === 'user' && m.loopId === message.loopId
      );
    }

    if (!userMsgToRegenerate) {
      // Fallback: find the previous user message by index
      const idx = messages.findIndex((m) => m.id === message.id);
      if (idx > 0) {
        userMsgToRegenerate = messages
          .slice(0, idx)
          .reverse()
          .find((m) => m.role === 'user');
      }
    }

    if (userMsgToRegenerate) {
      // Bind to a const so the `proceed` closure below keeps the narrowed
      // (non-undefined) type — TS narrowing on the outer `let` doesn't
      // persist across a nested function boundary.
      const targetUserMsg = userMsgToRegenerate;
      const userContent = getTextContent(targetUserMsg.content);
      // Re-attach the original @expert / /skill prefix so the regenerated
      // turn stays on the same route — the user message stored content is
      // post-routing cleanInput, so the prefix is otherwise lost.
      const routedContent = reattachRoutingPrefix(userContent, targetUserMsg);
      const imageAttachments = rebuildImageAttachments(targetUserMsg.content, `regen-${Date.now()}`);

      const proceed = async () => {
        // Delete from user message onwards and regenerate
        useChatStore.getState().deleteMessagesFrom(convId, targetUserMsg.id);
        await runAgentLoopDispatched(convId, routedContent, imageAttachments ? { images: imageAttachments } : undefined);
      };

      const impact = computeRewindImpact(messages, targetUserMsg.loopId, targetUserMsg.id);
      if (impact.hasLaterTurns) {
        setPendingRewind({ laterTurnsCount: impact.laterTurnsCount, run: proceed });
        return;
      }
      await proceed();
    }
  };

  // Actions only mode - just render the action buttons
  if (actionsOnly && !isUser) {
    return (
      <>
        {rewindConfirmDialog}
        <div className="flex items-center gap-2">
          <MessageActions
            message={message}
            onEdit={() => {}}
            onRegenerate={handleRegenerate}
            isUser={false}
            conversationId={convId}
          />
          {message.timestamp && <MessageTimestamp timestamp={message.timestamp} />}
        </div>
      </>
    );
  }

  if (isUser) {
    // Extract file attachments from user message text
    const { cleanText: userCleanText, attachmentPaths } = extractAttachments(textContent);
    return (
      <div className="flex justify-end w-full group">
        {rewindConfirmDialog}
        <div className="flex flex-col items-end gap-1.5 max-w-[85%]">
          {/* Image thumbnails — above the text bubble */}
          {imageBlocks.length > 0 && !isEditing && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {imageBlocks.map((img, idx) => (
                <UserImageThumbnail
                  key={`${message.id}:image:${idx}`}
                  image={img}
                  images={imageBlocks}
                  index={idx}
                  messageId={message.id}
                />
              ))}
            </div>
          )}
          {/* File attachment chips — above the bubble */}
          {attachmentPaths.length > 0 && !isEditing && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {attachmentPaths.map((path, idx) => (
                <UserAttachmentChip key={idx} filePath={path} />
              ))}
            </div>
          )}
          {/* Delegate agent badge — above the bubble */}
          {message.delegateAgent && (
            <div className="flex items-center justify-end gap-1 text-[var(--abu-text-muted)]">
              <AtSign className="h-3 w-3" />
              <span className="text-caption font-medium">{message.delegateAgent.name}</span>
            </div>
          )}
          {isEditing ? (
            <EditInput
              initialContent={textContent}
              delegateAgentName={message.delegateAgent?.name}
              skillName={message.skill?.name}
              onSave={handleSaveEdit}
              onCancel={() => setIsEditing(false)}
            />
          ) : (
            <>
              {/* Hide bubble when there's no text and no skill badge (pure image message) */}
              {(userCleanText || message.skill) && (
                <div className="px-4 py-2.5 rounded-2xl rounded-br-sm bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]">
                  {/* Skill badge inside bubble */}
                  {message.skill && (
                    <div className="flex items-center gap-1.5 mb-1.5 opacity-90">
                      <Wand2 className="h-3 w-3" />
                      <span className="text-caption font-medium">/{message.skill.name}</span>
                    </div>
                  )}
                  {userCleanText && (() => {
                    const isLongText =
                      userCleanText.length > LONG_TEXT_CHARS ||
                      (userCleanText.match(/\n/g) ?? []).length >= LONG_TEXT_LINES;
                    return (
                      <div className="text-body leading-relaxed break-words select-text">
                        {isLongText ? (
                          <>
                            <div className={cn('relative', !isTextExpanded && 'max-h-32 overflow-hidden')}>
                              <MarkdownRenderer content={userCleanText} variant="user" />
                              {!isTextExpanded && (
                                <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-[var(--abu-bg-active)] to-transparent pointer-events-none" />
                              )}
                            </div>
                            <button
                              type="button"
                              onClick={() => setIsTextExpanded(v => !v)}
                              className="mt-1.5 flex items-center gap-1 text-[var(--abu-clay)] hover:opacity-75 text-minor font-medium transition-opacity"
                            >
                              {isTextExpanded ? (
                                <><ChevronUp className="h-3 w-3" />{t.chat.userMessageCollapse}</>
                              ) : (
                                <><ChevronDown className="h-3 w-3" />{t.chat.userMessageShowMore}</>
                              )}
                            </button>
                          </>
                        ) : (
                          <MarkdownRenderer content={userCleanText} variant="user" />
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
              {/* Reliable-run progress is internal. The assistant activity row already
                  communicates that work is in progress; only actionable failures belong
                  under the user's message. */}
              {hasRunFailure && (
                <div className="flex items-center gap-1.5 text-caption text-[var(--abu-danger)]" title={message.runError}>
                  <span>
                    {message.runState === 'failed' && t.chat.runFailed}
                    {message.runState === 'connection-failed' && t.chat.runConnectionFailed}
                  </span>
                  {!isConvRunning && (
                    <Button variant="ghost" size="xs" onClick={handleRunRetry}>
                      <RefreshCw className="h-3 w-3" />
                      {t.chat.runRetry}
                    </Button>
                  )}
                </div>
              )}
              {/* Actions + timestamp row below bubble */}
              <div className="flex items-center gap-1.5">
                {!isConvRunning && (
                  <MessageActions
                    message={message}
                    onEdit={handleEdit}
                    onRegenerate={handleRegenerate}
                    isUser={true}
                  />
                )}
                {message.timestamp && <MessageTimestamp timestamp={message.timestamp} />}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // Assistant message - when hideAvatar is true, render content only (used in MessageGroup)
  if (hideAvatar) {
    return (
      <div className="assistant-turn">
        {rewindConfirmDialog}
        {/* Thinking block if present */}
        {message.thinking && <ThinkingBlock thinking={message.thinking} />}

        {textContent && (
          <div className="text-[var(--abu-text-primary)] break-words select-text">
            <MarkdownRenderer content={textContent} />
          </div>
        )}
        {/* Tool calls - grouped in a single collapsible block */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsGroup toolCalls={message.toolCalls} conversationId={convId} />
        )}
        {/* Inline images from non-CU tool results (e.g. read_file QR codes) */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <InlineToolResultImages toolCalls={message.toolCalls} conversationId={convId} />
        )}
        {message.isStreaming && <span className="streaming-cursor" />}

        {/* Token usage display */}
        {message.usage && !message.isStreaming && (
          <div className="mt-2 text-caption text-[var(--abu-text-muted)]">
            {message.usage.inputTokens != null && `${t.chat.inputTokens}: ${message.usage.inputTokens.toLocaleString()}`}
            {message.usage.outputTokens != null && ` · ${t.chat.outputTokens}: ${message.usage.outputTokens.toLocaleString()}`}
          </div>
        )}

        {/* Actions - show on hover when not streaming */}
        {!message.isStreaming && !isConvRunning && (
          <div className="mt-2 flex items-center gap-2">
            <MessageActions
              message={message}
              onEdit={() => {}}
              onRegenerate={handleRegenerate}
              isUser={false}
              conversationId={convId}
            />
            {message.timestamp && <MessageTimestamp timestamp={message.timestamp} />}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex gap-3 w-full overflow-hidden group">
      {rewindConfirmDialog}
      {/* ABU Avatar - 小布丁人 */}
      <div className="shrink-0 mt-0.5">
        <div className="w-7 h-7 rounded-full overflow-hidden">
          <img src={abuAvatar} alt="Abu" className="w-full h-full object-cover" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Thinking block if present */}
        {message.thinking && <ThinkingBlock thinking={message.thinking} />}

        {textContent && (
          <div className="text-[var(--abu-text-primary)] break-words select-text">
            <MarkdownRenderer content={textContent} />
          </div>
        )}
        {/* Tool calls - grouped in a single collapsible block */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsGroup toolCalls={message.toolCalls} conversationId={convId} />
        )}
        {/* Inline images from non-CU tool results (e.g. read_file QR codes) */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <InlineToolResultImages toolCalls={message.toolCalls} conversationId={convId} />
        )}
        {message.isStreaming && <span className="streaming-cursor" />}

        {/* Token usage display */}
        {message.usage && !message.isStreaming && (
          <div className="mt-2 text-caption text-[var(--abu-text-muted)]">
            {message.usage.inputTokens != null && `${t.chat.inputTokens}: ${message.usage.inputTokens.toLocaleString()}`}
            {message.usage.outputTokens != null && ` · ${t.chat.outputTokens}: ${message.usage.outputTokens.toLocaleString()}`}
          </div>
        )}

        {/* Actions - show on hover when not streaming */}
        {!message.isStreaming && !isConvRunning && (
          <div className="mt-2 flex items-center gap-2">
            <MessageActions
              message={message}
              onEdit={() => {}}
              onRegenerate={handleRegenerate}
              isUser={false}
              conversationId={convId}
            />
            {message.timestamp && <MessageTimestamp timestamp={message.timestamp} />}
          </div>
        )}
      </div>
    </div>
  );
}
