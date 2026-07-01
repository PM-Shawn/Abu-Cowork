import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetContextMenu } from './PetContextMenu'
import type { PetStatus } from '@/core/pet/petStatusBridge'

describe('PetContextMenu', () => {
  function props(overrides: Partial<{
    status: PetStatus
    isDnd: boolean
    onToggleDnd: () => void
    onOpenMain: () => void
    onClosePet: () => void
    onDismiss: () => void
  }> = {}) {
    return {
      status: 'idle' as PetStatus,
      isDnd: false,
      onToggleDnd: vi.fn(),
      onOpenMain: vi.fn(),
      onClosePet: vi.fn(),
      onDismiss: vi.fn(),
      ...overrides,
    }
  }

  it('renders 3 action items', () => {
    render(<PetContextMenu {...props()} />)
    expect(screen.getByText('勿扰模式')).toBeInTheDocument()
    expect(screen.getByText('打开主窗口')).toBeInTheDocument()
    expect(screen.getByText('关闭桌宠')).toBeInTheDocument()
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

  it('calls onToggleDnd when DND clicked', () => {
    const onToggleDnd = vi.fn()
    render(<PetContextMenu {...props({ onToggleDnd })} />)
    fireEvent.click(screen.getByText('勿扰模式'))
    expect(onToggleDnd).toHaveBeenCalled()
  })

  it('shows check mark when isDnd=true', () => {
    render(<PetContextMenu {...props({ isDnd: true })} />)
    expect(screen.getByText('✓')).toBeInTheDocument()
  })

  it('hides check mark when isDnd=false', () => {
    render(<PetContextMenu {...props({ isDnd: false })} />)
    expect(screen.queryByText('✓')).not.toBeInTheDocument()
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
})
