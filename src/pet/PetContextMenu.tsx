import { useEffect, useRef } from 'react'
import type { PetStatus } from '@/core/pet/petStatusBridge'
import { STATUS_COLOR, STATUS_LABEL } from './petStatusMeta'

interface PetContextMenuProps {
  status: PetStatus
  onOpenMain: () => void
  onClosePet: () => void
  onDismiss: () => void
}

export function PetContextMenu({
  status, onOpenMain, onClosePet, onDismiss,
}: PetContextMenuProps) {
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
        <span className="flex-1 text-[11px] text-[var(--abu-text-tertiary)]">{STATUS_LABEL[status]}</span>
        <button
          className="w-4 h-4 flex items-center justify-center flex-shrink-0 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
          onClick={onDismiss}
          aria-label="关闭菜单"
        >
          ×
        </button>
      </div>

      <button
        className="w-full px-3.5 py-2 text-[12px] text-[var(--abu-text-secondary)] text-left hover:bg-[var(--abu-bg-hover)]"
        onClick={onOpenMain}
      >
        打开主窗口
      </button>

      <button
        className="w-full px-3.5 py-2 text-[12px] text-[var(--abu-text-tertiary)] text-left hover:bg-[var(--abu-bg-hover)]"
        onClick={onClosePet}
      >
        关闭桌宠
      </button>
    </div>
  )
}
