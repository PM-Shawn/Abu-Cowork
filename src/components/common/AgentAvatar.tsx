import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import abuAvatar from '@/assets/abu-avatar.png';
import { AVATAR_ICON_MAP, AVATAR_TINT_MAP, parseAvatarValue } from '@/core/team/avatarPresets';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

// eslint-disable-next-line react-refresh/only-export-components
export const AVATAR_SIZE = {
  // `xl` / `2xl` fill the grey slots the avatar used to sit inside: the 40px
  // ToolCard slot and the 56px ToolDetailModal header slot. Their emoji sizes
  // are the slot's own font size (`text-h-md` / `text-h-xl`), so a legacy emoji
  // avatar keeps the size it had when the slot rendered it.
  box: { xs: 'h-4 w-4', sm: 'h-5 w-5', md: 'h-7 w-7', lg: 'h-8 w-8', xl: 'h-10 w-10', '2xl': 'h-14 w-14' },
  icon: { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-[18px] w-[18px]', xl: 'h-5 w-5', '2xl': 'h-6 w-6' },
  emoji: { xs: 'text-caption', sm: 'text-minor', md: 'text-body', lg: 'text-body', xl: 'text-h-md', '2xl': 'text-h-xl' },
} as const satisfies Record<'box' | 'icon' | 'emoji', Record<AvatarSize, string>>;
const BOX = AVATAR_SIZE.box;
const ICON = AVATAR_SIZE.icon;
const EMOJI = AVATAR_SIZE.emoji;

/** The corner radius that lets an avatar fill its slot without leaving grey
 *  corners showing: the 56px detail header slot is `rounded-2xl`, every other
 *  slot `rounded-lg`. */
// eslint-disable-next-line react-refresh/only-export-components
export function avatarRadius(size: AvatarSize): string {
  return size === '2xl' ? 'rounded-2xl' : 'rounded-lg';
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
  const AvatarIcon = parsed.kind === 'icon' ? AVATAR_ICON_MAP[parsed.icon] : Bot;
  const tint = parsed.kind === 'icon' ? AVATAR_TINT_MAP[parsed.tint] : undefined;
  return (
    <span
      aria-hidden="true"
      data-testid="agent-avatar"
      data-avatar-kind={parsed.kind}
      style={tint ? { backgroundColor: tint.bg, color: tint.fg } : undefined}
      className={cn(BOX[size], shape, 'inline-flex shrink-0 items-center justify-center bg-[var(--abu-bg-muted)] leading-none select-none', className)}
    >
      {parsed.kind === 'emoji' ? <span className={EMOJI[size]}>{parsed.emoji}</span> : <AvatarIcon className={cn(ICON[size], !tint && 'text-[var(--abu-text-muted)]')} strokeWidth={1.75} />}
    </span>
  );
}
