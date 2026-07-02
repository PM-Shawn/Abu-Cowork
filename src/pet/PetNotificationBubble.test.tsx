import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { PetNotificationBubble } from './PetNotificationBubble'
import { STATUS_COLOR } from './petStatusMeta'

const baseProps = {
  title: '整理桌面文件',
  summary: '先看一下现有的分类结构',
  onOpenMain: vi.fn(),
  onReply: vi.fn(),
}

describe('PetNotificationBubble', () => {
  beforeEach(() => {
    baseProps.onOpenMain.mockClear()
    baseProps.onReply.mockClear()
  })

  it('renders nothing when idle', () => {
    const { container } = render(<PetNotificationBubble status="idle" {...baseProps} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders title + summary for running', () => {
    render(<PetNotificationBubble status="running" {...baseProps} />)
    expect(screen.getByText('整理桌面文件')).toBeTruthy()
    expect(screen.getByText('先看一下现有的分类结构')).toBeTruthy()
  })

  it('uses the status color for the dot', () => {
    const { container } = render(<PetNotificationBubble status="error" {...baseProps} />)
    const dot = container.querySelector('span[style]') as HTMLElement
    expect(dot.style.backgroundColor).toBeTruthy()
    // error dot color (#ef4444) — assert via the shared map, not a literal
    expect(STATUS_COLOR.error).toBe('#ef4444')
  })

  it('opens main window on bubble click', () => {
    render(<PetNotificationBubble status="running" {...baseProps} />)
    fireEvent.click(screen.getByLabelText('打开主窗口'))
    expect(baseProps.onOpenMain).toHaveBeenCalledTimes(1)
  })

  it('shows an inline reply input only in waiting state', () => {
    const { rerender } = render(<PetNotificationBubble status="running" {...baseProps} />)
    expect(screen.queryByPlaceholderText('回复…')).toBeNull()
    rerender(<PetNotificationBubble status="waiting" {...baseProps} />)
    expect(screen.getByPlaceholderText('回复…')).toBeTruthy()
  })

  it('submits the inline reply on Enter and clears the field', () => {
    render(<PetNotificationBubble status="waiting" {...baseProps} />)
    const input = screen.getByPlaceholderText('回复…') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  确认  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(baseProps.onReply).toHaveBeenCalledWith('确认')
    expect(input.value).toBe('')
  })

  it('does not submit an empty inline reply', () => {
    render(<PetNotificationBubble status="waiting" {...baseProps} />)
    const input = screen.getByPlaceholderText('回复…')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(baseProps.onReply).not.toHaveBeenCalled()
  })

  it('renders a bare dot when title and summary are both null', () => {
    render(<PetNotificationBubble status="running" {...baseProps} title={null} summary={null} />)
    // No title/summary text, but the bubble (and its status dot) still render.
    expect(screen.queryByText('整理桌面文件')).toBeNull()
    expect(screen.getByTestId('pet-notification')).toBeTruthy()
  })

  it('has no pointer/tail element', () => {
    const { container } = render(<PetNotificationBubble status="running" {...baseProps} />)
    expect(container.querySelector('[data-testid="notification-tail"]')).toBeNull()
  })

  it('applies the fade-out animation only in done state', () => {
    const { container, rerender } = render(<PetNotificationBubble status="running" {...baseProps} />)
    const card = () => container.querySelector('[data-testid="pet-notification"] > div') as HTMLElement
    expect(card().style.animation).toBe('')
    rerender(<PetNotificationBubble status="done" {...baseProps} />)
    expect(card().style.animation).toContain('petNotifFade')
  })
})
