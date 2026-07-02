import { useEffect, useRef } from 'react'
import type { PetStatus } from '@/core/pet/petStatusBridge'
import { STATUS_COLOR } from './petStatusMeta'
import { Input } from '@/components/ui/input'

interface PetNotificationBubbleProps {
  status: PetStatus
  title: string | null
  summary: string | null
  /** Click the bubble → open the main window to this conversation. */
  onOpenMain: () => void
  /** waiting-state inline reply submit. */
  onReply: (text: string) => void
}

/**
 * Activity Notification Tray bubble (Phase C) — replaces the bare
 * StatusLight ring. Single-line layout: status dot + conversation title +
 * latest reply summary, truncated. Renders nothing when idle. The `done`
 * state lingers then fades out (petNotifFade). The `waiting` state adds an
 * inline reply input (this is where Quick Chat now lives — the avatar no
 * longer opens a standalone input bubble). A plain rounded card with no
 * pointer/tail.
 */
export function PetNotificationBubble({
  status, title, summary, onOpenMain, onReply,
}: PetNotificationBubbleProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (status === 'waiting') inputRef.current?.focus()
  }, [status])

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

  return (
    <div className="relative w-[200px]" data-testid="pet-notification" data-status={status}>
      {/* No box-shadow: on the transparent pet window a CSS shadow composites
          straight onto the desktop as a dark smudge (the old "black shadow"
          bug). The 1px border alone delimits the bubble. */}
      <div
        style={{ animation: status === 'done' ? 'petNotifFade 6s ease-out forwards' : undefined }}
        className="bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-2xl px-3 py-2"
      >
        <button
          className="flex items-center gap-2 w-full text-left"
          onClick={onOpenMain}
          aria-label="打开主窗口"
        >
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: STATUS_COLOR[status] }}
          />
          <span className="flex-1 min-w-0 truncate text-[11px] text-[var(--abu-text-primary)]">
            {title && <b className="font-semibold">{title}</b>}
            {title && summary ? '　' : ''}
            {summary && <span className="text-[var(--abu-text-secondary)]">{summary}</span>}
          </span>
        </button>

        {status === 'waiting' && (
          <div className="mt-2">
            <Input
              ref={inputRef}
              className="h-7 text-[11px] px-2"
              placeholder="回复…"
              onKeyDown={handleReplyKey}
            />
          </div>
        )}
      </div>
    </div>
  )
}
