import { useEffect } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { usePetDrag } from './usePetDrag'

const { startDragging } = vi.hoisted(() => ({
  startDragging: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({
    startDragging,
    setPosition: vi.fn(() => Promise.resolve()),
    onMoved: vi.fn(() => Promise.resolve(() => {})),
  })),
  primaryMonitor: vi.fn(() => Promise.resolve(null)),
  PhysicalPosition: vi.fn(),
}))

function Harness({ onReady }: { onReady: (consumeDrag: () => boolean) => void }) {
  const { ref, consumeDrag } = usePetDrag<HTMLDivElement>()
  useEffect(() => {
    onReady(consumeDrag)
  }, [onReady, consumeDrag])
  return <div data-testid="pet" ref={ref} />
}

function renderHarness(): { el: HTMLElement; consumeDrag: () => boolean } {
  const holder: { fn: (() => boolean) | null } = { fn: null }
  render(<Harness onReady={(fn) => { holder.fn = fn }} />)
  const el = screen.getByTestId('pet')
  return {
    el,
    consumeDrag: () => {
      if (!holder.fn) throw new Error('consumeDrag not captured')
      return holder.fn()
    },
  }
}

describe('usePetDrag click/drag disambiguation', () => {
  beforeEach(() => {
    startDragging.mockClear()
    localStorage.clear()
  })

  it('a plain click (movement below threshold) never engages the native drag', () => {
    const { el, consumeDrag } = renderHarness()
    fireEvent.mouseDown(el, { button: 0, screenX: 100, screenY: 100 })
    // 3px of trackpad jitter — well under the 10px threshold.
    fireEvent.mouseMove(document, { screenX: 103, screenY: 101 })
    fireEvent.mouseUp(document)
    expect(startDragging).not.toHaveBeenCalled()
    expect(consumeDrag()).toBe(false)
  })

  it('movement past the threshold engages native drag and flags consumeDrag once', () => {
    const { el, consumeDrag } = renderHarness()
    fireEvent.mouseDown(el, { button: 0, screenX: 100, screenY: 100 })
    fireEvent.mouseMove(document, { screenX: 130, screenY: 100 })
    expect(startDragging).toHaveBeenCalledTimes(1)
    expect(consumeDrag()).toBe(true)
    // Flag is consumed — a second read is clean.
    expect(consumeDrag()).toBe(false)
  })

  it('a stale drag flag cannot swallow the next click: mousedown resets it', () => {
    // Regression: if a drag ends without WebKit delivering the synthetic
    // click, consumeDrag() never runs and the flag used to leak into the
    // next interaction, silently eating a genuine click.
    const { el, consumeDrag } = renderHarness()
    fireEvent.mouseDown(el, { button: 0, screenX: 100, screenY: 100 })
    fireEvent.mouseMove(document, { screenX: 150, screenY: 100 })
    expect(startDragging).toHaveBeenCalledTimes(1)
    // No consumeDrag() here — simulate the missing synthetic click.

    // Next interaction: a plain click with no movement.
    fireEvent.mouseDown(el, { button: 0, screenX: 100, screenY: 100 })
    fireEvent.mouseUp(document)
    expect(consumeDrag()).toBe(false)
  })

  it('right-button press never engages drag handling', () => {
    const { el } = renderHarness()
    fireEvent.mouseDown(el, { button: 2, screenX: 100, screenY: 100 })
    fireEvent.mouseMove(document, { screenX: 200, screenY: 200 })
    expect(startDragging).not.toHaveBeenCalled()
  })
})
