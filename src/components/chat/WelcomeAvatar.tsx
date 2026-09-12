import { AVATAR_ICON_MAP, AVATAR_TINT_MAP, parseAvatarValue } from '@/core/team/avatarPresets';

/**
 * The expert welcome page's 80px circle. A built-in icon reference
 * (`icon:<icon>/<tint>`, what the picker and Abu itself now write) renders as
 * that icon in its tint; a builtin expert's emoji keeps rendering exactly as
 * before; anything else falls back to the robot mark. Deliberately NOT
 * AgentAvatar: that one drops a builtin agent's emoji by design.
 */
export default function WelcomeAvatar({ avatar }: { avatar?: string }) {
  const parsed = parseAvatarValue(avatar);
  if (parsed.kind === 'icon') {
    const AvatarIcon = AVATAR_ICON_MAP[parsed.icon];
    const tint = AVATAR_TINT_MAP[parsed.tint];
    return (
      <div
        data-testid="welcome-avatar"
        data-avatar-kind="icon"
        style={{ backgroundColor: tint.bg, color: tint.fg }}
        className="w-20 h-20 mx-auto mb-4 rounded-full flex items-center justify-center select-none"
      >
        <AvatarIcon className="h-10 w-10" strokeWidth={1.75} aria-hidden="true" />
      </div>
    );
  }
  return (
    <div
      data-testid="welcome-avatar"
      data-avatar-kind={parsed.kind}
      className="w-20 h-20 mx-auto mb-4 rounded-full bg-[var(--abu-bg-active)] flex items-center justify-center text-5xl select-none"
    >
      {parsed.kind === 'emoji' ? parsed.emoji : '🤖'}
    </div>
  );
}
