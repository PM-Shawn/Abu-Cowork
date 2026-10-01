import { memo, useState, useEffect } from 'react';
import type { Message, MessageContent } from '@/types';
import MarkdownRenderer from './MarkdownRenderer';
import ToolCallsGroup, { InlineToolResultImages } from './ToolCallsGroup';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { sendFeedback } from '@/utils/consoleFeedback';
import { cn } from '@/lib/utils';
import { Button, IconButton } from '@/components/ds/button';
import { Pressable } from '@/components/ds/pressable';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Tag } from '@/components/ds/tag';
import { TextArea } from '@/components/ds/text-area';
import { usePreviewStore } from '@/stores/previewStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { useTodosStore } from '@/stores/todosStore';
import { useLabsFlag } from '@/core/labs/resolve';
import { LABS_TODOS_INBOX } from '@/core/labs/registry';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { ensureConversationModelUsable } from './sendModelGuard';
import { announceChatTurnScrollIntent } from './chatTurnScrollIntent';
import { useI18n, format } from '@/i18n';
import { getBaseName, loadLocalImage } from '@/utils/pathUtils';
import { formatRelativeTime } from '@/utils/messageTime';
import { computeRewindImpact } from '@/utils/rewindImpact';
import { rebuildImageAttachments } from './imageAttachmentRebuild';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import abuAvatar from '@/assets/abu-avatar.png';
import AgentAvatar from '@/components/common/AgentAvatar';
import TeamAvatar from '@/components/team/TeamAvatar';
import { isIntroductionMessage } from '@/core/team/expertContact';

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
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-control border border-separator bg-fill"
        title={t.chat.imageExpired}
      >
        <Icon icon={AppIcons.imageMissing} className="text-label-tertiary" />
      </div>
    );
  }

  if (!src) {
    return (
      <div className="h-8 w-8 overflow-hidden rounded-control border border-separator bg-fill" />
    );
  }

  return (
    <Pressable
      className="h-8 w-8 overflow-hidden rounded-control border border-separator transition-colors duration-fast hover:border-control-border"
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
    </Pressable>
  );
}

/** Clickable file chip for user message attachments. Memoized: its reveal button carries
 *  a tooltip, and the bubble above it re-renders with every streamed token of the reply. */
