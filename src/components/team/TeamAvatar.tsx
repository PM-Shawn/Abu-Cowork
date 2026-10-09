import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { cn } from '@/lib/utils';
import { AVATAR_SIZE, avatarRadius, type AvatarSize } from '@/components/common/AgentAvatar';
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
  const avatarIcon = parsed.kind === 'icon' ? AVATAR_ICON_MAP[parsed.icon] : AppIcons.team;
  // The tint is the team's identity colour (data, like the brand mark), not a status colour.
  const tint = parsed.kind === 'icon' ? AVATAR_TINT_MAP[parsed.tint] : undefined;
  return (
    <span
      aria-hidden="true"
      data-testid="team-avatar"
      data-avatar-kind={parsed.kind}
      style={tint ? { backgroundColor: tint.bg, color: tint.fg } : undefined}
      className={cn(BOX[size], round ? 'rounded-full' : avatarRadius(size), 'inline-flex shrink-0 select-none items-center justify-center bg-fill leading-none', className)}
    >
      {parsed.kind === 'emoji' ? <span className={EMOJI[size]}>{parsed.emoji}</span> : <Icon icon={avatarIcon} size={ICON[size]} className={tint ? undefined : 'text-label-tertiary'} />}
    </span>
  );
}
