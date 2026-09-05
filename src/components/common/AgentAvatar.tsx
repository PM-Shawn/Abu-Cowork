import { Bot } from 'lucide-react';
import { cn } from '@/lib/utils';
import abuAvatar from '@/assets/abu-avatar.png';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const BOX: Record<AvatarSize, string> = { xs: 'h-4 w-4', sm: 'h-5 w-5', md: 'h-7 w-7', lg: 'h-8 w-8' };
const ICON: Record<AvatarSize, string> = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-[18px] w-[18px]' };
const EMOJI: Record<AvatarSize, string> = { xs: 'text-caption', sm: 'text-minor', md: 'text-body', lg: 'text-body' };

/** Only an avatar the user set on their own agent counts; builtin / marketplace
 *  presets keep the uniform robot mark (user decision 2026-09-05: "都先保持系统默认"). */
export interface AvatarAgentLike {
  name: string;
  avatar?: string;
  filePath?: string;
}

// eslint-disable-next-line react-refresh/only-export-components
export function userAgentAvatar(agent: Pick<AvatarAgentLike, 'avatar' | 'filePath'> | null | undefined): string | null {
  if (!agent) return null;
  const emoji = agent.avatar?.trim();
  if (!emoji || agent.filePath === '__builtin__') return null;
  return emoji;
}

/**
 * One avatar for an agent everywhere (队员 cards, team dialog, chat rows, team
 * tab, member bar): Abu's mascot for abu, the user's emoji for their own
 * agents, otherwise the uniform robot mark.
 */
export default function AgentAvatar({ agent, size = 'md', round = false, className }: {
  agent: AvatarAgentLike;
  size?: AvatarSize;
  round?: boolean;
  className?: string;
}) {
  const shape = round ? 'rounded-full' : 'rounded-lg';
  if (agent.name === 'abu') {
    return <img src={abuAvatar} alt="Abu" className={cn(BOX[size], shape, 'object-cover shrink-0', className)} />;
  }
  const emoji = userAgentAvatar(agent);
  return (
    <span
      aria-hidden="true"
      data-testid="agent-avatar"
      data-avatar-kind={emoji ? 'emoji' : 'default'}
      className={cn(BOX[size], shape, 'inline-flex shrink-0 items-center justify-center bg-[var(--abu-bg-muted)] leading-none select-none', className)}
    >
      {emoji ? <span className={EMOJI[size]}>{emoji}</span> : <Bot className={cn(ICON[size], 'text-[var(--abu-text-muted)]')} strokeWidth={1.75} />}
    </span>
  );
}
