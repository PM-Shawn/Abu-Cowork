import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetContextMenu } from './PetContextMenu'
import type { PetStatus } from '@/core/pet/petStatusBridge'
import { setLanguage } from '@/i18n'

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
})
