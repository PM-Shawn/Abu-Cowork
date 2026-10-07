// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as renderBare, screen, fireEvent } from '@testing-library/react'
import type { ReactElement } from 'react'
import { DesignSystemProvider } from '@/components/ds/provider'
import { PetContextMenu } from './PetContextMenu'
import type { PetStatus } from '@/core/pet/petStatusBridge'
import { setLanguage } from '@/i18n'

// As the pet window's root renders it (pet/main.tsx).
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider })

describe('PetContextMenu', () => {
  // Reset to zh-CN before every test so the i18n-driven labels resolve to the
  // Chinese assertions below, and a locale-flipping test can't leak into others.
  beforeEach(() => setLanguage('zh-CN'))

  function props(overrides: Partial<{
    status: PetStatus
    onOpenMain: () => void
    onClosePet: () => void
    onDismiss: () => void
  }> = {}) {
    return {
      status: 'idle' as PetStatus,
      onOpenMain: vi.fn(),
      onClosePet: vi.fn(),
      onDismiss: vi.fn(),
      ...overrides,
    }
  }

  it('renders 2 action items', () => {
    render(<PetContextMenu {...props()} />)
    expect(screen.getByText('打开主窗口')).toBeInTheDocument()
    expect(screen.getByText('关闭桌宠')).toBeInTheDocument()
  })

  it('translates menu items when the locale is en-US (regression: pet strings were hardcoded zh)', () => {
    setLanguage('en-US')
    render(<PetContextMenu {...props({ status: 'running' })} />)
    expect(screen.getByText('Open main window')).toBeInTheDocument()
    expect(screen.getByText('Close pet')).toBeInTheDocument()
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })

  it('does not render the removed DND toggle', () => {
    render(<PetContextMenu {...props()} />)
    expect(screen.queryByText('勿扰模式')).not.toBeInTheDocument()
  })

  it('shows idle status label', () => {
    render(<PetContextMenu {...props({ status: 'idle' })} />)
    expect(screen.getByText('空闲')).toBeInTheDocument()
  })

  it('shows running status label', () => {
    render(<PetContextMenu {...props({ status: 'running' })} />)
    expect(screen.getByText('处理中…')).toBeInTheDocument()
  })

  it('shows waiting status label', () => {
    render(<PetContextMenu {...props({ status: 'waiting' })} />)
    expect(screen.getByText('等待输入')).toBeInTheDocument()
  })

  it('shows error status label', () => {
    render(<PetContextMenu {...props({ status: 'error' })} />)
    expect(screen.getByText('遇到问题')).toBeInTheDocument()
  })

  it('shows done status label', () => {
    render(<PetContextMenu {...props({ status: 'done' })} />)
    expect(screen.getByText('完成')).toBeInTheDocument()
  })

  it('calls onOpenMain when open main clicked', () => {
    const onOpenMain = vi.fn()
    render(<PetContextMenu {...props({ onOpenMain })} />)
    fireEvent.click(screen.getByText('打开主窗口'))
    expect(onOpenMain).toHaveBeenCalled()
  })

  it('calls onClosePet when close pet clicked', () => {
    const onClosePet = vi.fn()
    render(<PetContextMenu {...props({ onClosePet })} />)
    fireEvent.click(screen.getByText('关闭桌宠'))
    expect(onClosePet).toHaveBeenCalled()
  })

  it('calls onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn()
    render(<PetContextMenu {...props({ onDismiss })} />)
    fireEvent.click(screen.getByRole('button', { name: '关闭菜单' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('calls onDismiss on click outside', () => {
    const onDismiss = vi.fn()
    render(
      <div>
        <PetContextMenu {...props({ onDismiss })} />
        <div data-testid="outside" />
      </div>
    )
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('does NOT dismiss when mousedown lands on the pet avatar (PetApp owns that toggle)', () => {
    const onDismiss = vi.fn()
    render(
      <div>
        <PetContextMenu {...props({ onDismiss })} />
        <div data-pet-avatar="" data-testid="avatar" />
      </div>
    )
    fireEvent.mouseDown(screen.getByTestId('avatar'))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('each item does its own thing only', () => {
    const handlers = props()
    render(<PetContextMenu {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: '打开主窗口' }))
    expect(handlers.onOpenMain).toHaveBeenCalledTimes(1)
    expect(handlers.onClosePet).not.toHaveBeenCalled()
    expect(handlers.onDismiss).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '关闭桌宠' }))
    expect(handlers.onClosePet).toHaveBeenCalledTimes(1)
    expect(handlers.onOpenMain).toHaveBeenCalledTimes(1)
    expect(handlers.onDismiss).not.toHaveBeenCalled()
  })

  it('does not dismiss on a press inside the menu', () => {
    const onDismiss = vi.fn()
    render(<PetContextMenu {...props({ onDismiss })} />)
    fireEvent.mouseDown(screen.getByText('空闲'))
    fireEvent.mouseDown(screen.getByRole('button', { name: '打开主窗口' }))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('offers three buttons and nothing else that takes a press', () => {
    render(<PetContextMenu {...props()} />)
    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual(['关闭菜单', '打开主窗口', '关闭桌宠'])
  })

  describe('on the design system', () => {
    const box = (container: HTMLElement) => container.firstElementChild as HTMLElement

    // The class list is exact: the window is barely larger than the box, so nothing may be
    // drawn outside it (the border delimits it).
    it('is a raised box with a separator line and the panel radius, and nothing drawn outside it', () => {
      const { container } = render(<PetContextMenu {...props()} />)
      expect([...box(container).classList].sort()).toEqual(['bg-raised', 'border', 'border-separator', 'pb-1', 'rounded-panel', 'w-44'])
    })

    it('writes no legacy variable and no legacy font size', () => {
      const { container } = render(<PetContextMenu {...props({ status: 'running' })} />)
      expect(container.innerHTML).not.toContain('--abu-')
      expect(container.querySelector('[class*="minor"]')).toBeNull()
    })

    it('finds its buttons by name, each a button that is not a submit button', () => {
      render(<PetContextMenu {...props()} />)
      for (const name of ['关闭菜单', '打开主窗口', '关闭桌宠']) {
        expect(screen.getByRole('button', { name })).toHaveAttribute('type', 'button')
      }
    })

    it('draws the close control as a glyph and mounts no tooltip for it', () => {
      render(<PetContextMenu {...props()} />)
      const close = screen.getByRole('button', { name: '关闭菜单' })
      expect(close.querySelector('svg')).toHaveAttribute('stroke-width', '1.5')
      expect(close.textContent).toBe('')
      fireEvent.focus(close)
      expect(close).not.toHaveAttribute('data-state')
    })

    it.each([
      ['idle', 'text-label-tertiary'],
      ['running', 'text-info'],
      ['waiting', 'text-warning'],
      ['error', 'text-danger'],
      ['done', 'text-success'],
    ] as const)('fills the %s dot with the token %s, beside the status words', (status, tone) => {
      const { container } = render(<PetContextMenu {...props({ status })} />)
      const dot = container.querySelector('[data-pet-status-dot]') as HTMLElement
      expect(dot).toHaveClass('bg-current')
      expect(dot).toHaveClass(tone)
      expect(dot.getAttribute('style')).toBeNull()
      expect(dot.nextElementSibling?.textContent).not.toBe('')
    })

    it('shows the status words in the small interface size', () => {
      render(<PetContextMenu {...props()} />)
      expect(screen.getByText('空闲')).toHaveClass('text-ui-sm')
      expect(screen.getByText('空闲')).toHaveClass('text-label-secondary')
    })
  })
})
