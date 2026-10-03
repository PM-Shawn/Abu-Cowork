import { useState, type ReactNode } from 'react';
import { AVATAR_ICONS, AVATAR_TINTS, AVATAR_TINT_MAP, buildAvatarValue, parseAvatarValue } from '@/core/team/avatarPresets';
import AgentAvatar from '@/components/common/AgentAvatar';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Popover } from '@/components/ds/popover';
import { Pressable } from '@/components/ds/pressable';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';

// A cell of either grid. The chosen one carries the selected fill as well as the ring, so it
// still reads as chosen while the keyboard ring (the same ring, without the fill) is on another
// cell. Both rings are drawn inside the cell: the list scrolls in a short window and would cut
// a ring drawn outside it.
const CELL = 'flex w-full items-center justify-center rounded-control focus-visible:ring-inset';
const CELL_CHOSEN = 'bg-fill-selected ring-2 ring-inset ring-focus';
const CELL_IDLE = 'hover:bg-fill-hover';

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
  const [pendingTint, setPendingTint] = useState(AVATAR_TINTS[0]);
  const tint = parsed.kind === 'icon' ? parsed.tint : pendingTint;
  const selectTint = (color: string) => {
    setPendingTint(color);
    if (parsed.kind === 'icon') onChange(buildAvatarValue(parsed.icon, color));
  };
  return (
    // One popover per editor. Escape closes it alone: the design-system layers close one at a time.
    <Popover
      align="start"
      onOpenChange={(open) => { if (open) setPendingTint(AVATAR_TINTS[0]); }}
      trigger={(
        <Pressable
          aria-label={selectionLabel ? format(t.avatarPicker.chooseAvatarWithSelection, { avatar: selectionLabel }) : t.avatarPicker.chooseAvatar}
          title={t.avatarPicker.chooseAvatar}
          data-testid="avatar-picker-trigger"
          className="inline-flex shrink-0 rounded-control p-1 hover:bg-fill-hover"
        >
          {children ?? <AgentAvatar agent={{ name: 'avatar', avatar: value }} size="lg" />}
        </Pressable>
      )}
    >
      {/* The popover offers no hook on its own box, so this one child carries the name and the
          test id, and scrolls when the window is too short for the whole list (the popover keeps
          its 12px of padding above and below). */}
      <div
        role="group"
        aria-label={t.avatarPicker.chooseAvatar}
        data-testid="avatar-picker"
        className="max-h-[calc(var(--radix-popover-content-available-height)_-_1.5rem)] space-y-3 overflow-y-auto"
      >
        <div className="space-y-1" role="group" aria-label={t.avatarPicker.color}>
          <div className="text-ui-sm font-medium text-label-secondary">{t.avatarPicker.color}</div>
          <div className="grid grid-cols-6 gap-1">
            {AVATAR_TINTS.map((color) => (
              <Pressable
                key={color}
                className={cn(CELL, 'h-8', tint === color ? CELL_CHOSEN : CELL_IDLE)}
                aria-label={t.avatarPicker.tints[color]}
                title={t.avatarPicker.tints[color]}
                aria-pressed={tint === color}
                data-testid={`avatar-tint-${color}`}
                onClick={() => selectTint(color)}
              >
                {/* The swatch is the identity colour itself (data), not a status colour. */}
                <span className="inline-flex size-5 items-center justify-center rounded-full" style={{ backgroundColor: AVATAR_TINT_MAP[color].bg, color: AVATAR_TINT_MAP[color].fg }}>
                  {tint === color && <Icon icon={AppIcons.done} size="sm" />}
                </span>
              </Pressable>
            ))}
          </div>
        </div>
        <div className="space-y-1" role="group" aria-label={t.avatarPicker.icon}>
          <div className="text-ui-sm font-medium text-label-secondary">{t.avatarPicker.icon}</div>
          <div className="grid grid-cols-5 gap-1">
            {AVATAR_ICONS.map((icon) => {
              const avatar = buildAvatarValue(icon, tint);
              const selected = parsed.kind === 'icon' && parsed.icon === icon && parsed.tint === tint;
              const label = format(t.avatarPicker.optionLabel, { icon: t.avatarPicker.icons[icon], tint: t.avatarPicker.tints[tint] });
              return (
                <Pressable
                  key={icon}
                  className={cn(CELL, 'h-10', selected ? CELL_CHOSEN : CELL_IDLE)}
                  aria-label={label}
                  title={label}
                  aria-pressed={selected}
                  data-testid={`avatar-icon-${icon}`}
                  onClick={() => onChange(avatar)}
                >
                  <AgentAvatar agent={{ name: 'avatar', avatar }} size="lg" />
                </Pressable>
              );
            })}
          </div>
        </div>
        {/* A column, so the button spans the popover without a width class of its own. */}
        <div className="flex flex-col">
          <Button variant="plain" size="sm" aria-pressed={parsed.kind === 'default'} onClick={() => { setPendingTint(AVATAR_TINTS[0]); onChange(''); }}>
            {t.avatarPicker.defaultAvatar}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