const UserAttachmentChip = memo(function UserAttachmentChip({ filePath }: { filePath: string }) {
  const { t } = useI18n();
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
    <span className="group/chip inline-flex items-center gap-1 rounded-control border border-separator bg-surface py-1 pl-2 pr-1 transition-colors duration-fast hover:border-control-border">
      <Pressable
        className="inline-flex min-w-0 items-center gap-1 rounded-control text-ui text-label"
        title={filePath}
        onClick={handleClick}
      >
        <Icon icon={AppIcons.file} size="sm" className="text-label-secondary" />
        <span className="max-w-52 truncate">{fileName}</span>
      </Pressable>
      <IconButton
        icon={AppIcons.folderOpen}
        label={t.chat.openInFinder}
        size="sm"
        onClick={handleReveal}
        className="opacity-0 group-hover/chip:opacity-100 focus-visible:opacity-100"
      />
    </span>
  );
});

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
    <div className="my-3 max-w-full overflow-hidden rounded-panel border border-separator bg-surface">
      <Pressable
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-ui transition-colors duration-fast hover:bg-fill-hover"
      >
        <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" className="text-label-tertiary" />
        <Icon icon={AppIcons.thinking} size="sm" className="text-label-secondary" />
        <span className="font-medium text-label">{t.chat.thinkingProcess}</span>
      </Pressable>
      {expanded && (
        <div className="border-t border-separator px-4 py-3">
          <pre className="whitespace-pre-wrap break-words text-ui-sm text-label-secondary">
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
      className={cn('select-none whitespace-nowrap text-caption text-label-tertiary tabular-nums opacity-0 transition-opacity duration-fast group-hover:opacity-100', className)}
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
    <div className="flex items-center gap-1 opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100">
      <IconButton
        icon={copied ? AppIcons.done : AppIcons.copy}
        label={t.chat.copy}
        size="sm"
        onClick={handleCopy}
      />

      {/* Edit button - only for user messages */}
      {isUser && (
        <IconButton icon={AppIcons.rename} label={t.chat.edit} size="sm" onClick={onEdit} />
      )}

      {/* Regenerate button - only for assistant messages */}
      {!isUser && (
        <IconButton icon={AppIcons.retry} label={t.chat.regenerate} size="sm" onClick={onRegenerate} />
      )}

      {/* Feedback buttons - only for assistant messages */}
      {!isUser && (
        <>
          <IconButton
            icon={AppIcons.thumbsUp}
            label={t.chat.feedbackPositive}
            size="sm"
            aria-pressed={feedbackRating === 'positive'}
            onClick={() => {
              const next = feedbackRating === 'positive' ? null : 'positive';
              setFeedbackRating(next);
              sendFeedback(next ?? 'cancel', conversationId, message.id, activeSkill);
            }}
          />
          <IconButton
            icon={AppIcons.thumbsDown}
            label={t.chat.feedbackNegative}
            size="sm"
            aria-pressed={feedbackRating === 'negative'}
            onClick={() => {
              const next = feedbackRating === 'negative' ? null : 'negative';
              setFeedbackRating(next);
              sendFeedback(next ?? 'cancel', conversationId, message.id, activeSkill);
            }}
          />
        </>
      )}

      {/* Add to Todos button - only for assistant messages */}
      {showTodosInbox && !isUser && (
        <IconButton
          icon={addedToTodos ? AppIcons.done : AppIcons.todos}
          label={addedToTodos ? t.todos.addedToTodos : t.todos.addToTodos}
          size="sm"
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
        />
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
  const routingLabel = delegateAgentName
    ? `@${delegateAgentName}`
    : skillName
      ? `/${skillName}`
      : null;

  return (
    <div className="flex min-w-72 flex-col gap-3 rounded-panel border border-separator bg-surface p-3">
      {routingLabel && (
        <div className="flex items-center">
          <Tag>{routingLabel}</Tag>
        </div>
      )}
      <TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="min-h-20 text-body"
        autoFocus
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="plain" onClick={onCancel}>
          {t.common.cancel}
        </Button>
        <Button variant="primary" icon={AppIcons.retry} onClick={() => onSave(text)}>
          {t.chat.saveAndResend}
        </Button>
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
  // #549: an oversize turn can never succeed by retrying — the only way forward
  // is a fresh conversation, so the row swaps Retry for 「新建对话」.
  const isOversizeFailure = hasRunFailure && message.runErrorKind === 'payload_too_large';
  // #549: an oversize row states the limit in the label position, so only a
  // dispatch failure still needs a second line for its cause. 'sidecar_unavailable'
  // and a kind-less failure are 「发送失败」 + Retry alone; raw upstream `runError`
  // text stays hidden either way.
  const showFailureReason = hasRunFailure && message.runErrorKind === 'dispatch_failed';
  const handleNewConversationWithDraft = () => {
    // Text only: the store has no one-shot buffer for inline base64 images
    // (`addPendingAttachment` carries workspace paths, not attachments), so any
    // images on the failed turn are deliberately NOT carried over. See Task 7's
    // note on `setPendingInput` if an image buffer is ever added.
    // The same text Retry would send: the row holds the route's clean input,
    // so the `@expert` / `/skill` prefix has to go back on or the new turn
    // lands on the default route.
    const draft = reattachRoutingPrefix(getTextContent(message.content), message);
    const workspacePath = activeConv?.workspacePath;
    useChatStore.getState().startNewConversation();
    // startNewConversation() clears the workspace — right for a top-level 「新建任务」,
    // wrong here: this conversation is the same piece of work, and the text being
    // carried over can name paths inside that project. Restore it through the same
    // setter the workspace picker uses, so authorization is re-granted too.
    if (workspacePath) useWorkspaceStore.getState().setWorkspace(workspacePath);
    useSettingsStore.getState().setViewMode('chat');
    useChatStore.getState().setPendingInput(draft);
  };

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
    // Refuse before anything is deleted; the editor stays open so the edit survives.
    if (!ensureConversationModelUsable(activeConv, t.chat)) return;
    const imageAttachments = rebuildImageAttachments(message.content, `edit-${Date.now()}`);
    setIsEditing(false);

    const proceed = async () => {
      // Re-check: the provider may have been removed while the confirm was open.
      if (!ensureConversationModelUsable(useChatStore.getState().conversations[convId], t.chat)) return;
      // Delete this message and all subsequent messages, then runAgentLoopDispatched creates a fresh one
      useChatStore.getState().deleteMessagesFrom(convId, message.id);
      // Re-attach the original routing prefix (@expert or /skill) so the
      // edited resend stays on the same agent / skill — otherwise the message
      // falls back to the default `general` route and the expert is lost.
      const routedContent = reattachRoutingPrefix(newContent, message);
      announceChatTurnScrollIntent({ conversationId: convId, source: 'edit-resend' });
      await runAgentLoopDispatched(convId, routedContent, {
        initiatedBy: 'user',
        ...(imageAttachments ? { images: imageAttachments } : {}),
      });
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
    if (!ensureConversationModelUsable(activeConv, t.chat)) return;
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
      // Re-check: the provider may have been removed while the confirm was open.
      if (!ensureConversationModelUsable(useChatStore.getState().conversations[convId], t.chat)) return;
      useChatStore.getState().deleteMessagesFrom(convId, truncateFromId);
      announceChatTurnScrollIntent({ conversationId: convId, source: 'run-retry' });
      await runAgentLoopDispatched(
        convId,
        routedContent,
        { initiatedBy: 'user', ...(imageAttachments ? { images: imageAttachments } : {}) },
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
    if (!ensureConversationModelUsable(activeConv, t.chat)) return;
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
        // Re-check: the provider may have been removed while the confirm was open.
        if (!ensureConversationModelUsable(useChatStore.getState().conversations[convId], t.chat)) return;
        // Delete from user message onwards and regenerate
        useChatStore.getState().deleteMessagesFrom(convId, targetUserMsg.id);
        announceChatTurnScrollIntent({ conversationId: convId, source: 'regenerate' });
        await runAgentLoopDispatched(convId, routedContent, {
          initiatedBy: 'user',
          ...(imageAttachments ? { images: imageAttachments } : {}),
        });
      };

      const impact = computeRewindImpact(messages, targetUserMsg.loopId, targetUserMsg.id);
      if (impact.hasLaterTurns) {
        setPendingRewind({ laterTurnsCount: impact.laterTurnsCount, run: proceed });
        return;
      }
      await proceed();
    }
  };

  // Configured welcomes use the existing message layout without run actions.
  if (isIntroductionMessage(message)) {
    const identity = message.introduction!;
    return (
      <div className="flex gap-3 w-full overflow-hidden group" data-testid="expert-introduction" data-message-id={message.id}>
        <div className="shrink-0 mt-0.5">
          {identity.kind === 'team'
            ? <TeamAvatar avatar={identity.avatar} size="md" round />
            : <AgentAvatar agent={{ name: identity.agentName ?? identity.name, avatar: identity.avatar }} size="md" round />}
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="mb-2 text-ui-sm text-label-tertiary">{identity.name}</div>
          <div className="break-words text-label select-text"><MarkdownRenderer content={textContent} /></div>
        </div>
      </div>
    );
  }

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
      <div className="flex justify-end w-full group" data-message-id={message.id}>
        {rewindConfirmDialog}
        <div className="flex max-w-[85%] flex-col items-end gap-2">
          {/* Image thumbnails — above the text bubble */}
          {imageBlocks.length > 0 && !isEditing && (
            <div className="flex flex-wrap justify-end gap-2">
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
            <div className="flex flex-wrap justify-end gap-2">
              {attachmentPaths.map((path, idx) => (
                <UserAttachmentChip key={idx} filePath={path} />
              ))}
            </div>
          )}
          {/* Delegate agent badge — above the bubble */}
          {message.delegateAgent && (
            <div className="flex items-center justify-end gap-1 text-ui-sm text-label-secondary">
              <Icon icon={AppIcons.mention} size="sm" />
              <span className="font-medium">{message.delegateAgent.name}</span>
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
                <div className="rounded-panel bg-fill px-4 py-2 text-label">
                  {/* Skill badge inside bubble */}
                  {message.skill && (
                    <div className="mb-1 flex items-center gap-1 text-ui-sm text-label-secondary">
                      <Icon icon={AppIcons.skill} size="sm" />
                      <span className="font-medium">/{message.skill.name}</span>
                    </div>
                  )}
                  {userCleanText && (() => {
                    const isLongText =
                      userCleanText.length > LONG_TEXT_CHARS ||
                      (userCleanText.match(/\n/g) ?? []).length >= LONG_TEXT_LINES;
                    return (
                      <div className="text-body break-words select-text">
                        {isLongText ? (
                          <>
                            {/* The bubble fill is translucent, so the fade is a mask on the text
                                (last 40px of the 128px preview) instead of a gradient painted over it. */}
                            <div className={cn(!isTextExpanded && 'max-h-32 overflow-hidden mask-b-from-22')}>
                              <MarkdownRenderer content={userCleanText} variant="user" />
                            </div>
                            <Button
                              variant="plain"
                              size="sm"
                              icon={isTextExpanded ? AppIcons.collapse : AppIcons.expand}
                              onClick={() => setIsTextExpanded(v => !v)}
                              className="-ml-2 mt-1"
                            >
                              {isTextExpanded ? t.chat.userMessageCollapse : t.chat.userMessageShowMore}
                            </Button>
                          </>
                        ) : (
                          <MarkdownRenderer content={userCleanText} variant="user" />
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}
              {/* Reliable-run progress is internal (existing ruling, kept for #549):
                  waiting for the sidecar shows only the 「思考中」 activity row, and
                  only actionable failures belong under the user's message. */}
              {hasRunFailure && (
                <div className="max-w-2xl">
                  <InlineMessage
                    tone="danger"
                    action={!isConvRunning && (isOversizeFailure ? (
                      <Button variant="secondary" size="sm" icon={AppIcons.newTaskFromMessage} onClick={handleNewConversationWithDraft}>
                        {t.chat.newConversationAction}
                      </Button>
                    ) : (
                      <Button variant="secondary" size="sm" icon={AppIcons.retry} onClick={handleRunRetry}>
                        {t.chat.runRetry}
                      </Button>
                    ))}
                  >
                    <div className="flex flex-col gap-1">
                      <span>
                        {isOversizeFailure && t.chat.payloadTooLarge}
                        {!isOversizeFailure && message.runState === 'failed' && t.chat.runFailed}
                        {!isOversizeFailure && message.runState === 'connection-failed' && t.chat.runConnectionFailed}
                      </span>
                      {showFailureReason && message.runError && (
                        <p className="break-words text-ui-sm text-label-secondary">
                          {message.runError}
                        </p>
                      )}
                      {message.runErrorDetails && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 font-code text-caption text-label-secondary">
                          <span>HTTP {message.runErrorDetails.status}</span>
                          {message.runErrorDetails.error_type && (
                            <span className="break-all">
                              error_type: <span>{message.runErrorDetails.error_type}</span>
                            </span>
                          )}
                          {message.runErrorDetails.traceId && (
                            <span className="break-all">
                              traceId: <span>{message.runErrorDetails.traceId}</span>
                            </span>
                          )}
                        </div>
                      )}
                      {message.runErrorDetails?.summary && (
                        <p className="break-words text-ui-sm text-label-secondary">
                          {message.runErrorDetails.summary}
                        </p>
                      )}
                    </div>
                  </InlineMessage>
                </div>
              )}
              {/* Actions + timestamp row below bubble */}
              <div className="flex items-center gap-2">
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
          <div className="break-words text-label select-text">
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
        {message.isStreaming && <span aria-hidden="true" className="ml-1 inline-block h-4 w-0.5 bg-label-secondary align-text-bottom" />}

        {/* 只显示输出：这条消息上的数字来自旧口径，用量页读的是新账本，
            同屏显示两个输入数会对不上（任务书 U08）。输出两边含义一致。 */}
        {message.usage && !message.isStreaming && message.usage.outputTokens != null && (
          <div className="mt-2 text-caption text-label-tertiary">
            {`${t.chat.outputTokens}: ${message.usage.outputTokens.toLocaleString()}`}
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
          <div className="break-words text-label select-text">
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
        {message.isStreaming && <span aria-hidden="true" className="ml-1 inline-block h-4 w-0.5 bg-label-secondary align-text-bottom" />}

        {/* 只显示输出：这条消息上的数字来自旧口径，用量页读的是新账本，
            同屏显示两个输入数会对不上（任务书 U08）。输出两边含义一致。 */}
        {message.usage && !message.isStreaming && message.usage.outputTokens != null && (
          <div className="mt-2 text-caption text-label-tertiary">
            {`${t.chat.outputTokens}: ${message.usage.outputTokens.toLocaleString()}`}
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
