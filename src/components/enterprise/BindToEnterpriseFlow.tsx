// src/components/enterprise/BindToEnterpriseFlow.tsx
import { useState } from 'react'
import { useI18n } from '@/i18n'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { fetchBootstrap } from '@/core/enterprise/bootstrap'
import type { BootstrapDTO } from '@/core/enterprise/bootstrap'
import EnterpriseLoginPage from './EnterpriseLoginPage'

export default function BindToEnterpriseFlow({
  onDone,
  onCancel,
  initialServerUrl,
}: {
  onDone: () => void
  onCancel: () => void
  initialServerUrl?: string
}) {
  const { t } = useI18n()
  const tl = t.enterpriseLogin

  const [serverUrl, setServerUrl] = useState(initialServerUrl ?? '')
  const [bootstrap, setBootstrap] = useState<BootstrapDTO | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleUrlSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!serverUrl) return
    setBusy(true); setErr(null)
    try {
      const dto = await fetchBootstrap(serverUrl)
      setBootstrap(dto)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 backdrop-blur-[2px]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="w-full max-w-[500px] rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-base)] p-6 shadow-[0_18px_60px_rgba(24,22,18,0.22)]">
        {bootstrap ? (
          <>
            <EnterpriseLoginPage
              serverUrl={serverUrl}
              bootstrap={bootstrap}
              onSuccess={onDone}
              onCancel={() => { setBootstrap(null); setErr(null) }}
              surface="dialog"
            />
          </>
        ) : (
          <>
            <h2 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">{tl.bindTitle}</h2>
            <p className="mt-2 text-body leading-relaxed text-[var(--abu-text-muted)]">{tl.bindDescription}</p>
            <form onSubmit={handleUrlSubmit} className="mt-5">
              <label className="mb-1.5 block text-minor font-medium text-[var(--abu-text-secondary)]">{tl.serverUrlLabel}</label>
              <Input
                value={serverUrl}
                onChange={e => setServerUrl(e.target.value)}
                placeholder={tl.serverUrlPlaceholder}
                required
              />
              {err && <div className="mt-2 text-minor text-[var(--abu-danger)]">{err}</div>}
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-[var(--abu-text-muted)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]"
                  onClick={onCancel}
                >
                  {tl.cancelButton}
                </Button>
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? tl.processing : tl.continueButton}
                </Button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
