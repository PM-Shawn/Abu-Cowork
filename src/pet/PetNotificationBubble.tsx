import { useEffect, useRef } from 'react'
import type { PetStatus, WaitingKind } from '@/core/pet/petStatusBridge'
import { STATUS_TONE } from './petStatusMeta'
import { isImeComposing } from '@/components/chat/composerKeys'
import { Icon } from '@/components/ds/icon'
import { AppIcons } from '@/components/ds/icons'
import { Pressable } from '@/components/ds/pressable'
import { TextField } from '@/components/ds/text-field'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

/** Non-waiting display modes, driven by PetApp (which owns the window frame). */
export type NotifMode = 'collapsed' | 'expanded' | 'replying'

interface PetNotificationBubbleProps {
  status: PetStatus
  title: string | null
  summary: string | null
  mode: NotifMode
  /** Sub-kind when status === 'waiting'. 'approval' → route to main window
   *  (no inline text reply); 'input' → inline reply. */
  waitingKind?: WaitingKind | null
  /** Pause the collapsed-done fade-out (parent pauses dismissal on hover). */
  paused?: boolean
  /** Report hover enter/leave so the parent can pause the done auto-dismiss. */
  onHoverChange?: (hovered: boolean) => void
  /** Click the bubble body → open the main window to this conversation. */
  onOpenMain: () => void
  /** Toggle expand/collapse of the full content (hover-revealed chevron). */
  onToggleExpand: () => void
  /** Enter reply mode (hover-revealed 回复 button; non-waiting only). */
  onStartReply: () => void
  /** Submit an inline reply. */
  onReply: (text: string) => void
}

/**
 * Activity Notification Tray bubble (Phase C) — replaces the bare
 * StatusLight ring. Collapsed it's a single truncated line (status dot +
 * title + summary). Hovering reveals two controls, Codex-style, without
 * resizing the window (pure CSS): a 回复 button and an expand/collapse
 * chevron. Clicking either is a deliberate action that resizes the window
 * (PetApp owns the frame): expand wraps the full text; 回复 opens an inline
 * input. The `waiting` state always shows the input directly. Renders
 * nothing when idle; a collapsed `done` bubble fades out (petNotifFade).
 *
 * The buttons are `Pressable`s with a name and no tooltip: the pet window is
 * exactly as large as the bubble and the avatar, so a floating layer has no
 * room in it.
 */
export function PetNotificationBubble({
  status, title, summary, mode, waitingKind, paused, onHoverChange,
  onOpenMain, onToggleExpand, onStartReply, onReply,
}: PetNotificationBubbleProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)

  // A blocking approval dialog (file permission etc.): the pet only signals it
  // and routes to the main window — no inline text reply, since typing can't
  // grant a permission. Mirrors Codex's clock "needs confirmation" slot.
  const isApproval = status === 'waiting' && waitingKind === 'approval'
  const showInput = !isApproval && (status === 'waiting' || mode === 'replying')
  const expanded = mode === 'expanded'
  // The bottom 回复 affordance is offered for non-waiting bubbles that aren't
  // already in reply mode (waiting/approval are handled by the input / route).
  const canReply = status !== 'waiting' && mode !== 'replying'

  useEffect(() => {
    if (showInput) inputRef.current?.focus()
  }, [showInput])

  // idle → nothing to show (avatar only, per spec)
  if (status === 'idle') return null

  // The field drops the repeats of a held Enter before this runs (ds TextField).
  // An Enter that belongs to an input method confirms the composition and sends nothing: the
  // same test the composer uses (chat/composerKeys.ts).
  function handleReplyKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isImeComposing(e, false)) return
    if (e.key === 'Enter') {
      const val = e.currentTarget.value.trim()
      if (val) {
        onReply(val)
        e.currentTarget.value = ''
      }
    }
  }

  return (
    <div
      className="relative w-50"
      data-testid="pet-notification"
      data-status={status}
      data-mode={mode}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      {/* No box-shadow: the pet window is transparent and exactly as wide as
          this card, so a shadow would be cut off at the window edge and drawn
          straight onto the desktop. The 1px border alone delimits the bubble.
          `group` drives the hover-reveal of the controls below. The
          collapsed-done fade is suppressed while `paused` (parent is hovering)
          so the bubble doesn't vanish from under a user reaching for its
          controls. The curve is the one CSS names ease-out, written out. */}
      <div
        style={{ animation: status === 'done' && mode === 'collapsed' && !paused ? 'petNotifFade 6s cubic-bezier(0, 0, 0.58, 1) forwards' : undefined }}
        className="group rounded-panel border border-separator bg-raised px-3 py-2"
      >
        <div className="relative flex items-start gap-2">
          <Pressable
            className="flex min-w-0 flex-1 items-start gap-2 rounded-control text-left"
            onClick={onOpenMain}
            aria-label={t.pet.openMain}
          >
            {isApproval ? (
              <Icon icon={AppIcons.clock} size="sm" className="mt-0.5 text-warning" />
            ) : (
              <span data-pet-status-dot="" className={cn('mt-1 h-2 w-2 shrink-0 rounded-full bg-current', STATUS_TONE[status])} />
            )}
            {isApproval ? (
              // The 需要授权 hint is the whole point — pin it (shrink-0)
              // and let the (contextual) title truncate to make room, so a
              // long title never squeezes the hint into "需要…".
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-caption text-label">
                {title && <b className="min-w-0 truncate font-semibold">{title}</b>}
                <span className="shrink-0 font-medium text-warning">{t.pet.needAuth}</span>
              </span>
            ) : (
              <span
                className={cn(
                  'min-w-0 flex-1 text-caption text-label',
                  expanded ? 'block max-h-75 overflow-y-auto whitespace-normal break-words pr-1 leading-relaxed' : 'truncate',
                )}
              >
                {title && <b className="font-semibold">{title}</b>}
                {title && summary ? '　' : ''}
                {summary && <span className="text-label-secondary">{summary}</span>}
              </span>
            )}
          </Pressable>

          {/* Top-right hover control: expand/collapse only (pure CSS reveal,
              no height change). 回复 lives at the bottom, Codex-style. */}
          {!isApproval && (
            <div className="pointer-events-none shrink-0 self-start bg-raised pl-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
              <Pressable
                className="flex h-5 w-5 items-center justify-center rounded-control text-label-tertiary hover:bg-fill-hover hover:text-label"
                onClick={onToggleExpand}
                aria-label={expanded ? t.pet.collapse : t.pet.expand}
              >
                <Icon icon={expanded ? AppIcons.collapse : AppIcons.expand} size="sm" />
              </Pressable>
            </div>
          )}
        </div>

        {showInput ? (
          <div className="mt-2">
            <TextField
              ref={inputRef}
              placeholder={t.pet.replyPlaceholder}
              onKeyDown={handleReplyKey}
            />
          </div>
        ) : (
          // Bottom 回复 row (Codex layout): for non-waiting bubbles. Always in
          // the layout (so the window height is stable — no resize-on-hover
          // jank) and revealed by pure CSS group-hover, same as the chevron.
          canReply && (
            <div className="pointer-events-none mt-1.5 flex opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
              <Pressable
                className="rounded-control px-2 py-1 text-caption leading-none text-label-secondary hover:bg-fill-hover hover:text-label"
                onClick={onStartReply}
                aria-label={t.pet.reply}
              >
                {t.pet.reply}
              </Pressable>
            </div>
          )
        )}
      </div>
    </div>
  )
}
