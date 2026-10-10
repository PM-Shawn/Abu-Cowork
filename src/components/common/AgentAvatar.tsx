import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { cn } from '@/lib/utils';
import abuAvatar from '@/assets/abu-avatar.png';
import { AVATAR_ICON_MAP, AVATAR_TINT_MAP, parseAvatarValue } from '@/core/team/avatarPresets';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

// eslint-disable-next-line react-refresh/only-export-components
export const AVATAR_SIZE = {
  // `xl` / `2xl` fill the grey slots the avatar sits inside: the 40px ToolCard
  // slot and the 56px ToolDetailModal header slot. Their emoji sizes are the
  // slot's own font size (`text-title` / `text-title-lg`), so a legacy emoji
  // avatar has the size the slot gives one it renders itself.
  box: { xs: 'size-4', sm: 'size-5', md: 'size-7', lg: 'size-8', xl: 'size-10', '2xl': 'size-14' },
  // The design-system icon has three sizes (14 / 16 / 20px).
  icon: { xs: 'sm', sm: 'sm', md: 'md', lg: 'md', xl: 'md', '2xl': 'lg' },
  emoji: { xs: 'text-caption', sm: 'text-ui-sm', md: 'text-ui', lg: 'text-ui', xl: 'text-title', '2xl': 'text-title-lg' },
} as const satisfies Record<'box' | 'icon' | 'emoji', Record<AvatarSize, string>>;
const BOX = AVATAR_SIZE.box;
const ICON = AVATAR_SIZE.icon;
const EMOJI = AVATAR_SIZE.emoji;

/** The corner radius that lets an avatar fill its slot without leaving grey
 *  corners showing: the 56px detail header slot is `rounded-panel`, every other
 *  slot `rounded-control`. */
// eslint-disable-next-line react-refresh/only-export-components
export function avatarRadius(size: AvatarSize): string {
  return size === '2xl' ? 'rounded-panel' : 'rounded-control';
}

/** Any avatar an expert carries is rendered, whatever its source: the built-in
 *  and marketplace presets ship their own `icon:<icon>/<tint>` references now
 *  (user ruling 2026-09-13, replacing the 2026-09-05 "builtin / marketplace
 *  presets keep the uniform robot mark"). One rule — a valid value renders,
 *  nothing renders the default mark — so the source no longer changes what is
 *  drawn, matching TeamAvatar and WelcomeAvatar. */
export interface AvatarAgentLike {
  name: string;
  avatar?: string;
  filePath?: string;
}

/** The avatar value to render for an agent: trimmed, or null when it has none.
 *  Normalizes — it does not filter. The source of the agent is deliberately not
 *  an input. @see AvatarAgentLike */
// eslint-disable-next-line react-refresh/only-export-components
export function agentAvatarValue(agent: Pick<AvatarAgentLike, 'avatar' | 'filePath'> | null | undefined): string | null {
  return agent?.avatar?.trim() || null;
}

/**
 * One avatar for an agent everywhere (队员 cards, team dialog, chat rows, team
 * tab, member bar): Abu's mascot for abu, otherwise whatever avatar the expert
 * carries — a preset icon or a legacy emoji — and the robot mark when it has
 * none.
 */
export default function AgentAvatar({ agent, size = 'md', round = false, className }: {
  agent: AvatarAgentLike;
  size?: AvatarSize;
  round?: boolean;
  className?: string;
}) {
  const shape = round ? 'rounded-full' : avatarRadius(size);
  if (agent.name === 'abu') {
    return <img src={abuAvatar} alt="Abu" className={cn(BOX[size], shape, 'object-cover shrink-0', className)} />;
  }
  const parsed = parseAvatarValue(agentAvatarValue(agent) ?? undefined);
  const avatarIcon = parsed.kind === 'icon' ? AVATAR_ICON_MAP[parsed.icon] : AppIcons.agent;
  // The tint is the expert's identity colour (data, like the brand mark), not a status colour.
  const tint = parsed.kind === 'icon' ? AVATAR_TINT_MAP[parsed.tint] : undefined;
  return (
    <span
      aria-hidden="true"
      data-testid="agent-avatar"
      data-avatar-kind={parsed.kind}
      style={tint ? { backgroundColor: tint.bg, color: tint.fg } : undefined}
      className={cn(BOX[size], shape, 'inline-flex shrink-0 select-none items-center justify-center bg-fill leading-none', className)}
    >
      {parsed.kind === 'emoji' ? <span className={EMOJI[size]}>{parsed.emoji}</span> : <Icon icon={avatarIcon} size={ICON[size]} className={tint ? undefined : 'text-label-tertiary'} />}
    </span>
  );
}
