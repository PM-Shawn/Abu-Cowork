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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-[420px]">
        {bootstrap ? (
          <>
            <h2 className="text-base font-semibold mb-2">{bootstrap.instanceName || bootstrap.branding.name}</h2>
            <EnterpriseLoginPage
              serverUrl={serverUrl}
              bootstrap={bootstrap}
              onSuccess={onDone}
              onCancel={() => { setBootstrap(null); setErr(null) }}
            />
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold mb-2">{tl.bindTitle}</h2>
            <p className="text-xs text-neutral-400 mb-4">{tl.bindDescription}</p>
            <form onSubmit={handleUrlSubmit}>
              <label className="block text-xs text-neutral-300 mb-1">{tl.serverUrlLabel}</label>
              <Input
                value={serverUrl}
                onChange={e => setServerUrl(e.target.value)}
                placeholder={tl.serverUrlPlaceholder}
                required
              />
              {err && <div className="text-xs text-rose-400 mt-2">{err}</div>}
              <div className="mt-4 flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{tl.cancelButton}</Button>
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
