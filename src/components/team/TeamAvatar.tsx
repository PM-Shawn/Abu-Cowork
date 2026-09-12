import { UsersRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AVATAR_SIZE, type AvatarSize } from '@/components/common/AgentAvatar';
import { AVATAR_ICON_MAP, AVATAR_TINT_MAP, parseAvatarValue } from '@/core/team/avatarPresets';

const BOX = AVATAR_SIZE.box;
const ICON = AVATAR_SIZE.icon;
const EMOJI = AVATAR_SIZE.emoji;

/** One avatar for a team everywhere: a built-in icon, legacy emoji, or group mark. */
export default function TeamAvatar({ avatar, size = 'md', round = false, className }: {
  avatar?: string | null;
  size?: AvatarSize;
  round?: boolean;
  className?: string;
}) {
  const parsed = parseAvatarValue(avatar ?? undefined);
  const AvatarIcon = parsed.kind === 'icon' ? AVATAR_ICON_MAP[parsed.icon] : UsersRound;
  const tint = parsed.kind === 'icon' ? AVATAR_TINT_MAP[parsed.tint] : undefined;
  return (
    <span
      aria-hidden="true"
      data-testid="team-avatar"
      data-avatar-kind={parsed.kind}
      style={tint ? { backgroundColor: tint.bg, color: tint.fg } : undefined}
      className={cn(BOX[size], round ? 'rounded-full' : 'rounded-lg', 'inline-flex shrink-0 items-center justify-center bg-[var(--abu-bg-muted)] leading-none select-none', className)}
    >
      {parsed.kind === 'emoji' ? <span className={EMOJI[size]}>{parsed.emoji}</span> : <AvatarIcon className={cn(ICON[size], !tint && 'text-[var(--abu-text-tertiary)]')} strokeWidth={1.75} />}
    </span>
  );
}
