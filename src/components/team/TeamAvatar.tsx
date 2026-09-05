import { UsersRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AvatarSize } from '@/components/common/AgentAvatar';

const BOX: Record<AvatarSize, string> = { xs: 'h-4 w-4', sm: 'h-5 w-5', md: 'h-7 w-7', lg: 'h-8 w-8' };
const ICON: Record<AvatarSize, string> = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-[18px] w-[18px]' };
const EMOJI: Record<AvatarSize, string> = { xs: 'text-caption', sm: 'text-minor', md: 'text-body', lg: 'text-body' };

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
