import { useEffect, useRef } from 'react'

interface PetInputBubbleProps {
  expandUp: boolean
  onSend: (text: string) => void
  onDismiss: () => void
}

export function PetInputBubble({ expandUp, onSend, onDismiss }: PetInputBubbleProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onDismiss])

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const val = e.currentTarget.value.trim()
      if (val) onSend(val)
    } else if (e.key === 'Escape') {
      onDismiss()
    }
  }

  function handleSendClick() {
    const val = inputRef.current?.value.trim()
    if (val) onSend(val)
  }

  // expandUp=true: avatar below → tail at bottom-left of bubble (pointing down)
  // expandUp=false: avatar above → tail at top-left of bubble (pointing up)
  const bubbleRadius = expandUp ? '16px 16px 16px 4px' : '4px 16px 16px 16px'

  return (
    <div ref={containerRef} className="relative w-[200px]">
      <div
        style={{ borderRadius: bubbleRadius }}
        className="bg-[#1e1e3f] border border-[#3730a3] px-3 py-2 flex items-center gap-2"
      >
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-[11px] text-[#a5b4fc] placeholder:text-[#4b5563] outline-none min-w-0"
          placeholder="说点什么…"
          onKeyDown={handleKeyDown}
        />
        <button
          className="w-5 h-5 rounded-full bg-[#4f46e5] flex items-center justify-center flex-shrink-0 text-white text-[9px] hover:bg-[#4338ca]"
          onClick={handleSendClick}
          aria-label="发送"
        >
          ↑
        </button>
      </div>
      {expandUp ? (
        <div
          data-testid="bubble-tail"
          className="bottom-tail absolute -bottom-1.5 left-3 w-3 h-3 bg-[#1e1e3f] border-r border-b border-[#3730a3] rotate-45"
        />
      ) : (
        <div
          data-testid="bubble-tail"
          className="top-tail absolute -top-1.5 left-3 w-3 h-3 bg-[#1e1e3f] border-l border-t border-[#3730a3] rotate-45"
        />
      )}
    </div>
  )
}
