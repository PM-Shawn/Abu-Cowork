// @vitest-environment happy-dom
/**
 * The pet stays where the user left it across every frame change PetApp asks
 * the host for. PetApp runs for real; the host side of `pet_set_frame` is the
 * shell's own geometry (electron/petFrame.cjs) applied to a window model, so a
 * frame request is judged by where it actually puts the window.
 */
import { createElement } from 'react'
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { render, fireEvent, screen, act, waitFor, cleanup } from '@testing-library/react'
import { resolvePetFrame } from '../../electron/petFrame.cjs'
import { useSettingsStore } from '@/stores/settingsStore'
import type { PetStatusPayload } from '@/core/pet/petStatusBridge'
import PetApp from './PetApp'

interface Rect { x: number; y: number; width: number; height: number }
interface Frame { bounds: Rect; avatarOffset: { x: number; y: number } }

const WORK_AREA: Rect = { x: 0, y: 33, width: 1512, height: 949 }
const BARE = { width: 80, height: 80 }
const BUBBLE_H = 63

const host = vi.hoisted(() => ({
  // A 1512x982 display at scale factor 2; the window API speaks physical px.
  scale: 2,
  screen: { width: 1512, height: 982 },
  frame: null as unknown as { bounds: { x: number; y: number; width: number; height: number }; avatarOffset: { x: number; y: number } },
  setFrame: (_args: unknown): void => {},
  status: null as ((event: { payload: unknown }) => void) | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    if (cmd === 'pet_set_frame') host.setFrame(args)
    return null
  }),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    outerPosition: vi.fn(async () => ({
      x: host.frame.bounds.x * host.scale,
      y: host.frame.bounds.y * host.scale,
    })),
    onMoved: vi.fn(() => Promise.resolve(() => {})),
    setPosition: vi.fn(() => Promise.resolve()),
    startDragging: vi.fn(() => Promise.resolve()),
  })),
  primaryMonitor: vi.fn(async () => ({
    scaleFactor: host.scale,
    size: { width: host.screen.width * host.scale, height: host.screen.height * host.scale },
  })),
  PhysicalPosition: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    if (event === 'pet-status-update') host.status = handler
    return Promise.resolve(() => {})
  }),
}))

host.setFrame = (args) => {
  host.frame = resolvePetFrame(
    host.frame,
    args as { width: number; height: number; anchorBottom: boolean; anchorRight: boolean },
    () => WORK_AREA,
  ) as Frame
}

function avatar(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-pet-avatar]')
  if (!el) throw new Error('avatar not rendered')
  return el
}

/** Where the avatar is on screen: the window's origin plus the corner PetApp glued it to. */
function avatarOnScreen(): { x: number; y: number } {
  const { bounds } = host.frame
  const style = avatar().style
  return {
    x: bounds.x + (style.right ? bounds.width - BARE.width : 0),
    y: bounds.y + (style.bottom ? bounds.height - BARE.height : 0),
  }
}

async function mountPetAt(home: { x: number; y: number }): Promise<void> {
  host.frame = { bounds: { ...home, ...BARE }, avatarOffset: { x: 0, y: 0 } }
  render(createElement(PetApp))
  await waitFor(() => expect(host.status).not.toBeNull())
  await act(async () => {})
  expect(host.frame.bounds).toEqual({ ...home, ...BARE })
}

async function openMenu(): Promise<void> {
  await act(async () => {
    fireEvent.contextMenu(avatar())
  })
  await screen.findByLabelText('Close menu')
}

async function setStatus(status: 'idle' | 'running'): Promise<void> {
  const payload: PetStatusPayload =
    status === 'idle'
      ? { status, conversationId: null, title: null, summary: null, waitingKind: null }
      : { status, conversationId: 'c1', title: 'Task', summary: 'Summary', waitingKind: null }
  await act(async () => {
    host.status?.({ payload })
  })
}

const CLOSERS: Record<string, () => void> = {
  'the close button': () => fireEvent.click(screen.getByLabelText('Close menu')),
  'a press outside the menu': () => fireEvent.mouseDown(document.body),
  'the "Open main window" item': () => fireEvent.click(screen.getByText('Open main window')),
  'a click on the avatar': () => fireEvent.click(avatar()),
}

async function closeMenu(closer: () => void): Promise<void> {
  await act(async () => {
    closer()
  })
  await waitFor(() => expect(screen.queryByLabelText('Close menu')).toBeNull())
}

