// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as renderBare, fireEvent, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { DesignSystemProvider } from '@/components/ds/provider'
import { PetNotificationBubble } from './PetNotificationBubble'
import { STATUS_TONE } from './petStatusMeta'
import { setLanguage } from '@/i18n'

// As the pet window's root renders it (pet/main.tsx).
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider })

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

  // The dot is filled with the text color of its status token, so it has the contrast that
  // token is checked for on the raised surface, in both appearances.
  it.each([
    ['running', 'text-info'],
    ['waiting', 'text-warning'],
    ['error', 'text-danger'],
    ['done', 'text-success'],
  ] as const)('fills the dot of a %s bubble with the status token %s', (status, tone) => {
    const { container } = render(<PetNotificationBubble status={status} {...baseProps} />)
    const dot = container.querySelector('[data-pet-status-dot]') as HTMLElement
    expect(dot).toHaveClass('bg-current')
    expect(dot).toHaveClass(tone)
    expect(dot.getAttribute('style')).toBeNull()
    expect(STATUS_TONE[status]).toBe(tone)
  })

  it('names one token per status, the idle one a label color', () => {
    expect(STATUS_TONE).toEqual({ idle: 'text-label-tertiary', running: 'text-info', waiting: 'text-warning', error: 'text-danger', done: 'text-success' })
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

  it('puts the focus in the reply field when it shows', () => {
    const { rerender } = render(<PetNotificationBubble status="waiting" {...baseProps} />)
    expect(screen.getByPlaceholderText('回复…')).toHaveFocus()
    rerender(<PetNotificationBubble status="running" {...baseProps} />)
    rerender(<PetNotificationBubble status="running" {...baseProps} mode="replying" />)
    expect(screen.getByPlaceholderText('回复…')).toHaveFocus()
  })

  it('sends once for an Enter that is held down', () => {
    render(<PetNotificationBubble status="waiting" {...baseProps} />)
    const input = screen.getByPlaceholderText('回复…') as HTMLInputElement
    fireEvent.change(input, { target: { value: '确认' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    for (let i = 0; i < 5; i += 1) fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', repeat: true })
    expect(baseProps.onReply).toHaveBeenCalledTimes(1)
    expect(baseProps.onReply).toHaveBeenCalledWith('确认')
  })

  it('sends on Enter only: no other key sends', () => {
    render(<PetNotificationBubble status="waiting" {...baseProps} />)
    const input = screen.getByPlaceholderText('回复…') as HTMLInputElement
    fireEvent.change(input, { target: { value: '确认' } })
    fireEvent.keyDown(input, { key: ' ', code: 'Space' })
    fireEvent.keyDown(input, { key: 'Tab', code: 'Tab' })
    fireEvent.keyDown(input, { key: 'Process', code: 'Enter', keyCode: 229 })
    expect(baseProps.onReply).not.toHaveBeenCalled()
    expect(input.value).toBe('确认')
  })

  // The Enter that confirms a composition arrives as `Enter` with the composing marks: Chromium
  // sets `isComposing`, Windows input methods report key code 229, some with no flag at all.
  it.each([
    ['the composing flag and key code 229', { isComposing: true, keyCode: 229 }],
    ['the composing flag alone', { isComposing: true, keyCode: 13 }],
    ['key code 229 alone', { isComposing: false, keyCode: 229 }],
  ])('does not send on the Enter that confirms an input-method composition (%s)', (_marks, marks) => {
    render(<PetNotificationBubble status="waiting" {...baseProps} />)
    const input = screen.getByPlaceholderText('回复…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'nihao' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', ...marks })
    expect(baseProps.onReply).not.toHaveBeenCalled()
    expect(input.value).toBe('nihao')
    // The Enter after the composition sends.
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 })
    expect(baseProps.onReply).toHaveBeenCalledTimes(1)
    expect(baseProps.onReply).toHaveBeenCalledWith('nihao')
  })

  describe('on the design system', () => {
    // The class list is exact: the window is as wide as the card, so nothing may be drawn
    // outside its box (the border delimits it).
    it('is a raised card with a separator line and the panel radius, and nothing drawn outside its box', () => {
      const { container } = render(<PetNotificationBubble status="running" {...baseProps} />)
      const card = container.querySelector('[data-testid="pet-notification"] > div') as HTMLElement
      expect([...card.classList].sort()).toEqual(['bg-raised', 'border', 'border-separator', 'group', 'px-3', 'py-2', 'rounded-panel'])
      expect(container.querySelector('[data-testid="pet-notification"]')).toHaveClass('w-50')
    })

    // The curve is the one the fade had before, when it was written by its CSS keyword.
    it('keeps the length and the curve of the fade', () => {
      const { container } = render(<PetNotificationBubble status="done" {...baseProps} />)
      const card = container.querySelector('[data-testid="pet-notification"] > div') as HTMLElement
      expect(card.style.animation).toBe('petNotifFade 6s cubic-bezier(0, 0, 0.58, 1) forwards')
    })

    it('writes no legacy variable anywhere, in any state', () => {
      const states = [
        <PetNotificationBubble key="a" status="running" {...baseProps} />,
        <PetNotificationBubble key="b" status="running" {...baseProps} mode="expanded" />,
        <PetNotificationBubble key="c" status="running" {...baseProps} mode="replying" />,
        <PetNotificationBubble key="d" status="waiting" {...baseProps} waitingKind="approval" />,
        <PetNotificationBubble key="e" status="done" {...baseProps} />,
      ]
      for (const state of states) {
        const { container, unmount } = render(state)
        expect(container.innerHTML).not.toContain('--abu-')
        unmount()
      }
    })

    it('finds its three buttons by name, each a button that is not a submit button', () => {
      render(<PetNotificationBubble status="running" {...baseProps} />)
      for (const name of ['打开主窗口', '回复', '展开']) {
        expect(screen.getByRole('button', { name })).toHaveAttribute('type', 'button')
      }
    })

    it('draws the expand control as a glyph', () => {
      const { rerender } = render(<PetNotificationBubble status="running" {...baseProps} />)
      expect(screen.getByRole('button', { name: '展开' }).querySelector('svg')).toHaveAttribute('stroke-width', '1.5')
      rerender(<PetNotificationBubble status="running" {...baseProps} mode="expanded" />)
      expect(screen.getByRole('button', { name: '收起' }).querySelector('svg')).toHaveAttribute('stroke-width', '1.5')
    })

    it('mounts no tooltip: the window is as large as the bubble, a floating layer has no room in it', () => {
      render(<PetNotificationBubble status="running" {...baseProps} />)
      const expand = screen.getByRole('button', { name: '展开' })
      fireEvent.focus(expand)
      fireEvent.pointerMove(expand)
      expect(expand).not.toHaveAttribute('data-state')
      expect(document.querySelector('[role="tooltip"]')).toBeNull()
    })

    it('uses the design-system text field for the reply, with the placeholder unchanged', () => {
      render(<PetNotificationBubble status="waiting" {...baseProps} />)
      const input = screen.getByPlaceholderText('回复…')
      expect(input).toHaveClass('bg-field')
      expect(input).toHaveClass('border-control-border')
      expect(input).toHaveAttribute('type', 'text')
    })

    it('a repeating Enter sends nothing, also with text in the field', () => {
      render(<PetNotificationBubble status="waiting" {...baseProps} />)
      const input = screen.getByPlaceholderText('回复…') as HTMLInputElement
      fireEvent.change(input, { target: { value: '第一条' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
      fireEvent.change(input, { target: { value: '第二条' } })
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', repeat: true })
      expect(baseProps.onReply).toHaveBeenCalledTimes(1)
      expect(input.value).toBe('第二条')
    })

    it('marks the approval with the warning color on a glyph and on its words', () => {
      render(<PetNotificationBubble status="waiting" {...baseProps} waitingKind="approval" />)
      const words = screen.getByText('需要授权')
      expect(words).toHaveClass('text-warning')
      expect(words.getAttribute('style')).toBeNull()
      const glyph = screen.getByRole('button', { name: '打开主窗口' }).querySelector('svg') as SVGElement
      expect(glyph).toHaveClass('text-warning')
      expect(glyph).toHaveAttribute('stroke-width', '1.5')
    })
  })
})
