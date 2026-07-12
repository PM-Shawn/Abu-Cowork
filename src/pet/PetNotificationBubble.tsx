import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, Clock } from 'lucide-react'
import type { PetStatus, WaitingKind } from '@/core/pet/petStatusBridge'
import { STATUS_COLOR } from './petStatusMeta'
import { Input } from '@/components/ui/input'
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
 */
export function PetNotificationBubble({
  status, title, summary, mode, waitingKind, paused, onHoverChange,
  onOpenMain, onToggleExpand, onStartReply, onReply,
}: PetNotificationBubbleProps) {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)

  // A blocking approval dialog (file permission etc.): the pet only signals it
  // and routes to the main window — no inline text reply, since typing can't
  // grant a permission. Mirrors Codex's orange-clock "needs confirmation" slot.
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

  function handleReplyKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const val = e.currentTarget.value.trim()
      if (val) {
        onReply(val)
        e.currentTarget.value = ''
      }
    }
  }

  const Chevron = expanded ? ChevronUp : ChevronDown

  return (
    <div
      className="relative w-[200px]"
      data-testid="pet-notification"
      data-status={status}
      data-mode={mode}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      {/* No box-shadow: on the transparent pet window a CSS shadow composites
          straight onto the desktop as a dark smudge (the old "black shadow"
          bug). The 1px border alone delimits the bubble. `group` drives the
          hover-reveal of the controls below. The collapsed-done fade is
          suppressed while `paused` (parent is hovering) so the bubble doesn't
          vanish from under a user reaching for its controls. */}
      <div
        style={{ animation: status === 'done' && mode === 'collapsed' && !paused ? 'petNotifFade 6s ease-out forwards' : undefined }}
        className="group bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-2xl px-3 py-2"
      >
        <div className="relative flex items-start gap-2">
          <button
            className="flex items-start gap-2 flex-1 min-w-0 text-left"
            onClick={onOpenMain}
            aria-label={t.pet.openMain}
          >
            {isApproval ? (
              <Clock
                className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
                style={{ color: STATUS_COLOR.waiting }}
                strokeWidth={2.5}
              />
            ) : (
              <span
                className="w-2 h-2 mt-1 rounded-full flex-shrink-0"
                style={{ backgroundColor: STATUS_COLOR[status] }}
              />
            )}
            {isApproval ? (
              // The 需要授权 hint is the whole point — pin it (flex-shrink-0)
              // and let the (contextual) title truncate to make room, so a
              // long title never squeezes the hint into "需要…".
              <span className="flex-1 min-w-0 flex items-baseline gap-1.5 text-[11px] text-[var(--abu-text-primary)]">
                {title && <b className="font-semibold truncate min-w-0">{title}</b>}
                <span className="flex-shrink-0 font-medium" style={{ color: STATUS_COLOR.waiting }}>{t.pet.needAuth}</span>
              </span>
            ) : (
              <span
                className={`flex-1 min-w-0 text-[11px] text-[var(--abu-text-primary)] ${expanded ? 'block whitespace-normal break-words leading-relaxed max-h-[300px] overflow-y-auto pr-1' : 'truncate'}`}
              >
                {title && <b className="font-semibold">{title}</b>}
                {title && summary ? '　' : ''}
                {summary && <span className="text-[var(--abu-text-secondary)]">{summary}</span>}
              </span>
            )}
          </button>

          {/* Top-right hover control: expand/collapse only (pure CSS reveal,
              no height change). 回复 lives at the bottom, Codex-style. */}
          {!isApproval && (
            <div className="flex-shrink-0 self-start opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto bg-[var(--abu-bg-base)] pl-1">
              <button
                className="w-5 h-5 flex items-center justify-center rounded-md text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]"
                onClick={onToggleExpand}
                aria-label={expanded ? t.pet.collapse : t.pet.expand}
              >
                <Chevron className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {showInput ? (
          <div className="mt-2">
            <Input
              ref={inputRef}
              className="h-7 text-[11px] px-2"
              placeholder={t.pet.replyPlaceholder}
              onKeyDown={handleReplyKey}
            />
          </div>
        ) : (
          // Bottom 回复 row (Codex layout): for non-waiting bubbles. Always in
          // the layout (so the window height is stable — no resize-on-hover
          // jank) and revealed by pure CSS group-hover, same as the chevron.
          canReply && (
            <div className="mt-1.5 flex opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto">
              <button
                className="text-[11px] leading-none px-2 py-1 rounded-md text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]"
                onClick={onStartReply}
                aria-label={t.pet.reply}
              >
                {t.pet.reply}
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
}
