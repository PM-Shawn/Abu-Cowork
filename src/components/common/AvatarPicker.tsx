import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { AVATAR_ICONS, AVATAR_TINTS, AVATAR_TINT_MAP, buildAvatarValue, parseAvatarValue } from '@/core/team/avatarPresets';
import AgentAvatar from '@/components/common/AgentAvatar';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';

/** Shared by agent and team editors; only built-in references are newly authored. */
export default function AvatarPicker({ value, onChange, children }: {
  value?: string;
  onChange: (value: string) => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const parsed = parseAvatarValue(value);
  const selectionLabel = parsed.kind === 'icon'
    ? format(t.avatarPicker.optionLabel, { icon: t.avatarPicker.icons[parsed.icon], tint: t.avatarPicker.tints[parsed.tint] })
    : parsed.kind === 'emoji' ? parsed.emoji : undefined;
  const [pendingTint, setPendingTint] = useState('blue');
  const tint = parsed.kind === 'icon' ? parsed.tint : pendingTint;
  const selectTint = (color: string) => {
    setPendingTint(color);
    if (parsed.kind === 'icon') onChange(buildAvatarValue(parsed.icon, color));
  };
  return (
    <Popover onOpenChange={(open) => { if (open) setPendingTint('blue'); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="icon-lg" className="shrink-0 rounded-xl border-[var(--abu-border-subtle)] dark:border-[var(--abu-border-subtle)] p-1 shadow-none hover:border-[var(--abu-border-hover)]" aria-label={selectionLabel ? format(t.avatarPicker.chooseAvatarWithSelection, { avatar: selectionLabel }) : t.avatarPicker.chooseAvatar} title={t.avatarPicker.chooseAvatar} data-testid="avatar-picker-trigger">
          {children ?? <AgentAvatar agent={{ name: 'avatar', avatar: value }} size="lg" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="z-[10000] w-72 max-w-[calc(100vw-2rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto p-3 space-y-3"
        aria-label={t.avatarPicker.chooseAvatar}
        data-testid="avatar-picker"
        data-electron-no-drag
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <div className="space-y-1.5" role="group" aria-label={t.avatarPicker.color}>
          <div className="text-minor font-medium text-[var(--abu-text-secondary)]">{t.avatarPicker.color}</div>
          <div className="grid grid-cols-6 gap-1">
            {AVATAR_TINTS.map((color) => (
              <Button key={color} type="button" variant="ghost" size="icon" className={cn('w-full', tint === color && 'ring-2 ring-inset ring-[var(--abu-clay)]')} aria-label={t.avatarPicker.tints[color]} title={t.avatarPicker.tints[color]} aria-pressed={tint === color} data-testid={`avatar-tint-${color}`} onClick={() => selectTint(color)}>
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full" style={{ backgroundColor: AVATAR_TINT_MAP[color].bg, color: AVATAR_TINT_MAP[color].fg }}>
                  {tint === color && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
                </span>
              </Button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5" role="group" aria-label={t.avatarPicker.icon}>
          <div className="text-minor font-medium text-[var(--abu-text-secondary)]">{t.avatarPicker.icon}</div>
          <div className="grid grid-cols-5 gap-1">
            {AVATAR_ICONS.map((icon) => {
              const avatar = buildAvatarValue(icon, tint);
              const selected = parsed.kind === 'icon' && parsed.icon === icon && parsed.tint === tint;
              const label = format(t.avatarPicker.optionLabel, { icon: t.avatarPicker.icons[icon], tint: t.avatarPicker.tints[tint] });
              return (
                <Button
                  key={icon}
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  className={cn('w-full', selected && 'ring-2 ring-inset ring-[var(--abu-clay)]')}
                  aria-label={label}
                  title={label}
                  aria-pressed={selected}
                  data-testid={`avatar-icon-${icon}`}
                  onClick={() => onChange(avatar)}
                >
                  <AgentAvatar agent={{ name: 'avatar', avatar }} size="lg" />
                </Button>
              );
            })}
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" className="w-full" aria-pressed={parsed.kind === 'default'} onClick={() => { setPendingTint('blue'); onChange(''); }}>
          {t.avatarPicker.defaultAvatar}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
