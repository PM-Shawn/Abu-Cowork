import { AVATAR_ICONS, AVATAR_TINTS, buildAvatarValue, parseAvatarValue } from '@/core/team/avatarPresets';
import AgentAvatar from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';

/** Shared by agent and team editors; only built-in references are newly authored. */
export default function AvatarPicker({ value, onChange }: {
  value?: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const parsed = parseAvatarValue(value);
  return (
    <div data-testid="avatar-picker" className="space-y-2">
      <div className="grid grid-cols-6 gap-1 max-h-56 overflow-y-auto" role="group" aria-label={t.toolbox.agentAvatar}>
        {AVATAR_ICONS.flatMap((icon) => AVATAR_TINTS.map((tint) => {
          const avatar = buildAvatarValue(icon, tint);
          const selected = parsed.kind === 'icon' && parsed.icon === icon && parsed.tint === tint;
          const label = format(t.avatarPicker.optionLabel, { icon: t.avatarPicker.icons[icon], tint: t.avatarPicker.tints[tint] });
          return (
            <Button
              key={avatar}
              type="button"
              variant="ghost"
              size="icon-lg"
              className={cn('w-full', selected && 'ring-2 ring-inset ring-[var(--abu-clay)]')}
              aria-label={label}
              title={label}
              aria-pressed={selected}
              data-testid={`avatar-option-${icon}-${tint}`}
              onClick={() => onChange(avatar)}
            >
              <AgentAvatar agent={{ name: 'avatar', avatar }} size="lg" />
            </Button>
          );
        }))}
      </div>
      <Button type="button" variant="ghost" size="sm" aria-pressed={parsed.kind === 'default'} onClick={() => onChange('')}>
        {t.avatarPicker.defaultAvatar}
      </Button>
    </div>
  );
}
