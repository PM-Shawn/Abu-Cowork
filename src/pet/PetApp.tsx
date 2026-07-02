import { useState, useCallback, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import abuAvatar from '@/assets/abu-avatar.png'
import { usePetStatus } from './useStatusLight'
import { usePetDrag } from './usePetDrag'
import { PetNotificationBubble } from './PetNotificationBubble'
import { PetContextMenu } from './PetContextMenu'

const COLLAPSED_W = 80, COLLAPSED_H = 80
// Notification tray sizes: avatar (80) + gap (8) + single-line bubble, and
// a taller variant for the waiting state's inline reply input.
const NOTIF_W = 200, NOTIF_H = 148
const NOTIF_WAITING_H = 196
const MENU_W = 200, MENU_H = 260
// How long the 'done' bubble lingers before we shrink the window back to the
// bare avatar (matches petNotifFade in index.css).
const DONE_LINGER_MS = 6000

// The pet spawns at the bottom-right of the screen by default (see
// pet_show in pet.rs), so a popup that only ever grows right/down would
// routinely push part of itself past the screen edge and get clipped —
// there's nothing to render out there. Pick a direction per axis based on
// which half of the screen the pet is currently in, mirroring how a
// tooltip/popover flips itself to stay on screen.
async function getExpandDir(): Promise<{ vertical: 'up' | 'down'; horizontal: 'left' | 'right' }> {
  const mon = await primaryMonitor()
  const scale = mon?.scaleFactor ?? 1
  const screenW = (mon?.size.width ?? 1600) / scale
  const screenH = (mon?.size.height ?? 900) / scale
  const pos = await getCurrentWindow().outerPosition()
  return {
    vertical: pos.y / scale < screenH / 2 ? 'down' : 'up',
    horizontal: pos.x / scale < screenW / 2 ? 'right' : 'left',
  }
}

export default function PetApp() {
  const { ref: dragRef, consumeDrag } = usePetDrag<HTMLDivElement>()
  const { status, conversationId, title, summary } = usePetStatus()

  const [menuOpen, setMenuOpen] = useState(false)
  const [expandUp, setExpandUp] = useState(false)
  const [expandLeft, setExpandLeft] = useState(false)
  // The 'done' bubble is dismissed (window shrinks) after a linger even
  // though the bridge keeps reporting 'done' until the conversation moves on.
  const [doneDismissed, setDoneDismissed] = useState(false)

  // Reset the done-dismissal whenever we leave the done state.
  useEffect(() => {
    if (status !== 'done') setDoneDismissed(false)
  }, [status])

  // Auto-shrink the lingering done bubble.
  useEffect(() => {
    if (status !== 'done') return
    const t = window.setTimeout(() => setDoneDismissed(true), DONE_LINGER_MS)
    return () => window.clearTimeout(t)
  }, [status])

  const showNotif = status !== 'idle' && !(status === 'done' && doneDismissed)

  // Single source of truth for the (non-menu) window frame: when a
  // notification should show, grow the window to fit it; otherwise shrink
  // back to the bare avatar. The anchor is committed to the DOM *before*
  // the native resize (flushSync) so the avatar stays glued to whichever
  // corner the window grows from and never jumps — this is the atomic
  // resize that fixed the click flicker (see pet_set_frame in pet.rs).
  useEffect(() => {
    if (menuOpen) return // the menu controls the frame while it's open
    let cancelled = false
    ;(async () => {
      const dir = await getExpandDir()
      if (cancelled) return
      const w = showNotif ? NOTIF_W : COLLAPSED_W
      const h = showNotif ? (status === 'waiting' ? NOTIF_WAITING_H : NOTIF_H) : COLLAPSED_H
      flushSync(() => {
        setExpandUp(dir.vertical === 'up')
        setExpandLeft(dir.horizontal === 'left')
      })
      await invoke('pet_set_frame', {
        width: w,
        height: h,
        // Anchor the edge the window grows from / shrinks toward so the
        // avatar's on-screen corner is fixed across expand and collapse.
        anchorBottom: dir.vertical === 'up',
        anchorRight: dir.horizontal === 'left',
      })
    })()
    return () => { cancelled = true }
  }, [showNotif, status, menuOpen])

  const openMenu = useCallback(async () => {
    // Menu always expands downward, but still needs the horizontal check —
    // same off-screen-clipping risk as the notification.
    const dir = await getExpandDir()
    flushSync(() => {
      setExpandUp(false)
      setExpandLeft(dir.horizontal === 'left')
    })
    await invoke('pet_set_frame', {
      width: MENU_W,
      height: MENU_H,
      anchorBottom: false,
      anchorRight: dir.horizontal === 'left',
    })
    setMenuOpen(true)
  }, [])

  const closeMenu = useCallback(() => {
    // Just drop out of menu mode — the frame effect re-applies the
    // notification/collapsed frame based on the current status.
    setMenuOpen(false)
  }, [])

  const openMain = useCallback(() => {
    invoke('pet_focus_main').catch(console.error)
  }, [])

  const handleAvatarClick = useCallback(() => {
    // WebKit still fires a synthetic `click` after mousedown+mouseup on the
    // same element even when a real drag happened in between (startDragging()
    // hands the actual movement off to the native window manager). Suppress
    // it here so a drag-release doesn't also trigger a click action.
    if (consumeDrag()) return
    // Codex-style single interaction: clicking the avatar opens the main
    // window (no single/double-click distinction). If the right-click menu
    // is open, a left-click just dismisses it.
    if (menuOpen) { closeMenu(); return }
    openMain()
  }, [consumeDrag, menuOpen, closeMenu, openMain])

  const handleRightClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    if (!menuOpen) await openMenu()
  }, [menuOpen, openMenu])

  const handleReply = useCallback((text: string) => {
    // waiting-state inline reply → route to the conversation the notice
    // pointed at (falls back to the active one in App.tsx). Stay on the
    // desktop — the whole point of the inline reply is not to yank focus.
    emit('pet-send-message', { text, conversationId }).catch(console.error)
  }, [conversationId])

  const handleClosePet = useCallback(() => {
    setMenuOpen(false)
    invoke('pet_hide').catch(console.error)
    // Notify the main window so its Settings toggle stays in sync — this
    // window's own settingsStore instance isn't shared in-memory with main.
    emit('pet-open-state-changed', { open: false }).catch(console.error)
  }, [])

  // Draggable whenever the menu isn't open (both idle and while a
  // notification is showing — the user can still reposition the pet).
  const isDraggable = !menuOpen
  // The avatar is glued to whichever corner of the window the frame effect
  // just anchored (top/bottom independently from left/right — see
  // pet_set_frame), so the webview's own relayout keeps the avatar on that
  // corner during the native resize, with no JS repositioning step.
  const avatarAnchor = {
    ...(expandUp ? { bottom: 0 } : { top: 0 }),
    ...(expandLeft ? { right: 0 } : { left: 0 }),
  }

  return (
    <div
      style={{ width: '100%', height: '100%', background: 'transparent', position: 'relative' }}
      onContextMenu={handleRightClick}
    >
      <div
        ref={isDraggable ? dragRef : undefined}
        data-pet-avatar=""
        style={{
          width: COLLAPSED_W, height: COLLAPSED_H,
          position: 'absolute',
          ...avatarAnchor,
          cursor: isDraggable ? 'grab' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onClick={handleAvatarClick}
      >
        <img
          src={abuAvatar}
          alt="Abu"
          draggable={false}
          style={{
            width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none',
          }}
        />
      </div>

      {showNotif && !menuOpen && (
        <div
          style={{
            position: 'absolute',
            ...(expandUp ? { bottom: COLLAPSED_H + 8 } : { top: COLLAPSED_H + 8 }),
            ...(expandLeft ? { right: 0 } : { left: 0 }),
          }}
        >
          <PetNotificationBubble
            status={status}
            title={title}
            summary={summary}
            onOpenMain={openMain}
            onReply={handleReply}
          />
        </div>
      )}

      {menuOpen && (
        <div
          style={{
            position: 'absolute',
            top: COLLAPSED_H + 8,
            ...(expandLeft ? { right: 10 } : { left: 10 }),
          }}
        >
          <PetContextMenu
            status={status}
            onOpenMain={() => { openMain(); closeMenu() }}
            onClosePet={handleClosePet}
            onDismiss={closeMenu}
          />
        </div>
      )}
    </div>
  )
}
