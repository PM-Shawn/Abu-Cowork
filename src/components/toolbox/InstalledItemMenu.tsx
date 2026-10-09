import { useRef } from 'react';
import { IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem, MenuSeparator } from '@/components/ds/menu';

export interface InstalledItemMenuAction {
  id: 'trial' | 'manage' | 'uninstall' | 'edit' | 'view' | 'delete' | 'remove' | 'source' | 'prepare';
  label: string;
  onSelect: () => void;
  /** Renders in the destructive group (after the separator), in danger colour. */
  destructive?: boolean;
  /** When set the item renders disabled with this text as its title. */
  disabledReason?: string;
}

interface InstalledItemMenuProps {
  actions: InstalledItemMenuAction[];
  /** Accessible name of the `···` trigger, e.g. "canva 的操作". */
  ariaLabel: string;
  /** `data-testid` of the trigger; each item gets `{testId}-{action.id}`. */
  testId: string;
}

/**
 * The `···` menu on an installed/configured extension item. Destructive actions
 * are grouped after a separator; an action carrying `disabledReason` renders
 * disabled with that reason as its tooltip and never fires.
 *
 * The chosen action runs once the menu has gone, with the focus back on the
 * trigger: a window the action opens remembers the trigger and returns the
 * focus to it. Clicks on the trigger and inside the menu never reach an
 * ancestor row, so the menu can sit on a clickable card.
 */
export default function InstalledItemMenu({ actions, ariaLabel, testId }: InstalledItemMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<InstalledItemMenuAction | null>(null);
  const primary = actions.filter((action) => !action.destructive);
  const destructive = actions.filter((action) => action.destructive);

  const item = (action: InstalledItemMenuAction) => (
    <MenuItem
      key={action.id}
      testId={`${testId}-${action.id}`}
      tone={action.destructive ? 'danger' : 'default'}
      disabled={Boolean(action.disabledReason)}
      title={action.disabledReason}
      onSelect={() => { pendingRef.current = action; }}
    >
      {action.label}
    </MenuItem>
  );

  return (
    <Menu
      align="end"
      // A menu reopened during its exit animation stays mounted and its close hook never
      // ran for the earlier choice: opening forgets it.
      onOpenChange={(open) => { if (open) pendingRef.current = null; }}
      onCloseAutoFocus={(event) => {
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (!pending) return;
        event.preventDefault();
        triggerRef.current?.focus();
        pending.onSelect();
      }}
      trigger={(
        <IconButton
          ref={triggerRef}
          icon={AppIcons.more}
          label={ariaLabel}
          data-testid={testId}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    >
      {/* React events travel up the component tree through the portal; the row must not get these clicks. */}
      <div role="presentation" className="contents" onClick={(event) => event.stopPropagation()}>
        {primary.map(item)}
        {primary.length > 0 && destructive.length > 0 && <MenuSeparator />}
        {destructive.map(item)}
      </div>
    </Menu>
  );
}
