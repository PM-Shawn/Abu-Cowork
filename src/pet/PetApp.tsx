import { useState, useCallback, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import abuAvatar from '@/assets/abu-avatar.png'
import { usePetStatus } from './useStatusLight'
import { usePetDrag } from './usePetDrag'
import { PetNotificationBubble, type NotifMode } from './PetNotificationBubble'
import { PetContextMenu } from './PetContextMenu'

const COLLAPSED_W = 80, COLLAPSED_H = 80
const NOTIF_W = 200          // bubble width (fixed in both placements)
const GAP = 8                // avatar ↔ bubble gap
// Side placement sits the avatar and bubble next to each other horizontally.
const SIDE_W = NOTIF_W + GAP + COLLAPSED_W // 288
// Stand-in bubble height before the first real DOM measurement.
const FALLBACK_BUBBLE_H = 60
const MENU_W = 200, MENU_H = 260
// How long the 'done' bubble lingers before we shrink the window back to the
// bare avatar (matches petNotifFade in index.css).
const DONE_LINGER_MS = 6000
// Prefer the bubble ABOVE the avatar; only when the avatar sits within this
// many px of the screen top (no room above) do we place it to the SIDE
// instead — never below, which reads worse. Side grows downward, so it can't
// clip off the top edge.
const MIN_ROOM_ABOVE = 160

type Placement = { mode: 'above' | 'side'; horizontal: 'left' | 'right' }

// Where to put the bubble relative to the avatar, chosen to stay on-screen.
// Default above the avatar; if the avatar is too near the screen top, sit the
// bubble beside it (extending toward screen center) rather than below.
async function getPlacement(): Promise<Placement> {
  const mon = await primaryMonitor()
  const scale = mon?.scaleFactor ?? 1
  const screenW = (mon?.size.width ?? 1600) / scale
  const pos = await getCurrentWindow().outerPosition()
  const avatarTop = pos.y / scale
  const avatarLeft = pos.x / scale
  return {
    mode: avatarTop >= MIN_ROOM_ABOVE ? 'above' : 'side',
    horizontal: avatarLeft < screenW / 2 ? 'right' : 'left',
  }
}

export default function PetApp() {
  const { ref: dragRef, consumeDrag } = usePetDrag<HTMLDivElement>()
  const { status, conversationId, title, summary, waitingKind } = usePetStatus()

  const [menuOpen, setMenuOpen] = useState(false)
  const [expandUp, setExpandUp] = useState(false)     // bubble above avatar (avatar at bottom)
  const [expandLeft, setExpandLeft] = useState(false) // bubble on the left / avatar on the right
  const [sideMode, setSideMode] = useState(false)     // bubble beside avatar (avatar near screen top)
  // Non-waiting notification display mode (collapsed / expanded / replying),
  // driven by the bubble's hover-revealed controls. Owns the window height.
  const [notifMode, setNotifMode] = useState<NotifMode>('collapsed')
  // The 'done' bubble is dismissed (window shrinks) after a linger even
  // though the bridge keeps reporting 'done' until the conversation moves on.
  const [doneDismissed, setDoneDismissed] = useState(false)
  // Whether the pointer is currently over the bubble. Hovering means the user
  // is engaging with it (reading, reaching for the 回复/展开 controls), so the
  // done auto-dismiss must pause — otherwise the 6 s linger can yank the
  // bubble out from under the cursor right as they go to click 回复.
  const [hovered, setHovered] = useState(false)

  // A new featured conversation resets the bubble back to collapsed (a fresh
  // notification shouldn't inherit the previous one's expanded/replying mode).
  useEffect(() => {
    setNotifMode('collapsed')
  }, [conversationId])

  // Reset the done-dismissal whenever we leave the done state.
  useEffect(() => {
    if (status !== 'done') setDoneDismissed(false)
  }, [status])

  // Auto-shrink the lingering done bubble — but only while collapsed AND not
  // hovered, so we don't yank a bubble the user is reading, hovering the
  // controls of, or actively expanding/replying to. Leaving the bubble
  // restarts the linger from scratch.
  useEffect(() => {
    if (status !== 'done' || notifMode !== 'collapsed' || hovered) return
    const t = window.setTimeout(() => setDoneDismissed(true), DONE_LINGER_MS)
    return () => window.clearTimeout(t)
  }, [status, notifMode, hovered])

  const showNotif = status !== 'idle' && !(status === 'done' && doneDismissed)
  // The inline reply row shows for waiting-on-input or when the user clicked
  // 回复 — NOT for an approval-waiting bubble (which just routes to the main
  // window). Drives the window height so we don't reserve empty input space.
  const showReplyInput = notifMode === 'replying' || (status === 'waiting' && waitingKind !== 'approval')

  // Cached placement (only re-detected when a notification first appears — the
  // pet can only move while collapsed) + the bubble's DOM node, whose measured
  // height drives the window size so it fits the content exactly (capped +
  // scrollable inside the bubble, so it never grows off-screen).
  const placementRef = useRef<Placement>({ mode: 'above', horizontal: 'right' })
  const bubbleWrapRef = useRef<HTMLDivElement>(null)
  const prevShowRef = useRef(false)

  // Single source of truth for the (non-menu) window frame: when a
  // notification should show, grow the window to fit it; otherwise shrink
  // back to the bare avatar.
  useEffect(() => {
    if (menuOpen) return // the menu controls the frame while it's open
    let cancelled = false
    const justAppeared = showNotif && !prevShowRef.current
    ;(async () => {
      // Only re-detect placement (async monitor query) + re-anchor (flushSync)
      // when the notification first appears. Expand/reply toggles reuse the
      // cached placement and skip both — that async gap + flushSync between
      // the content re-render and the resize was the click-flicker on those
      // controls. The avatar stays glued to its corner regardless.
      if (justAppeared) {
        const p = await getPlacement()
        if (cancelled) return
        placementRef.current = p
        flushSync(() => {
          setSideMode(p.mode === 'side')
          setExpandUp(p.mode === 'above')
          setExpandLeft(p.horizontal === 'left')
        })
      }
      if (cancelled) return
      const p = placementRef.current
      const side = p.mode === 'side'
      // Measure the bubble's natural height (it renders at a fixed 200px width
      // in both placements) so the window fits the content exactly instead of
      // clipping it at a hard-coded height. The bubble caps its own content
      // height and scrolls internally, so this stays bounded.
      const bubbleH = bubbleWrapRef.current?.offsetHeight ?? FALLBACK_BUBBLE_H
      const w = showNotif ? (side ? SIDE_W : NOTIF_W) : COLLAPSED_W
      const h = showNotif
        ? (side ? Math.max(COLLAPSED_H, bubbleH) : COLLAPSED_H + GAP + bubbleH)
        : COLLAPSED_H
      await invoke('pet_set_frame', {
        width: w,
        height: h,
        // Keep the avatar's on-screen corner fixed as the window grows/shrinks:
        // 'above' grows upward from the avatar's bottom; 'side' grows downward
        // from its top.
        anchorBottom: p.mode === 'above',
        anchorRight: p.horizontal === 'left',
      })
      prevShowRef.current = showNotif
    })()
    return () => { cancelled = true }
  }, [showNotif, status, menuOpen, notifMode, showReplyInput, title, summary, waitingKind])

  const openMenu = useCallback(async () => {
    // Menu always sits below the avatar (avatar at top), but still needs the
    // horizontal check — same off-screen-clipping risk as the notification.
    const p = await getPlacement()
    flushSync(() => {
      setSideMode(false)
      setExpandUp(false) // avatar at top, menu below it
      setExpandLeft(p.horizontal === 'left')
    })
    await invoke('pet_set_frame', {
      width: MENU_W,
      height: MENU_H,
      anchorBottom: false,
      anchorRight: p.horizontal === 'left',
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

  const toggleExpand = useCallback(() => {
    setNotifMode((m) => (m === 'expanded' ? 'collapsed' : 'expanded'))
  }, [])

  const startReply = useCallback(() => {
    setNotifMode('replying')
  }, [])

  const handleReply = useCallback((text: string) => {
    // Inline reply → route to the conversation the notice pointed at (falls
    // back to the active one in App.tsx). Stay on the desktop — the whole
    // point of the inline reply is not to yank focus. Collapse afterwards.
    emit('pet-send-message', { text, conversationId }).catch(console.error)
    setNotifMode('collapsed')
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
    // Side placement keeps the avatar at the top corner; 'above' puts it at the
    // bottom (bubble grows up); menu/collapsed default to the top.
    ...(sideMode ? { top: 0 } : (expandUp ? { bottom: 0 } : { top: 0 })),
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
          ref={bubbleWrapRef}
          style={{
            position: 'absolute',
            // Side: beside the avatar (avatar on the opposite corner, top-aligned).
            // Above/below: stacked, offset past the avatar by one avatar + gap.
            ...(sideMode
              ? { top: 0, ...(expandLeft ? { left: 0 } : { right: 0 }) }
              : {
                  ...(expandUp ? { bottom: COLLAPSED_H + GAP } : { top: COLLAPSED_H + GAP }),
                  ...(expandLeft ? { right: 0 } : { left: 0 }),
                }),
          }}
        >
          <PetNotificationBubble
            status={status}
            title={title}
            summary={summary}
            mode={notifMode}
            waitingKind={waitingKind}
            paused={hovered}
            onHoverChange={setHovered}
            onOpenMain={openMain}
            onToggleExpand={toggleExpand}
            onStartReply={startReply}
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
