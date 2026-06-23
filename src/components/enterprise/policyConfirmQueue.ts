// src/components/enterprise/policyConfirmQueue.ts
// Shared module-level queue for PolicyConfirmModal.
// Kept separate from the component file so PolicyConfirmModal.tsx only exports a component
// (required for react-refresh/only-export-components).

interface PendingConfirm {
  resolve: (ok: boolean) => void
  message: string
}

/** FIFO queue of pending confirmations. */
export const confirmQueue: PendingConfirm[] = []

/** Set by the mounted PolicyConfirmModal; null when unmounted. */
export let setActiveConfirm: ((p: PendingConfirm | null) => void) | null = null

export function setActiveConfirmSetter(fn: ((p: PendingConfirm | null) => void) | null): void {
  setActiveConfirm = fn
}

/**
 * Request an enterprise policy confirmation dialog.
 * Returns a Promise<boolean>: true = user allowed, false = user denied.
 * If the modal is not mounted (non-enterprise flow), resolves to true so
 * non-enterprise users are never blocked.
 */
export function showPolicyConfirm(message: string): Promise<boolean> {
  if (setActiveConfirm === null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    confirmQueue.push({ resolve, message })
    if (confirmQueue.length === 1) {
      setActiveConfirm?.(confirmQueue[0] ?? null)
    }
  })
}
