import { useEffect, useRef } from 'react'
import type { PetStatus } from '@/core/pet/petStatusBridge'

const STATUS_LABEL: Record<PetStatus, string> = {
  idle: '空闲',
  running: '处理中…',
  waiting: '等待输入',
  error: '遇到问题',
  done: '完成',
}

const STATUS_COLOR: Record<PetStatus, string> = {
  idle: '#6b7280',
  running: '#3b82f6',
  waiting: '#f97316',
  error: '#ef4444',
  done: '#22c55e',
}

interface PetContextMenuProps {
  status: PetStatus
  isDnd: boolean
  onToggleDnd: () => void
  onOpenMain: () => void
  onClosePet: () => void
  onDismiss: () => void
}

export function PetContextMenu({
  status, isDnd, onToggleDnd, onOpenMain, onClosePet, onDismiss,
}: PetContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onDismiss])

  return (
    <div
      ref={menuRef}
      className="w-[170px] bg-[#1f2937] rounded-[10px] py-1.5 border border-white/[0.06]"
      style={{ boxShadow: '0 8px 32px rgba(0,0,0,0.6)' }}
    >
      <div className="px-3.5 py-2 flex items-center gap-2 border-b border-[#374151]">
        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: STATUS_COLOR[status] }}
        />
        <span className="text-[11px] text-[#9ca3af]">{STATUS_LABEL[status]}</span>
      </div>

      <button
        className="w-full px-3.5 py-2 text-[12px] text-[#e5e7eb] flex items-center gap-2 hover:bg-white/5 text-left"
        onClick={onToggleDnd}
      >
        <span>🔕</span>
        <span className="flex-1">勿扰模式</span>
        {isDnd && <span className="text-[#6366f1]">✓</span>}
      </button>

      <button
        className="w-full px-3.5 py-2 text-[12px] text-[#e5e7eb] flex items-center gap-2 hover:bg-white/5 text-left"
        onClick={onOpenMain}
      >
        <span>🪟</span>
        <span>打开主窗口</span>
      </button>

      <button
        className="w-full px-3.5 py-2 text-[12px] text-[#9ca3af] flex items-center gap-2 hover:bg-white/5 text-left"
        onClick={onClosePet}
      >
        <span>👋</span>
        <span>关闭桌宠</span>
      </button>
    </div>
  )
}
