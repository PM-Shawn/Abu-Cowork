import { useEffect, useRef } from 'react'
import type { PetStatus } from '@/core/pet/petStatusBridge'
import { STATUS_COLOR } from './petStatusMeta'
import { Button } from '@/components/ds/button'
import { Icon } from '@/components/ds/icon'
import { AppIcons } from '@/components/ds/icons'
import { Pressable } from '@/components/ds/pressable'
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
    // No box-shadow: the pet window is transparent and barely larger than this
    // box, so a shadow would be cut off at the window edge and drawn straight
    // onto the desktop. The border delimits it. The close control is a named
    // `Pressable` with no tooltip, for the same lack of room.
    <div
      ref={menuRef}
      className="w-44 rounded-panel border border-separator bg-raised pb-1"
    >
      <div className="flex items-center gap-2 border-b border-separator px-3 py-2">
        <div
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: STATUS_COLOR[status] }}
        />
        <span className="flex-1 text-ui-sm text-label-secondary">{t.pet.status[status]}</span>
        <Pressable
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-control text-label-tertiary hover:text-label"
          onClick={onDismiss}
          aria-label={t.pet.closeMenu}
        >
          <Icon icon={AppIcons.close} size="sm" />
        </Pressable>
      </div>

      <div className="flex flex-col gap-1 px-1 pt-1">
        <Button variant="plain" size="sm" className="w-full justify-start" onClick={onOpenMain}>
          {t.pet.openMain}
        </Button>
        <Button variant="plain" size="sm" className="w-full justify-start" onClick={onClosePet}>
          {t.pet.closePet}
        </Button>
      </div>
    </div>
  )
}
