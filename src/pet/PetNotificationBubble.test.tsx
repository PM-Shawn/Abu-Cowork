import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'
import { PetNotificationBubble } from './PetNotificationBubble'
import { STATUS_COLOR } from './petStatusMeta'
import { setLanguage } from '@/i18n'

const baseProps = {
  title: '整理桌面文件',
  summary: '先看一下现有的分类结构',
  mode: 'collapsed' as const,
  onHoverChange: vi.fn(),
  onOpenMain: vi.fn(),
  onToggleExpand: vi.fn(),
  onStartReply: vi.fn(),
  onReply: vi.fn(),
}

describe('PetNotificationBubble', () => {
  beforeEach(() => {
    // Reset to zh-CN so i18n-driven labels resolve to the Chinese assertions.
    setLanguage('zh-CN')
    baseProps.onHoverChange.mockClear()
    baseProps.onOpenMain.mockClear()
    baseProps.onToggleExpand.mockClear()
    baseProps.onStartReply.mockClear()
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

  it('shows the inline reply input in waiting state and in replying mode', () => {
    const { rerender } = render(<PetNotificationBubble status="running" {...baseProps} />)
    expect(screen.queryByPlaceholderText('回复…')).toBeNull()
    rerender(<PetNotificationBubble status="waiting" {...baseProps} />)
    expect(screen.getByPlaceholderText('回复…')).toBeTruthy()
    rerender(<PetNotificationBubble status="running" {...baseProps} mode="replying" />)
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

  it('exposes a bottom 回复 button in non-waiting states, but not in waiting or replying', () => {
    const { rerender } = render(<PetNotificationBubble status="running" {...baseProps} />)
    fireEvent.click(screen.getByLabelText('回复'))
    expect(baseProps.onStartReply).toHaveBeenCalledTimes(1)

    // waiting already shows the input → no 回复 button
    rerender(<PetNotificationBubble status="waiting" {...baseProps} />)
    expect(screen.queryByLabelText('回复')).toBeNull()
    // already replying → no 回复 button
    rerender(<PetNotificationBubble status="running" {...baseProps} mode="replying" />)
    expect(screen.queryByLabelText('回复')).toBeNull()
  })

  it('keeps the 回复 button in the layout but CSS-hidden until hover (no resize jank)', () => {
    render(<PetNotificationBubble status="running" {...baseProps} />)
    const wrap = screen.getByLabelText('回复').parentElement as HTMLElement
    expect(wrap.className).toContain('opacity-0')
    expect(wrap.className).toContain('group-hover:opacity-100')
  })

  it('toggles expand via the chevron control', () => {
    const { rerender } = render(<PetNotificationBubble status="running" {...baseProps} />)
    fireEvent.click(screen.getByLabelText('展开'))
    expect(baseProps.onToggleExpand).toHaveBeenCalledTimes(1)
    // expanded → the control flips to 收起
    rerender(<PetNotificationBubble status="running" {...baseProps} mode="expanded" />)
    expect(screen.getByLabelText('收起')).toBeTruthy()
  })

  it('wraps the full text when expanded, truncates when collapsed', () => {
    const { rerender } = render(<PetNotificationBubble status="running" {...baseProps} />)
    const line = () => screen.getByText('整理桌面文件').closest('span') as HTMLElement
    expect(line().className).toContain('truncate')
    rerender(<PetNotificationBubble status="running" {...baseProps} mode="expanded" />)
    expect(line().className).toContain('whitespace-normal')
    expect(line().className).not.toContain('truncate')
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

  it('fades out only for a collapsed done bubble, not while expanded', () => {
    const { container, rerender } = render(<PetNotificationBubble status="running" {...baseProps} />)
    const card = () => container.querySelector('[data-testid="pet-notification"] > div') as HTMLElement
    expect(card().style.animation).toBe('')
    rerender(<PetNotificationBubble status="done" {...baseProps} />)
    expect(card().style.animation).toContain('petNotifFade')
    // expanded done bubble must not fade out from under the user
    rerender(<PetNotificationBubble status="done" {...baseProps} mode="expanded" />)
    expect(card().style.animation).toBe('')
  })

  it('approval waiting shows 需要授权 and no reply input, routing to the main window', () => {
    render(<PetNotificationBubble status="waiting" {...baseProps} waitingKind="approval" />)
    // No inline text reply for an approval — typing can't grant a permission.
    expect(screen.queryByPlaceholderText('回复…')).toBeNull()
    expect(screen.getByText('需要授权')).toBeTruthy()
    // Clicking the bubble routes to the main window (where the real dialog is).
    fireEvent.click(screen.getByLabelText('打开主窗口'))
    expect(baseProps.onOpenMain).toHaveBeenCalledTimes(1)
  })

  it('approval waiting exposes neither a 回复 nor an expand control', () => {
    render(<PetNotificationBubble status="waiting" {...baseProps} waitingKind="approval" />)
    expect(screen.queryByLabelText('回复')).toBeNull()
    expect(screen.queryByLabelText('展开')).toBeNull()
    expect(screen.queryByLabelText('收起')).toBeNull()
  })

  it('input waiting still shows the reply box (not treated as approval)', () => {
    render(<PetNotificationBubble status="waiting" {...baseProps} waitingKind="input" />)
    expect(screen.getByPlaceholderText('回复…')).toBeTruthy()
    expect(screen.queryByText('需要授权')).toBeNull()
  })

  it('suppresses the collapsed-done fade while paused (hovered)', () => {
    const { container, rerender } = render(<PetNotificationBubble status="done" {...baseProps} />)
    const card = () => container.querySelector('[data-testid="pet-notification"] > div') as HTMLElement
    expect(card().style.animation).toContain('petNotifFade')
    // paused (parent hovering) → no fade, so the bubble stays put under the cursor
    rerender(<PetNotificationBubble status="done" {...baseProps} paused />)
    expect(card().style.animation).toBe('')
  })

  it('reports hover enter/leave so the parent can pause auto-dismiss', () => {
    const { container } = render(<PetNotificationBubble status="done" {...baseProps} />)
    const root = container.querySelector('[data-testid="pet-notification"]') as HTMLElement
    fireEvent.mouseEnter(root)
    expect(baseProps.onHoverChange).toHaveBeenLastCalledWith(true)
    fireEvent.mouseLeave(root)
    expect(baseProps.onHoverChange).toHaveBeenLastCalledWith(false)
  })
})
