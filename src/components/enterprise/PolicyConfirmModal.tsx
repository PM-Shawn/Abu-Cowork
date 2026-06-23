// src/components/enterprise/PolicyConfirmModal.tsx
// Promise-based enterprise policy confirmation modal.
// Call showPolicyConfirm(message) from the tool dispatcher to gate a
// tool call behind a user decision. The modal renders at z-[60] (above
// all other overlays) and processes one confirmation at a time.
import { useState, useEffect } from 'react'

interface PendingConfirm {
  resolve: (ok: boolean) => void
  message: string
}

/** Module-level queue; processed FIFO. */
const queue: PendingConfirm[] = []

/** Set by the mounted component; null when component is unmounted. */
let setActive: ((p: PendingConfirm | null) => void) | null = null

/**
 * Request a policy confirmation dialog.
 * Returns a Promise<boolean>: true = user allowed this call once, false = user denied.
 * If the modal component is not mounted (non-enterprise mode), resolves immediately to true
 * so enforcement doesn't block non-enterprise users.
 */
export function showPolicyConfirm(message: string): Promise<boolean> {
  // If no modal is mounted (non-enterprise flow), allow through silently.
  if (setActive === null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    queue.push({ resolve, message })
    // If no active item yet, start processing
    if (queue.length === 1) {
      setActive?.(queue[0] ?? null)
    }
  })
}

export default function PolicyConfirmModal() {
  const [active, setActiveState] = useState<PendingConfirm | null>(null)

  useEffect(() => {
    setActive = setActiveState
    return () => {
      setActive = null
    }
  }, [])

  if (!active) return null

  const decide = (ok: boolean) => {
    active.resolve(ok)
    queue.shift()
    setActiveState(queue[0] ?? null)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-[420px]">
        <div className="text-sm font-medium text-amber-400 mb-2">企业策略要求二次确认</div>
        <p className="text-xs text-neutral-300 mb-4">{active.message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => decide(false)}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
          >
            取消
          </button>
          <button
            onClick={() => decide(true)}
            className="px-3 py-1.5 text-xs rounded bg-orange-500 text-black font-medium hover:bg-orange-400"
          >
            允许这次
          </button>
        </div>
      </div>
    </div>
  )
}
