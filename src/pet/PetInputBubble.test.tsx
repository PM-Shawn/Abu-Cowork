import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PetInputBubble } from './PetInputBubble'

describe('PetInputBubble', () => {
  const base = { expandUp: false, onSend: vi.fn(), onDismiss: vi.fn() }

  beforeEach(() => { base.onSend.mockClear(); base.onDismiss.mockClear() })

  it('renders placeholder text', () => {
    render(<PetInputBubble {...base} />)
    expect(screen.getByPlaceholderText('说点什么…')).toBeInTheDocument()
  })

  it('calls onSend with trimmed text on Enter', () => {
    render(<PetInputBubble {...base} />)
    const input = screen.getByPlaceholderText('说点什么…')
    fireEvent.change(input, { target: { value: '  hello  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(base.onSend).toHaveBeenCalledWith('hello')
  })

  it('does not call onSend on Enter when input is blank', () => {
    render(<PetInputBubble {...base} />)
    fireEvent.keyDown(screen.getByPlaceholderText('说点什么…'), { key: 'Enter' })
    expect(base.onSend).not.toHaveBeenCalled()
  })

  it('calls onDismiss on Escape', () => {
    render(<PetInputBubble {...base} />)
    fireEvent.keyDown(screen.getByPlaceholderText('说点什么…'), { key: 'Escape' })
    expect(base.onDismiss).toHaveBeenCalled()
  })

  it('calls onSend when send button is clicked with text', () => {
    render(<PetInputBubble {...base} />)
    fireEvent.change(screen.getByPlaceholderText('说点什么…'), { target: { value: 'msg' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(base.onSend).toHaveBeenCalledWith('msg')
  })

  it('calls onDismiss when clicking outside the bubble', () => {
    render(
      <div>
        <PetInputBubble {...base} />
        <div data-testid="outside">outside</div>
      </div>
    )
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(base.onDismiss).toHaveBeenCalled()
  })

  it('renders bottom-tail class when expandUp=true', () => {
    const { container } = render(<PetInputBubble {...base} expandUp={true} />)
    expect(container.querySelector('[data-testid="bubble-tail"]')).toHaveClass('bottom-tail')
  })

  it('renders top-tail class when expandUp=false', () => {
    const { container } = render(<PetInputBubble {...base} expandUp={false} />)
    expect(container.querySelector('[data-testid="bubble-tail"]')).toHaveClass('top-tail')
  })
})
