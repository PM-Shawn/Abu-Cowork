import { useRef, useState, useCallback } from 'react'
import { getCurrentWindow, LogicalSize, PhysicalPosition, primaryMonitor } from '@tauri-apps/api/window'
import { emit } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import abuAvatar from '@/assets/abu-avatar.png'
import StatusLight from './StatusLight'
import { useStatusLight } from './useStatusLight'
import { usePetDrag } from './usePetDrag'
import { PetInputBubble } from './PetInputBubble'
import { PetContextMenu } from './PetContextMenu'
import { useSettingsStore } from '@/stores/settingsStore'

type ExpandState = 'collapsed' | 'bubble' | 'menu'

const COLLAPSED_W = 80, COLLAPSED_H = 80
const BUBBLE_W = 200, BUBBLE_H = 180
const MENU_W = 200, MENU_H = 260
const EXPAND_OFFSET_PX = 100

async function getExpandDir(): Promise<'up' | 'down'> {
  const mon = await primaryMonitor()
  const scale = mon?.scaleFactor ?? 1
  const screenH = (mon?.size.height ?? 900) / scale
  const pos = await getCurrentWindow().outerPosition()
  return pos.y / scale < screenH / 2 ? 'down' : 'up'
}

export default function PetApp() {
  const dragRef = usePetDrag<HTMLDivElement>()
  const status = useStatusLight()
  const isDnd = useSettingsStore((s) => s.dndMode ?? false)
  const setDndMode = useSettingsStore((s) => s.setDndMode)

  const [expandState, setExpandState] = useState<ExpandState>('collapsed')
  const [expandUp, setExpandUp] = useState(false)
  const savedPhysPos = useRef<{ x: number; y: number } | null>(null)
  const clickTimer = useRef<number | null>(null)
  const expanding = useRef(false)

  const collapse = useCallback(async () => {
    if (expanding.current) return
    await getCurrentWindow().setSize(new LogicalSize(COLLAPSED_W, COLLAPSED_H))
    if (savedPhysPos.current) {
      await getCurrentWindow().setPosition(
        new PhysicalPosition(savedPhysPos.current.x, savedPhysPos.current.y)
      )
      savedPhysPos.current = null
    }
    setExpandState('collapsed')
  }, [])

  const openBubble = useCallback(async () => {
    expanding.current = true
    try {
      const dir = await getExpandDir()
      setExpandUp(dir === 'up')
      const phys = await getCurrentWindow().outerPosition()
      const scale = (await primaryMonitor())?.scaleFactor ?? 1
      savedPhysPos.current = { x: phys.x, y: phys.y }
      if (dir === 'up') {
        await getCurrentWindow().setPosition(
          new PhysicalPosition(phys.x, phys.y - Math.round(EXPAND_OFFSET_PX * scale))
        )
      }
      await getCurrentWindow().setSize(new LogicalSize(BUBBLE_W, BUBBLE_H))
      setExpandState('bubble')
    } finally {
      expanding.current = false
    }
  }, [])

  const openMenu = useCallback(async () => {
    expanding.current = true
    try {
      await getCurrentWindow().setSize(new LogicalSize(MENU_W, MENU_H))
      setExpandState('menu')
    } finally {
      expanding.current = false
    }
  }, [])

  const handleAvatarClick = useCallback(() => {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
      // double-click detected
      if (expandState !== 'collapsed') { collapse(); return }
      invoke('pet_focus_main').catch(console.error)
      return
    }
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null
      if (expandState !== 'collapsed') { collapse(); return }
      openBubble()
    }, 250)
  }, [expandState, collapse, openBubble])

  const handleRightClick = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    if (expandState !== 'collapsed') await collapse()
    openMenu()
  }, [expandState, collapse, openMenu])

  const handleSend = useCallback(async (text: string) => {
    await emit('pet-send-message', { text })
    collapse()
  }, [collapse])

  const handleClosePet = useCallback(async () => {
    await collapse()
    invoke('pet_hide').catch(console.error)
  }, [collapse])

  const isDraggable = expandState === 'collapsed'
  const avatarTop = expandUp && expandState === 'bubble' ? BUBBLE_H - COLLAPSED_H : 0
  const avatarLeft = expandState === 'menu' ? (MENU_W - COLLAPSED_W) / 2 : 0

  return (
    <div
      style={{ width: '100%', height: '100%', background: 'transparent', position: 'relative' }}
      onContextMenu={handleRightClick}
    >
      <div
        ref={isDraggable ? dragRef : undefined}
        style={{
          width: COLLAPSED_W, height: COLLAPSED_H,
          position: 'absolute',
          top: avatarTop, left: avatarLeft,
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
            filter: isDnd ? 'grayscale(100%)' : 'none',
          }}
        />
        <StatusLight status={isDnd ? 'idle' : status} />
      </div>

      {expandState === 'bubble' && (
        <div style={{ position: 'absolute', top: expandUp ? 0 : COLLAPSED_H + 8, left: 0 }}>
          <PetInputBubble expandUp={expandUp} onSend={handleSend} onDismiss={collapse} />
        </div>
      )}

      {expandState === 'menu' && (
        <div style={{ position: 'absolute', top: COLLAPSED_H + 8, left: 10 }}>
          <PetContextMenu
            status={isDnd ? 'idle' : status}
            isDnd={isDnd}
            onToggleDnd={() => setDndMode(!isDnd)}
            onOpenMain={() => { invoke('pet_focus_main').catch(console.error); collapse() }}
            onClosePet={handleClosePet}
            onDismiss={collapse}
          />
        </div>
      )}
    </div>
  )
}
