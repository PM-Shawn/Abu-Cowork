import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Checkbox } from '@/components/ds/checkbox';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Popover } from '@/components/ds/popover';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { formatRelativeTime } from '@/utils/messageTime';
import { MAX_ATTACH_CONVERSATIONS } from '@/core/diagnostic/collect';
import { cn } from '@/lib/utils';

interface Props {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

// The look of a select field, for a trigger that opens a panel.
const PANEL_TRIGGER = 'flex h-7 w-full items-center justify-between gap-2 rounded-control border border-control-border bg-field px-2 text-ui text-label';

/** One conversation in the panel. memo with primitive props and a stable `onToggle`: a user can
 *  have hundreds of conversations, and a keystroke in the search box or a tick on one row must
 *  not draw the rows that stay as they are. */
const ConversationRow = memo(function ConversationRow({ id, title, checked, current, currentLabel, updatedAt, messageCountText, disabled, onToggle }: {
  id: string;
  title: string;
  checked: boolean;
  current: boolean;
  currentLabel: string;
  updatedAt: number;
  messageCountText: string;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const boxId = useId();
  return (
    <li className="flex h-7 items-center gap-2 rounded-control px-2 hover:bg-fill-hover">
      <Checkbox id={boxId} checked={checked} disabled={disabled} onCheckedChange={() => onToggle(id)} />
      <label htmlFor={boxId} className="min-w-0 flex-1 truncate text-ui text-label">{title}</label>
      {current && <Tag>{currentLabel}</Tag>}
      <span className="shrink-0 text-caption text-label-tertiary">{formatRelativeTime(updatedAt)}</span>
      <span className="w-16 shrink-0 text-right text-caption text-label-tertiary">{messageCountText}</span>
    </li>
  );
});

/** The panel's content. It is a component of its own so that the list is built only while the
 *  panel is open. */
function ConversationPanel({ search, onSearchChange, selectedIds, disabled, onToggle }: {
  search: string;
  onSearchChange: (value: string) => void;
  selectedIds: string[];
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const { t } = useI18n();
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const activeConversationId = useChatStore((s) => s.activeConversationId);

  const sorted = useMemo(
    () => Object.values(conversationIndex).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversationIndex],
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => (c.title || '').toLowerCase().includes(q));
  }, [sorted, search]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  return (
    <>
      <TextField
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder={t.diagnostic.conversationPickerSearchPlaceholder}
        disabled={disabled}
      />

      {filtered.length === 0 ? (
        <div className="py-3 text-center text-caption text-label-tertiary">
          {t.diagnostic.conversationPickerEmpty}
        </div>
      ) : (
        <ul className="mt-2 max-h-60 overflow-y-auto">
          {filtered.map((c) => (
            <ConversationRow
              key={c.id}
              id={c.id}
              title={c.title || t.diagnostic.conversationPickerNoTitle}
              checked={selectedSet.has(c.id)}
              current={c.id === activeConversationId}
              currentLabel={t.diagnostic.conversationPickerCurrentBadge}
              updatedAt={c.updatedAt}
              messageCountText={format(t.diagnostic.conversationPickerMessageCount, { count: c.messageCount })}
              disabled={disabled}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Collapsed multi-select dropdown for attaching conversations to the diagnostic
 * feedback bundle. Trigger shows a summary ("已选 N 个" / placeholder); opening
 * reveals a search box + scrollable checkbox list. Deliberately has NO "select
 * all": each inclusion embeds a conversation's full messages, so it stays a
 * conscious per-conversation choice. Selecting a row keeps the dropdown open
 * (multi-select), unlike a single-select which closes on pick.
 */
export default function ConversationPicker({ selectedIds, onChange, disabled }: Props) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const toggle = (id: string) => {
    if (disabled) return;
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((x) => x !== id));
      return;
    }
    if (selectedIds.length >= MAX_ATTACH_CONVERSATIONS) {
      addToast({
        title: format(t.diagnostic.conversationPickerTooMany, { max: MAX_ATTACH_CONVERSATIONS }),
        type: 'warning',
        duration: 3000,
      });
      return;
    }
    onChange([...selectedIds, id]);
  };
  // The rows keep one function for as long as the panel is open; it runs the latest `toggle`.
  const latestToggle = useRef(toggle);
  useLayoutEffect(() => { latestToggle.current = toggle; });
  const onToggle = useCallback((id: string) => latestToggle.current(id), []);

  const isEmpty = selectedIds.length === 0;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      className="w-(--radix-popover-trigger-width) p-2"
      trigger={(
        // Looks like a select field, shows a selection summary.
        <Pressable disabled={disabled} aria-expanded={open} className={PANEL_TRIGGER}>
          <span className={cn('min-w-0 truncate text-left', isEmpty && 'text-label-placeholder')}>
            {isEmpty
              ? t.diagnostic.conversationPickerTriggerPlaceholder
              : format(t.diagnostic.conversationPickerSelectedCount, { count: selectedIds.length })}
          </span>
          <Icon icon={AppIcons.selectorChevrons} size="sm" className="text-label-secondary" />
        </Pressable>
      )}
    >
      <ConversationPanel
        search={search}
        onSearchChange={setSearch}
        selectedIds={selectedIds}
        disabled={Boolean(disabled)}
        onToggle={onToggle}
      />
    </Popover>
  );
}
