import { UsersRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AVATAR_SIZE, type AvatarSize } from '@/components/common/AgentAvatar';

const BOX = AVATAR_SIZE.box;
const ICON = AVATAR_SIZE.icon;
const EMOJI = AVATAR_SIZE.emoji;

/** One avatar for a team everywhere: the user's emoji when set, else the group mark. */
export default function TeamAvatar({ avatar, size = 'md', round = false, className }: {
  avatar?: string | null;
  size?: AvatarSize;
  round?: boolean;
  className?: string;
}) {
  const emoji = avatar?.trim() || null;
  return (
    <span
      aria-hidden="true"
      data-testid="team-avatar"
      data-avatar-kind={emoji ? 'emoji' : 'default'}
      className={cn(BOX[size], round ? 'rounded-full' : 'rounded-lg', 'inline-flex shrink-0 items-center justify-center bg-[var(--abu-bg-muted)] leading-none select-none', className)}
    >
      {emoji ? <span className={EMOJI[size]}>{emoji}</span> : <UsersRound className={cn(ICON[size], 'text-[var(--abu-text-tertiary)]')} strokeWidth={1.75} />}
    </span>
  );
}
