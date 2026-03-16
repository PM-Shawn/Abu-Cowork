/**
 * IMInfoBar — Shows IM channel context at the top of IM conversations
 *
 * Layout: [platform icon] ConversationTitle  [rounds badge]  ...  [⋯ menu]
 * Menu: capability, start time, rounds, chat name, end session
 */

import { useState, useRef, useEffect } from 'react';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useI18n } from '@/i18n';
import type { Conversation } from '@/types';
import type { IMCapabilityLevel } from '@/types/imChannel';
import { MoreHorizontal, Clock, MessageSquare, Shield, Hash, XCircle } from 'lucide-react';

const PLATFORM_SHORT: Record<string, string> = {
  feishu: '飞',
  dchat: 'DC',
  dingtalk: '钉',
  wecom: '微',
  slack: 'SL',
};

const PLATFORM_LABELS: Record<string, string> = {
  feishu: '飞书',
  dchat: 'D-Chat',
  dingtalk: '钉钉',
  wecom: '企微',
  slack: 'Slack',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

interface IMInfoBarProps {
  conversation: Conversation;
}

export default function IMInfoBar({ conversation }: IMInfoBarProps) {
  const { t } = useI18n();
  const platform = conversation.imPlatform ?? '';
  const channelId = conversation.imChannelId;
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showMenu]);

  // Get session info from store
  const sessions = useIMChannelStore((s) => s.sessions);
  const session = Object.values(sessions).find((s) => s.conversationId === conversation.id);

  // Get channel info
  const channel = useIMChannelStore((s) => channelId ? s.channels[channelId] : null);

  const capabilityLabels: Record<IMCapabilityLevel, string> = {
    chat_only: t.imChannel.capabilityChatOnly,
    read_tools: t.imChannel.capabilityReadTools,
    safe_tools: t.imChannel.capabilitySafeTools,
    full: t.imChannel.capabilityFull,
  };

  const capability = session?.capability ?? channel?.capability ?? 'safe_tools';
  const rounds = session?.messageCount ?? conversation.messages.filter((m) => m.role === 'user').length;
  const startTime = conversation.createdAt;
  const chatName = session?.chatName;
  const platformLabel = PLATFORM_LABELS[platform] ?? platform;

  // Title: same as sidebar (conversation.title), fallback to platform label
  const title = conversation.title || platformLabel;

  const handleEndSession = () => {
    if (!session || !confirm(t.imChannel.infoBarEndConfirm)) return;
    useIMChannelStore.getState().removeSession(session.key);
    setShowMenu(false);
  };

  return (
    <div className="shrink-0 flex items-center gap-2 px-6 md:px-10 py-1.5 bg-white/60 border-b border-[#e8e6df] text-[13px]">
      {/* Platform icon + title */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="shrink-0 h-4 w-4 rounded text-[8px] font-bold leading-4 text-center bg-[#d97757]/15 text-[#d97757]">
          {PLATFORM_SHORT[platform] ?? platform.slice(0, 2).toUpperCase()}
        </span>
        <span className="font-medium text-[#29261b] truncate">{title}</span>
        <span className="text-[#d5d3cb]">·</span>
        <span className="text-[#656358] shrink-0">{platformLabel}</span>
      </div>

      {/* Rounds badge */}
      <span className="shrink-0 px-1.5 py-0.5 rounded bg-[#f5f4f0] text-[11px] text-[#656358]">
        {rounds} {t.imChannel.infoBarRounds}
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Three-dot menu */}
      <div className="relative shrink-0" ref={menuRef}>
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex items-center justify-center w-6 h-6 rounded text-[#656358] hover:bg-[#f0efe8] transition-colors"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>

        {showMenu && (
          <div className="absolute top-full right-0 mt-1 w-60 bg-white rounded-lg shadow-lg border border-[#e8e6df] py-1.5 z-50">
            {/* Capability */}
            <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              <Shield className="h-3.5 w-3.5 text-[#9e9b8e] shrink-0" />
              <span className="text-[#9e9b8e] shrink-0">{t.imChannel.infoBarCapability}</span>
              <span className="text-[#29261b] ml-auto text-right">{capabilityLabels[capability]}</span>
            </div>

            {/* Start time */}
            <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              <Clock className="h-3.5 w-3.5 text-[#9e9b8e] shrink-0" />
              <span className="text-[#9e9b8e]">{t.imChannel.infoBarStarted}</span>
              <span className="text-[#29261b] ml-auto">{formatTime(startTime)}</span>
            </div>

            {/* Rounds */}
            <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              <MessageSquare className="h-3.5 w-3.5 text-[#9e9b8e] shrink-0" />
              <span className="text-[#9e9b8e]">{t.imChannel.infoBarRounds}</span>
              <span className="text-[#29261b] ml-auto">{rounds}</span>
            </div>

            {/* Chat name (if group) */}
            {chatName && (
              <div className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                <Hash className="h-3.5 w-3.5 text-[#9e9b8e] shrink-0" />
                <span className="text-[#9e9b8e] shrink-0">群组</span>
                <span className="text-[#29261b] ml-auto truncate max-w-[120px]">{chatName}</span>
              </div>
            )}

            {/* Divider + End session */}
            {session && (
              <>
                <div className="my-1 border-t border-[#e8e6df]" />
                <button
                  onClick={handleEndSession}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-[#e53935] hover:bg-red-50 transition-colors"
                >
                  <XCircle className="h-3.5 w-3.5 shrink-0" />
                  {t.imChannel.infoBarEndSession}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
