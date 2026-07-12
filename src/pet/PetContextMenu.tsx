import { useEffect, useRef } from 'react'
import type { PetStatus } from '@/core/pet/petStatusBridge'
import { STATUS_COLOR } from './petStatusMeta'
import { useI18n } from '@/i18n'

interface PetContextMenuProps {
  status: PetStatus
  onOpenMain: () => void
  onClosePet: () => void
  onDismiss: () => void
}

export function PetContextMenu({
  status, onOpenMain, onClosePet, onDismiss,
}: PetContextMenuProps) {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      // Avatar interactions are handled by PetApp (its click opens the main
      // window / dismisses the menu) — dismissing here too would race that
      // handler and cause a close-then-reopen flicker.
      if (target instanceof Element && target.closest('[data-pet-avatar]')) return
      onDismiss()
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onDismiss])

  return (
    // No box-shadow — on the transparent pet window it rendered as the
    // "black shadow" smudge around the menu. The border delimits it.
    <div
      ref={menuRef}
      className="w-[170px] bg-[var(--abu-bg-base)] rounded-[10px] py-1.5 border border-[var(--abu-border)]"
    >
      <div className="px-3.5 py-2 flex items-center gap-2 border-b border-[var(--abu-border)]">
        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: STATUS_COLOR[status] }}
        />
        <span className="flex-1 text-[11px] text-[var(--abu-text-tertiary)]">{t.pet.status[status]}</span>
        <button
          className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
          onClick={onDismiss}
          aria-label={t.pet.closeMenu}
        >
          ×
        </button>
      </div>

      <button
        className="w-full px-3.5 py-2 text-[12px] text-[var(--abu-text-secondary)] text-left hover:bg-[var(--abu-bg-hover)]"
        onClick={onOpenMain}
      >
        {t.pet.openMain}
      </button>

      <button
        className="w-full px-3.5 py-2 text-[12px] text-[var(--abu-text-tertiary)] text-left hover:bg-[var(--abu-bg-hover)]"
        onClick={onClosePet}
      >
        {t.pet.closePet}
      </button>
    </div>
  )
}