const SPOTS = [
  { name: 'left half', home: { x: 200, y: 333 }, clamped: false },
  { name: 'right half', home: { x: 1170, y: 333 }, clamped: false },
  { name: 'left half, near the bottom edge', home: { x: 200, y: 856 }, clamped: true },
  { name: 'right half, near the bottom edge', home: { x: 1170, y: 856 }, clamped: true },
  { name: 'docked on the left edge', home: { x: -32, y: 333 }, clamped: true },
  { name: 'docked on the right edge', home: { x: 1464, y: 333 }, clamped: true },
]

describe('PetApp window frame', () => {
  let offsetHeight: PropertyDescriptor | undefined

  beforeAll(() => {
    // happy-dom lays nothing out; give the bubble the height it measures in the app.
    offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => BUBBLE_H })
  })

  afterAll(() => {
    if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
  })

  beforeEach(() => {
    cleanup()
    host.status = null
    localStorage.clear()
    useSettingsStore.setState({ petPosition: null })
  })

  describe('right-click menu', () => {
    for (const spot of SPOTS) {
      for (const [closerName, closer] of Object.entries(CLOSERS)) {
        it(`closing with ${closerName} restores the bounds the pet had: ${spot.name}`, async () => {
          await mountPetAt(spot.home)
          await openMenu()
          expect(host.frame.bounds).toMatchObject({ width: 200, height: 260 })
          expect(host.frame.bounds.x).toBeGreaterThanOrEqual(WORK_AREA.x)
          expect(host.frame.bounds.x + 200).toBeLessThanOrEqual(WORK_AREA.x + WORK_AREA.width)
          expect(host.frame.bounds.y + 260).toBeLessThanOrEqual(WORK_AREA.y + WORK_AREA.height)
          if (!spot.clamped) expect(avatarOnScreen()).toEqual(spot.home)

          await closeMenu(closer)
          await waitFor(() => expect(host.frame.bounds).toEqual({ ...spot.home, ...BARE }))
          expect(avatarOnScreen()).toEqual(spot.home)
        })
      }
    }

    it('opening and closing it again and again never moves the pet', async () => {
      const home = { x: 1170, y: 856 }
      await mountPetAt(home)
      for (let i = 0; i < 4; i++) {
        await openMenu()
        await closeMenu(CLOSERS['the close button'])
        await waitFor(() => expect(host.frame.bounds).toEqual({ ...home, ...BARE }))
      }
    })
  })

  describe('notification bubble', () => {
    for (const spot of [
      { name: 'above, left half', home: { x: 200, y: 333 }, size: { width: 200, height: 88 + BUBBLE_H } },
      { name: 'above, right half', home: { x: 1170, y: 333 }, size: { width: 200, height: 88 + BUBBLE_H } },
      { name: 'beside, left half', home: { x: 200, y: 73 }, size: { width: 288, height: 80 } },
      { name: 'beside, right half', home: { x: 1170, y: 73 }, size: { width: 288, height: 80 } },
    ]) {
      it(`grows and shrinks around the avatar: ${spot.name}`, async () => {
        await mountPetAt(spot.home)
        await setStatus('running')
        await waitFor(() => expect(host.frame.bounds).toMatchObject(spot.size))
        expect(avatarOnScreen()).toEqual(spot.home)
        await setStatus('idle')
        await waitFor(() => expect(host.frame.bounds).toEqual({ ...spot.home, ...BARE }))
      })

      it(`the menu opened over it keeps the avatar in place: ${spot.name}`, async () => {
        await mountPetAt(spot.home)
        await setStatus('running')
        await waitFor(() => expect(host.frame.bounds).toMatchObject(spot.size))

        await openMenu()
        expect(host.frame.bounds).toMatchObject({ width: 200, height: 260 })
        expect(avatarOnScreen()).toEqual(spot.home)

        await closeMenu(CLOSERS['the close button'])
        await waitFor(() => expect(host.frame.bounds).toMatchObject(spot.size))
        expect(avatarOnScreen()).toEqual(spot.home)

        await setStatus('idle')
        await waitFor(() => expect(host.frame.bounds).toEqual({ ...spot.home, ...BARE }))
      })

      it(`arriving while the menu is open keeps the avatar in place: ${spot.name}`, async () => {
        await mountPetAt(spot.home)
        await openMenu()
        await setStatus('running')
        expect(host.frame.bounds).toMatchObject({ width: 200, height: 260 })

        await closeMenu(CLOSERS['the close button'])
        await waitFor(() => expect(host.frame.bounds).toMatchObject(spot.size))
        expect(avatarOnScreen()).toEqual(spot.home)

        await setStatus('idle')
        await waitFor(() => expect(host.frame.bounds).toEqual({ ...spot.home, ...BARE }))
      })
    }
  })
})
