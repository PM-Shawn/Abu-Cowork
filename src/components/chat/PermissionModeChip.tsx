import { memo, useRef, useState, type ComponentProps, type KeyboardEvent, type MouseEvent } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ds/button';
import { AppIcons, type AppIconName } from '@/components/ds/icons';
import { Popover } from '@/components/ds/popover';
import { RadioGroup } from '@/components/ds/radio-group';
import { Tooltip } from '@/components/ds/tooltip';
import type { PermissionMode } from '@/core/permissions/permissionMode';

const MODES: PermissionMode[] = ['standard', 'smart', 'autonomous'];

const MODE_ICON: Record<PermissionMode, AppIconName> = {
  standard: 'permissionAsk',
  smart: 'permissionReview',
  autonomous: 'warning',
};

// The Popover hands its props (open state, click, ref) to this component; spreading them
// onto the button lets the Tooltip wrap it.
function ModeTrigger({ mode, label, hint, className, ...props }: ComponentProps<'button'> & {
  mode: PermissionMode;
  label: string;
  hint: string;
}) {
  return (
    <Tooltip content={hint}>
      <Button
        variant="plain"
        size="sm"
        icon={AppIcons[MODE_ICON[mode]]}
        /* Just the mode, matching the visible label — NOT the hint's
           "默认权限模式: …" phrasing, which is the settings dialog control's
           accessible name and would make `getByRole` ambiguous across the two
           (tests/e2e/security-settings.spec.ts locates it by exactly that).
           The point of spelling it out is that the label goes display:none at
           narrow widths, which would otherwise take the name with it. */
        aria-label={label}
        // Full autonomy is a risk, so it reads as a warning: color plus the warning shape.
        className={cn(mode === 'autonomous' ? 'text-warning' : 'text-label-secondary', className)}
        {...props}
      >
        {/* Second rung of the composer toolbar's degradation ladder: in a
            narrow pane the mode reads well enough from its icon, and the full
            label stays in the tooltip and `aria-label`. The query resolves
            against the composer toolbar's `@container`; anywhere without one
            it never matches, so the label simply always shows. */}
        <span className="whitespace-nowrap @max-[420px]:hidden">{label}</span>
      </Button>
    </Tooltip>
  );
}

function PermissionModeChip({ conversationId }: { conversationId: string | null }) {
  const [open, setOpen] = useState(false);
  // Arrow keys move the choice inside the list; only a click, Space or Enter closes it.
  const movedByArrow = useRef(false);
  const { t } = useI18n();

  const convMode = useChatStore(
    (s) => (conversationId ? s.conversations[conversationId]?.permissionMode : s.pendingPermissionMode)
  );
  const globalMode = useSettingsStore((s) => s.permissionMode);
  const effectiveMode = convMode ?? globalMode;

  const setConversationPermissionMode = useChatStore((s) => s.setConversationPermissionMode);
  const setPendingPermissionMode = useChatStore((s) => s.setPendingPermissionMode);

  const modeLabels: Record<PermissionMode, { label: string; description: string }> = {
    standard: { label: t.settings.permissionModeStandard, description: t.settings.permissionModeStandardDesc },
    smart: { label: t.settings.permissionModeSmart, description: t.settings.permissionModeSmartDesc },
    autonomous: { label: t.settings.permissionModeAutonomous, description: t.settings.permissionModeAutonomousDesc },
  };

  const currentMode: PermissionMode = MODES.includes(effectiveMode) ? effectiveMode : 'standard';
  const currentLabel = modeLabels[currentMode].label;

  function handleSelect(value: string) {
    const mode = value as PermissionMode;
    if (conversationId) {
      setConversationPermissionMode(conversationId, mode);
    } else {
      setPendingPermissionMode(mode);
    }
  }

  // Capture phase: the radio group moves focus and checks the next option while handling
  // the same key, before a bubbling handler would see it.
  function handleKeyDownCapture(e: KeyboardEvent<HTMLDivElement>) {
    movedByArrow.current = e.key.startsWith('Arrow');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter') setOpen(false);
  }

  // A click on an option (the current one included) or Space closes the list. A click on
  // an option's words reaches here a second time as a click on its radio.
  function handleClick(e: MouseEvent<HTMLDivElement>) {
    if (movedByArrow.current) return;
    if ((e.target as HTMLElement).closest('[role="radio"]')) setOpen(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      trigger={(
        <ModeTrigger
          mode={currentMode}
          label={currentLabel}
          hint={`${t.settings.permissionMode}: ${currentLabel}`}
        />
      )}
    >
      <div
        onKeyDownCapture={handleKeyDownCapture}
        onKeyDown={handleKeyDown}
        onPointerDown={() => { movedByArrow.current = false; }}
        onClick={handleClick}
      >
        <RadioGroup
          value={currentMode}
          onValueChange={handleSelect}
          label={t.settings.permissionMode}
          options={MODES.map((mode) => ({
            value: mode,
            label: (
              <span className="flex flex-col">
                <span>{modeLabels[mode].label}</span>
                <span className="text-ui-sm text-label-secondary">{modeLabels[mode].description}</span>
              </span>
            ),
          }))}
        />
      </div>
    </Popover>
  );
}

// The composer re-renders on every streamed token; the chip only changes with its mode.
export default memo(PermissionModeChip);
