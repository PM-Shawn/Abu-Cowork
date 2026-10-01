/**
 * IMInfoBar — Shows IM channel context at the top of IM conversations
 *
 * Layout: [platform icon] ConversationTitle  [rounds badge]  ...  [⋯ menu]
 * Menu: capability, start time, rounds, chat name, end session
 */

import { memo, type ReactNode } from 'react';
import { IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons, type AppIconName } from '@/components/ds/icons';
import { Menu, MenuItem, MenuSeparator } from '@/components/ds/menu';
import { Tag } from '@/components/ds/tag';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Conversation } from '@/types';
import type { IMCapabilityLevel } from '@/types/imChannel';
import { getPlatformShortLabel, getPlatformDisplayName } from '@/core/im/platformLabels';

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
  const platformLabel = getPlatformDisplayName(platform);

  // Title: same as sidebar (conversation.title), fallback to platform label
  const title = conversation.title || platformLabel;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-separator px-6 py-1 text-ui md:px-10">
      {/* Platform icon + title */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-control bg-fill text-caption font-medium text-label-secondary">
          {getPlatformShortLabel(platform)}
        </span>
        <span className="truncate font-medium text-label">{title}</span>
        <span className="text-label-placeholder">·</span>
        <span className="shrink-0 text-label-tertiary">{platformLabel}</span>
      </div>

      {/* Rounds badge */}
      <span className="flex shrink-0">
        <Tag>{rounds} {t.imChannel.infoBarRounds}</Tag>
      </span>

      {/* Spacer */}
      <div className="flex-1" />

      <IMInfoMenu
        capabilityLabel={capabilityLabels[capability]}
        startTime={startTime}
        rounds={rounds}
        chatName={chatName}
        sessionKey={session?.key}
      />
    </div>
  );
}

// The bar's conversation prop changes on every streamed token; the menu only takes
// the values it shows, so it re-renders when one of them changes.
const IMInfoMenu = memo(function IMInfoMenu({ capabilityLabel, startTime, rounds, chatName, sessionKey }: {
  capabilityLabel: string;
  startTime: number;
  rounds: number;
  chatName?: string;
  sessionKey?: string;
}) {
  const { t } = useI18n();

  const handleEndSession = () => {
    if (!sessionKey || !confirm(t.imChannel.infoBarEndConfirm)) return;
    useIMChannelStore.getState().removeSession(sessionKey);
  };

  return (
    <Menu align="end" trigger={<IconButton size="sm" icon={AppIcons.more} label={t.sidebar.moreActions} />}>
      <div className="w-60">
        <InfoRow icon="capability" label={t.imChannel.infoBarCapability} value={capabilityLabel} />
        <InfoRow icon="clock" label={t.imChannel.infoBarStarted} value={formatTime(startTime)} />
        <InfoRow icon="conversation" label={t.imChannel.infoBarRounds} value={rounds} />
        {chatName && <InfoRow icon="channel" label={t.imChannel.infoBarGroup} value={chatName} truncate />}
        {sessionKey && (
          <>
            <MenuSeparator />
            <MenuItem tone="danger" icon={AppIcons.error} onSelect={handleEndSession}>
              {t.imChannel.infoBarEndSession}
            </MenuItem>
          </>
        )}
      </div>
    </Menu>
  );
});

function InfoRow({ icon, label, value, truncate = false }: { icon: AppIconName; label: string; value: ReactNode; truncate?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-ui">
      <Icon icon={AppIcons[icon]} size="sm" className="text-label-tertiary" />
      <span className="shrink-0 text-label-secondary">{label}</span>
      <span className={cn('ml-auto min-w-0 text-right text-label', truncate && 'max-w-30 truncate')}>{value}</span>
    </div>
  );
}
