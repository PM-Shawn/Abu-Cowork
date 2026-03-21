import { ChevronDown, ChevronRight, Copy, Pencil, Trash2, RefreshCw, Check, Brain, Wand2, AtSign, FileText, FolderOpen, ImageOff } from 'lucide-react';
import { useState, useEffect } from 'react';
import type { Message, MessageContent } from '@/types';
import MarkdownRenderer from './MarkdownRenderer';
import ToolCallsGroup from './ToolCallsGroup';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { runAgentLoop } from '@/core/agent/agentLoop';
import { useI18n } from '@/i18n';
import { getBaseName, loadLocalImage } from '@/utils/pathUtils';
import abuAvatar from '@/assets/abu-avatar.png';

// Regex to match [Attachment: `path`] patterns in user messages
const ATTACHMENT_PATTERN = /\[Attachment:\s*`([^`]+)`\]/g;

/** Extract attachment paths and clean text from user message content */
function extractAttachments(text: string): { cleanText: string; attachmentPaths: string[] } {
  const paths: string[] = [];
  const cleanText = text.replace(ATTACHMENT_PATTERN, (_, path) => {
    paths.push(path);
    return '';
  }).trim();
  return { cleanText, attachmentPaths: paths };
}

/** Image thumbnail that loads from base64 data or disk filePath */
function UserImageThumbnail({ image }: { image: Extract<MessageContent, { type: 'image' }> }) {
  const { t } = useI18n();
  const openPreview = usePreviewStore.getState().openPreview;
  const hasData = !!image.source.data;
  const [diskSrc, setDiskSrc] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (hasData || !image.filePath) return;
    let revoke: string | null = null;
    loadLocalImage(image.filePath)
      .then((url) => { revoke = url; setDiskSrc(url); })
      .catch(() => setExpired(true));
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [hasData, image.filePath]);

  const src = hasData
    ? `data:${image.source.media_type};base64,${image.source.data}`
    : diskSrc;

  if (expired) {
    return (
      <div
        className="w-8 h-8 rounded overflow-hidden border border-[#e5e2db] flex items-center justify-center bg-[#f5f3ee]"
        title={t.chat.imageExpired}
      >
        <ImageOff className="w-4 h-4 text-[#9a9689]" />
      </div>
    );
  }

  if (!src) {
    return (
      <div className="w-8 h-8 rounded overflow-hidden border border-[#e5e2db] bg-[#f5f3ee] animate-pulse" />
    );
  }

  return (
    <div
      className="w-8 h-8 rounded overflow-hidden border border-[#e5e2db] cursor-pointer hover:shadow-md transition-shadow"
      onClick={() => openPreview(image.filePath || src)}
      title={t.chat.clickToViewFull}
    >
      <img src={src} alt="" className="w-full h-full object-cover" />
    </div>
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
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#f5f3ee] border border-[#e5e2db] hover:border-[#d97757]/40 cursor-pointer transition-all text-[13px] group/chip"
      title={filePath}
      onClick={handleClick}
    >
      <FileText className="w-3.5 h-3.5 text-[#888579] shrink-0" />
      <span className="text-[#29261b] truncate max-w-[200px]">{fileName}</span>
      <button
        onClick={handleReveal}
        className="p-0.5 rounded hover:bg-[#e5e2db] opacity-0 group-hover/chip:opacity-100 transition-opacity shrink-0"
      >
        <FolderOpen className="w-3 h-3 text-[#888579]" />
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

// Thinking block component for extended thinking
function ThinkingBlock({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();

  return (
    <div className="my-3 rounded-xl overflow-hidden border border-[#706b5730] bg-[#f5f3ee] max-w-full">
      <button
        onClick={() => setExpanded(!expanded)}
        className="btn-ghost w-full flex items-center gap-2 px-3.5 py-2.5 text-sm hover:bg-[#e8e5de]"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-[#656358] shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-[#656358] shrink-0" />
        )}
        <Brain className="h-3.5 w-3.5 text-purple-500 shrink-0" />
        <span className="text-[13px] font-medium text-[#29261b]">{t.chat.thinkingProcess}</span>
      </button>
      {expanded && (
        <div className="border-t border-[#706b5730] px-4 py-3">
          <pre className="text-[12px] text-[#656358] whitespace-pre-wrap break-words leading-relaxed">
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
  onDelete: () => void;
  onRegenerate: () => void;
  isUser: boolean;
}

function MessageActions({ message, onEdit, onDelete, onRegenerate, isUser }: MessageActionsProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

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
        className="btn-ghost p-1.5 rounded-md text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de]"
        title={t.chat.copy}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>

      {/* Edit button - only for user messages */}
      {isUser && (
        <button
          onClick={onEdit}
          className="btn-ghost p-1.5 rounded-md text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de]"
          title={t.chat.edit}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Regenerate button - only for assistant messages */}
      {!isUser && (
        <button
          onClick={onRegenerate}
          className="btn-ghost p-1.5 rounded-md text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de]"
          title={t.chat.regenerate}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      )}

      {/* Delete button */}
      <button
        onClick={onDelete}
        className="btn-ghost p-1.5 rounded-md text-[#656358] hover:text-red-500 hover:bg-red-50"
        title={t.common.delete}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// Edit input for user messages — card style
function EditInput({
  initialContent,
  onSave,
  onCancel
}: {
  initialContent: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialContent);
  const { t } = useI18n();

  return (
    <div className="min-w-[280px] rounded-2xl border border-[#e5e2db] bg-white shadow-sm overflow-hidden">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full min-h-[80px] px-4 py-3 bg-[#faf9f7] text-[14px] text-[#29261b] resize-none focus:outline-none border-none"
        autoFocus
      />
      <div className="flex items-center justify-end gap-3 px-4 py-2.5 border-t border-[#e5e2db]">
        <button
          onClick={onCancel}
          className="btn-ghost text-[13px] text-[#656358] hover:text-[#29261b] transition-colors"
        >
          {t.common.cancel}
        </button>
        <button
          onClick={() => onSave(text)}
          className="btn-ghost flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[13px] bg-[#d97757] text-white hover:bg-[#c86a4d] transition-colors"
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
  const activeConv = useActiveConversation();
  const isConvRunning = activeConv?.status === 'running';

  const textContent = getTextContent(message.content);
  const imageBlocks = getImageBlocks(message.content);
  const convId = activeConv?.id;

  const handleEdit = () => {
    setIsEditing(true);
  };

  const handleSaveEdit = async (newContent: string) => {
    if (!convId) return;
    // Preserve image blocks from original message content
    const originalImages = getImageBlocks(message.content);
    setIsEditing(false);
    // Delete this message and all subsequent messages, then runAgentLoop creates a fresh one
    useChatStore.getState().deleteMessagesFrom(convId, message.id);
    // Regenerate response, passing original images if any
    const imageAttachments = originalImages.map((img, i) => ({
      id: `edit-${Date.now()}-${i}`,
      data: img.source.data,
      mediaType: img.source.media_type,
    }));
    await runAgentLoop(convId, newContent, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);
  };

  const handleDelete = () => {
    if (!convId || !activeConv) return;
    if (isUser && message.loopId) {
      // For user messages, delete user + all assistant messages in this loop
      useChatStore.getState().deleteLoopMessages(convId, message.loopId);
    } else if (!isUser && message.loopId) {
      // For assistant messages, only delete assistant messages in this loop (keep user message)
      const assistantIdsInLoop = activeConv.messages
        .filter((m) => m.loopId === message.loopId && m.role === 'assistant')
        .map((m) => m.id);
      for (const id of assistantIdsInLoop) {
        useChatStore.getState().deleteMessage(convId, id);
      }
    } else {
      // No loopId, just delete this one message
      useChatStore.getState().deleteMessage(convId, message.id);
    }
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
      // Delete from user message onwards and regenerate
      useChatStore.getState().deleteMessagesFrom(convId, userMsgToRegenerate.id);
      const userContent = getTextContent(userMsgToRegenerate.content);
      // Preserve image blocks from original user message
      const originalImages = getImageBlocks(userMsgToRegenerate.content);
      const imageAttachments = originalImages.map((img, i) => ({
        id: `regen-${Date.now()}-${i}`,
        data: img.source.data,
        mediaType: img.source.media_type,
      }));
      await runAgentLoop(convId, userContent, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);
    }
  };

  // Actions only mode - just render the action buttons
  if (actionsOnly && !isUser) {
    return (
      <MessageActions
        message={message}
        onEdit={() => {}}
        onDelete={handleDelete}
        onRegenerate={handleRegenerate}
        isUser={false}
      />
    );
  }

  if (isUser) {
    // Extract file attachments from user message text
    const { cleanText: userCleanText, attachmentPaths } = extractAttachments(textContent);
    return (
      <div className="flex justify-end w-full group">
        <div className="flex flex-col items-end gap-1.5 max-w-[85%]">
          {/* Image thumbnails — above the text bubble */}
          {imageBlocks.length > 0 && !isEditing && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {imageBlocks.map((img, idx) => (
                <UserImageThumbnail key={idx} image={img} />
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
            <div className="flex items-center justify-end gap-1 text-[#9a9689]">
              <AtSign className="h-3 w-3" />
              <span className="text-[11px] font-medium">{message.delegateAgent.name}</span>
            </div>
          )}
          {isEditing ? (
            <EditInput
              initialContent={textContent}
              onSave={handleSaveEdit}
              onCancel={() => setIsEditing(false)}
            />
          ) : (
            <div className="flex items-start gap-2">
              {/* Actions - show on hover */}
              {!isConvRunning && (
                <MessageActions
                  message={message}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onRegenerate={handleRegenerate}
                  isUser={true}
                />
              )}
              {/* Hide bubble when there's no text and no skill badge (pure image message) */}
              {(userCleanText || message.skill) && (
                <div className="px-4 py-2.5 rounded-2xl rounded-br-sm bg-[#d97757] text-white shadow-sm">
                  {/* Skill badge inside bubble */}
                  {message.skill && (
                    <div className="flex items-center gap-1.5 mb-1.5 opacity-90">
                      <Wand2 className="h-3 w-3" />
                      <span className="text-[11px] font-medium">/{message.skill.name}</span>
                    </div>
                  )}
                  {userCleanText && (
                    <div className="text-[14.5px] leading-relaxed break-words">
                      <MarkdownRenderer content={userCleanText} variant="user" />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Assistant message - when hideAvatar is true, render content only (used in MessageGroup)
  if (hideAvatar) {
    return (
      <div className="assistant-turn">
        {/* Thinking block if present */}
        {message.thinking && <ThinkingBlock thinking={message.thinking} />}

        {textContent && (
          <div className="text-[#29261b] break-words">
            <MarkdownRenderer content={textContent} />
          </div>
        )}
        {/* Tool calls - grouped in a single collapsible block */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsGroup toolCalls={message.toolCalls} />
        )}
        {message.isStreaming && <span className="streaming-cursor" />}

        {/* Token usage display */}
        {message.usage && !message.isStreaming && (
          <div className="mt-2 text-[11px] text-[#656358]/70">
            {message.usage.inputTokens != null && `${t.chat.inputTokens}: ${message.usage.inputTokens.toLocaleString()}`}
            {message.usage.outputTokens != null && ` · ${t.chat.outputTokens}: ${message.usage.outputTokens.toLocaleString()}`}
          </div>
        )}

        {/* Actions - show on hover when not streaming */}
        {!message.isStreaming && !isConvRunning && (
          <div className="mt-2">
            <MessageActions
              message={message}
              onEdit={() => {}}
              onDelete={handleDelete}
              onRegenerate={handleRegenerate}
              isUser={false}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex gap-3 w-full overflow-hidden group">
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
          <div className="text-[#29261b] break-words">
            <MarkdownRenderer content={textContent} />
          </div>
        )}
        {/* Tool calls - grouped in a single collapsible block */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <ToolCallsGroup toolCalls={message.toolCalls} />
        )}
        {message.isStreaming && <span className="streaming-cursor" />}

        {/* Token usage display */}
        {message.usage && !message.isStreaming && (
          <div className="mt-2 text-[11px] text-[#656358]/70">
            {message.usage.inputTokens != null && `${t.chat.inputTokens}: ${message.usage.inputTokens.toLocaleString()}`}
            {message.usage.outputTokens != null && ` · ${t.chat.outputTokens}: ${message.usage.outputTokens.toLocaleString()}`}
          </div>
        )}

        {/* Actions - show on hover when not streaming */}
        {!message.isStreaming && !isConvRunning && (
          <div className="mt-2">
            <MessageActions
              message={message}
              onEdit={() => {}}
              onDelete={handleDelete}
              onRegenerate={handleRegenerate}
              isUser={false}
            />
          </div>
        )}
      </div>
    </div>
  );
}
