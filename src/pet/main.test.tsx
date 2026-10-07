// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

// The pet window is an entry point of its own (pet.html): nothing of the main window's root is
// above it. What its components need from the design system has to be mounted here.
// Registered again before every test: each test loads the entry afresh, and the probe has to
// come from the same module instances as the provider that entry mounts.
async function probeApp() {
  const React = await import('react')
  const { IconButton } = await import('@/components/ds/button')
  const { AppIcons } = await import('@/components/ds/icons')
  const { useConfirm } = await import('@/components/ds/confirm-context')
  return {
    default: function ProbeApp() {
      // Both throw without the provider: the tooltip of an icon button, and the question hook.
      useConfirm()
      return React.createElement(IconButton, { icon: AppIcons.close, label: 'probe' })
    },
  }
}

const DARK = '(prefers-color-scheme: dark)'
const LESS_MOTION = '(prefers-reduced-motion: reduce)'
const MORE_CONTRAST = '(prefers-contrast: more)'

/** Media queries whose answers the test changes; counts who listens to each. */
function fakeMedia(matching: string[]) {
  const lists = new Map<string, { matches: boolean; listeners: Set<() => void> }>()
  vi.stubGlobal('matchMedia', (query: string) => {
    let entry = lists.get(query)
    if (!entry) { entry = { matches: matching.includes(query), listeners: new Set() }; lists.set(query, entry) }
    const held = entry
    return {
      get matches() { return held.matches },
      addEventListener: (_type: string, listener: () => void) => { held.listeners.add(listener) },
      removeEventListener: (_type: string, listener: () => void) => { held.listeners.delete(listener) },
    }
  })
  return {
    turn: (query: string, next: boolean) => {
      const entry = lists.get(query)
      if (!entry) throw new Error(`nobody asked for ${query}`)
      entry.matches = next
      for (const listener of [...entry.listeners]) listener()
    },
    listening: () => [...lists.values()].reduce((sum, entry) => sum + entry.listeners.size, 0),
  }
}

describe('pet window root', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.doMock('./PetApp', probeApp)
    document.body.innerHTML = '<div id="pet-root"></div>'
  })

  afterEach(() => {
    window.dispatchEvent(new Event('pagehide'))
    document.body.innerHTML = ''
    const root = document.documentElement
    root.classList.remove('dark')
    for (const name of ['data-contrast', 'data-transparency', 'data-motion']) root.removeAttribute(name)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the pet inside the design-system provider', async () => {
    fakeMedia([])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await import('./main')
    await waitFor(() => expect(document.querySelector('#pet-root button[aria-label="probe"]')).not.toBeNull())
    expect(errors).not.toHaveBeenCalled()
  })

  // The main window's appearance setting sets the color scheme of the whole application, so the
  // pet window reads the same answer from its own media query.
  it('is dark from the start when the color scheme is dark, before anything is rendered', async () => {
    fakeMedia([DARK])
    // What <html> carried at the moment the entry asked for its root.
    const dark: boolean[] = []
    vi.doMock('react-dom/client', () => ({
      createRoot: () => {
        dark.push(document.documentElement.classList.contains('dark'))
        return { render: () => undefined, unmount: () => undefined }
      },
    }))
    await import('./main')
    vi.doUnmock('react-dom/client')
    expect(dark).toEqual([true])
  })

  it('is light when the color scheme is light, and follows it when it changes, both ways', async () => {
    const media = fakeMedia([])
    await import('./main')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    media.turn(DARK, true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    media.turn(DARK, false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('carries the accessibility appearances of the system, as the main window does', async () => {
    const media = fakeMedia([LESS_MOTION])
    await import('./main')
    const root = document.documentElement
    expect(root.getAttribute('data-motion')).toBe('reduced')
    expect(root.hasAttribute('data-contrast')).toBe(false)
    expect(root.hasAttribute('data-transparency')).toBe(false)
    media.turn(MORE_CONTRAST, true)
    expect(root.getAttribute('data-contrast')).toBe('more')
    media.turn(LESS_MOTION, false)
    expect(root.hasAttribute('data-motion')).toBe(false)
  })

  it('stops listening when the page goes away', async () => {
    const media = fakeMedia([DARK])
    await import('./main')
    // The color scheme and the three appearances.
    expect(media.listening()).toBe(4)
    window.dispatchEvent(new Event('pagehide'))
    expect(media.listening()).toBe(0)
    media.turn(DARK, false)
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})
