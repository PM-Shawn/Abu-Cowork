// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

// The pet window is an entry point of its own (pet.html): nothing of the main window's root is
// above it. What its components need from the design system has to be mounted here.
vi.mock('./PetApp', async () => {
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
})

describe('pet window root', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('renders the pet inside the design-system provider', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    document.body.innerHTML = '<div id="pet-root"></div>'
    await import('./main')
    await waitFor(() => expect(document.querySelector('#pet-root button[aria-label="probe"]')).not.toBeNull())
    expect(errors).not.toHaveBeenCalled()
  })
})
