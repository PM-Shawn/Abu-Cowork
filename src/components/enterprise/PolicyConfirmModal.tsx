// src/components/enterprise/PolicyConfirmModal.tsx
// Enterprise policy confirmation modal — rendered once at App root (z-[60]).
// Call showPolicyConfirm(msg) from any imperative code to gate an action.
import { useState, useEffect } from 'react'
import { confirmQueue, setActiveConfirmSetter } from './policyConfirmQueue'
import { useI18n } from '@/i18n'

interface PendingConfirm {
  resolve: (ok: boolean) => void
  message: string
}

export default function PolicyConfirmModal() {
  const { t } = useI18n()
  const [active, setActive] = useState<PendingConfirm | null>(null)

  useEffect(() => {
    setActiveConfirmSetter(setActive)
    return () => {
      setActiveConfirmSetter(null)
    }
  }, [])

  if (!active) return null

  const decide = (ok: boolean) => {
    active.resolve(ok)
    confirmQueue.shift()
    setActive(confirmQueue[0] ?? null)
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-[420px]">
        <div className="text-sm font-medium text-amber-400 mb-2">{t.enterprise.policyConfirmTitle}</div>
        <p className="text-xs text-neutral-300 mb-4">{active.message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => decide(false)}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
          >
            {t.common.cancel}
          </button>
          <button
            onClick={() => decide(true)}
            className="px-3 py-1.5 text-xs rounded bg-orange-500 text-black font-medium hover:bg-orange-400"
          >
            {t.enterprise.allowOnce}
          </button>
        </div>
      </div>
    </div>
  )
}
