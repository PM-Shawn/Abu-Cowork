// src/components/enterprise/EnterpriseLoginPage.tsx
import { useState } from 'react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { startBind } from '@/core/enterprise/auth'
import { activateEnterpriseRuntime } from '@/core/enterprise/runtime'
import type { BootstrapDTO } from '@/core/enterprise/bootstrap'
import type { EnterpriseBinding } from '@/core/enterprise/types'

interface TokenPair {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
}

interface SessionData {
  user?: { id: string; email: string; name: string; deptId?: string }
  org?: { id: string; name: string }
  llm?: { gatewayUrl?: string; virtualKey?: string }
}

interface Props {
  serverUrl: string
  bootstrap: BootstrapDTO
  onSuccess: () => void
  onCancel?: () => void
  surface?: 'page' | 'dialog'
}

export default function EnterpriseLoginPage({ serverUrl, bootstrap, onSuccess, onCancel, surface = 'page' }: Props) {
  const { t, format } = useI18n()
  const tl = t.enterpriseLogin
  const bind = useEnterpriseStore(s => s.bind)

  const methods = bootstrap.auth.methods
  const [activeMethod, setActiveMethod] = useState<string>(
    methods.includes('password') ? 'password' : methods.includes('magic_link') ? 'magic_link' : 'sso',
  )

  // Password state
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // Magic link state
  const [magicStep, setMagicStep] = useState<'start' | 'verify'>('start')
  const [magicEmail, setMagicEmail] = useState('')
  const [magicCode, setMagicCode] = useState('')

  // SSO state
  const [ssoUserCode, setSsoUserCode] = useState<string | null>(null)

  // Shared state
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const showTabs = methods.length > 1
  const isDialog = surface === 'dialog'

  const labelClass = isDialog
    ? 'text-[var(--abu-text-secondary)]'
    : 'text-neutral-300'
  const mutedTextClass = isDialog
    ? 'text-[var(--abu-text-muted)]'
    : 'text-neutral-400'
  const subtleTextClass = isDialog
    ? 'text-[var(--abu-text-tertiary)]'
    : 'text-neutral-500'
  const errorClass = isDialog
    ? 'text-[var(--abu-danger)]'
    : 'text-rose-400'

  const base = serverUrl.replace(/\/$/, '')

  const fetchSession = async (accessToken: string): Promise<SessionData> => {
    const res = await fetch(`${base}/api/client/v1/session`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return {}
    return res.json().catch(() => ({}))
  }

  const buildBinding = (
    accessToken: string,
    session: SessionData,
    extra?: { accessExpiresAt?: string; refreshToken?: string; llmEndpoint?: string | null; llmVirtualKey?: string | null },
  ): EnterpriseBinding => ({
    serverUrl: base,
    orgId: session.org?.id ?? '',
    orgName: session.org?.name ?? '',
    userId: session.user?.id ?? '',
    userName: session.user?.name ?? '',
    userEmail: session.user?.email ?? '',
    deptId: session.user?.deptId ?? null,
    roleId: null,
    accessToken,
    accessExpiresAt: extra?.accessExpiresAt,
    refreshToken: extra?.refreshToken,
    boundAt: new Date().toISOString(),
    llmEndpoint: extra?.llmEndpoint ?? session.llm?.gatewayUrl ?? null,
    llmVirtualKey: extra?.llmVirtualKey ?? session.llm?.virtualKey ?? null,
    llmKeyExpiresAt: null,
  })

  const handleTokenPair = async (pair: TokenPair) => {
    const session = await fetchSession(pair.access_token)
    const accessExpiresAt = new Date(Date.now() + pair.expires_in * 1000).toISOString()
    await bind(buildBinding(pair.access_token, session, { accessExpiresAt, refreshToken: pair.refresh_token }))
    await activateEnterpriseRuntime()
    onSuccess()
  }

  const translateError = (code: string, retryAfter?: number): string => {
    if (code === 'invalid_credentials') return tl.errInvalidCredentials
    if (code === 'account_pending') return tl.errAccountPending
    if (code === 'account_suspended') return tl.errAccountSuspended
    if (code === 'slow_down') {
      return retryAfter != null && !isNaN(retryAfter)
        ? format(tl.errSlowDown, { seconds: String(retryAfter) })
        : tl.errSlowDownGeneric
    }
    if (code === 'expired_token') return tl.errExpiredToken
    if (code === 'method_not_enabled') return tl.errMethodNotEnabled
    if (code === 'registration_closed') return tl.errRegistrationClosed
    if (code === 'domain_not_allowed') return tl.errDomainNotAllowed
    if (code === 'invalid_request') return tl.errInvalidRequest
    return tl.errGeneric
  }

  /** Parse the Retry-After header value into seconds (integer), or undefined. */
  const parseRetryAfter = (res: Response): number | undefined => {
    const h = res.headers.get('Retry-After')
    if (!h) return undefined
    const n = parseInt(h, 10)
    return isNaN(n) ? undefined : n
  }

  // ── Password ─────────────────────────────────────────────────────────────────
  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${base}/api/client/v1/auth/password`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, device_label: navigator.userAgent.slice(0, 80) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(translateError(body.error as string, parseRetryAfter(res)))
      await handleTokenPair(body as TokenPair)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // ── Magic link ────────────────────────────────────────────────────────────────
  const handleMagicStart = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${base}/api/client/v1/auth/magic/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: magicEmail }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(translateError((body as { error?: string }).error ?? '', parseRetryAfter(res)))
      }
      setMagicStep('verify')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const handleMagicVerify = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${base}/api/client/v1/auth/magic/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: magicEmail, code: magicCode, device_label: navigator.userAgent.slice(0, 80) }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(translateError((body as { error?: string }).error ?? '', parseRetryAfter(res)))
      const typed = body as { status?: string } & TokenPair
      if (typed.status === 'pending') throw new Error(tl.errAccountPending)
      await handleTokenPair(typed)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // ── SSO device flow ───────────────────────────────────────────────────────────
  const handleSso = async () => {
    setBusy(true); setErr(null)
    try {
      const { initResp, result } = await startBind(serverUrl, navigator.userAgent.slice(0, 80))
      setSsoUserCode(initResp.user_code)
      const r = await result
      const session = await fetchSession(r.accessToken)
      await bind(buildBinding(r.accessToken, session, {
        refreshToken: r.refreshToken,
        accessExpiresAt: r.accessExpiresAt,
        llmEndpoint: r.llmEndpoint,
        llmVirtualKey: r.llmVirtualKey,
      }))
      await activateEnterpriseRuntime()
      onSuccess()
    } catch (e) {
      setErr((e as Error).message)
      setSsoUserCode(null)
    } finally {
      setBusy(false)
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  const tabLabel = (method: string): string => {
    if (method === 'password') return tl.tabPassword
    if (method === 'magic_link') return tl.tabMagicLink
    if (method === 'sso') return bootstrap.auth.sso?.buttonLabel ?? tl.tabSso
    return method
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {isDialog && (
        <div>
          <h2 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
            {bootstrap.instanceName || bootstrap.branding.name || tl.bindTitle}
          </h2>
          <p className="mt-2 text-body leading-relaxed text-[var(--abu-text-muted)]">
            {tl.bindDescription}
          </p>
        </div>
      )}

      {/* Branding */}
      {bootstrap.branding.logoUrl && (
        <img src={bootstrap.branding.logoUrl} alt={bootstrap.branding.name} className="h-8 object-contain" />
      )}

      {/* Method tabs (only when multiple methods) */}
      {showTabs && (
        <div
          className={cn(
            'flex gap-1 border-b pb-0',
            isDialog ? 'border-[var(--abu-border)]' : 'border-neutral-700',
          )}
          role="tablist"
        >
          {methods.map(method => (
            <button
              key={method}
              role="tab"
              aria-selected={activeMethod === method}
              data-testid={`method-tab-${method}`}
              onClick={() => { setActiveMethod(method); setErr(null) }}
              className={cn(
                'px-3 py-1.5 text-minor rounded-t transition-colors',
                activeMethod === method && isDialog
                  ? 'text-[var(--abu-clay)] border-b-2 border-[var(--abu-clay)] -mb-px'
                  : activeMethod === method
                    ? 'text-white border-b-2 border-[var(--abu-info)] -mb-px'
                    : isDialog
                      ? 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]'
                      : 'text-neutral-400 hover:text-neutral-200',
              )}
            >
              {tabLabel(method)}
            </button>
          ))}
        </div>
      )}

      {/* Password form */}
      {(activeMethod === 'password' || (!showTabs && methods.includes('password'))) && (
        <form data-testid="password-form" onSubmit={handlePassword} className="space-y-3">
          <div>
            <label className={cn('mb-1 block text-minor font-medium', labelClass)}>{tl.emailLabel}</label>
            <Input
              data-testid="email-input"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder={tl.emailPlaceholder}
              required
            />
          </div>
          <div>
            <label className={cn('mb-1 block text-minor font-medium', labelClass)}>{tl.passwordLabel}</label>
            <Input
              data-testid="password-input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={tl.passwordPlaceholder}
              required
            />
          </div>
          {err && <div className={cn('text-minor', errorClass)}>{err}</div>}
          <Button type="submit" size="sm" className="w-full" disabled={busy}>
            {busy ? tl.processing : tl.signInButton}
          </Button>
        </form>
      )}

      {/* Magic link form */}
      {(activeMethod === 'magic_link' || (!showTabs && methods.includes('magic_link'))) && (
        <div data-testid="magic-form">
          {magicStep === 'start' ? (
            <form onSubmit={handleMagicStart} className="space-y-3">
              <div>
                <label className={cn('mb-1 block text-minor font-medium', labelClass)}>{tl.emailLabel}</label>
                <Input
                  type="email"
                  value={magicEmail}
                  onChange={e => setMagicEmail(e.target.value)}
                  placeholder={tl.emailPlaceholder}
                  required
                />
              </div>
              {err && <div className={cn('text-minor', errorClass)}>{err}</div>}
              <Button type="submit" size="sm" className="w-full" disabled={busy}>
                {busy ? tl.processing : tl.magicSendCodeButton}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleMagicVerify} className="space-y-3">
              <p className={cn('text-minor', mutedTextClass)}>
                {format(tl.magicSentHint, { email: magicEmail })}
              </p>
              <div>
                <label className={cn('mb-1 block text-minor font-medium', labelClass)}>{tl.magicCodeLabel}</label>
                <Input
                  type="text"
                  value={magicCode}
                  onChange={e => setMagicCode(e.target.value)}
                  placeholder={tl.magicCodePlaceholder}
                  required
                />
              </div>
              {err && <div className={cn('text-minor', errorClass)}>{err}</div>}
              <Button type="submit" size="sm" className="w-full" disabled={busy}>
                {busy ? tl.processing : tl.magicVerifyButton}
              </Button>
            </form>
          )}
        </div>
      )}

      {/* SSO */}
      {(activeMethod === 'sso' || (!showTabs && methods.includes('sso'))) && (
        <div data-testid="sso-section">
          {ssoUserCode ? (
            <div className="text-center space-y-2">
              <p className={cn('text-minor', labelClass)}>{tl.ssoCodeHint}</p>
              <div
                className={cn(
                  'rounded-md py-3 font-mono text-h-xl tracking-widest',
                  isDialog
                    ? 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-primary)]'
                    : 'bg-neutral-800',
                )}
              >
                {ssoUserCode}
              </div>
              <p className={cn('text-minor', subtleTextClass)}>{tl.ssoWaiting}</p>
              {err && <div className={cn('text-minor', errorClass)}>{err}</div>}
            </div>
          ) : (
            <>
              {err && <div className={cn('mb-2 text-minor', errorClass)}>{err}</div>}
              <Button
                data-testid="sso-button"
                type="button"
                size="sm"
                className="w-full"
                disabled={busy}
                onClick={handleSso}
              >
                {busy ? tl.processing : (bootstrap.auth.sso?.buttonLabel ?? tl.tabSso)}
              </Button>
            </>
          )}
        </div>
      )}

      {/* Cancel / back */}
      {onCancel && !busy && (
        <div className="flex justify-start pt-1">
          <button
            onClick={onCancel}
            className={cn(
              'text-minor transition-colors',
              isDialog
                ? 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]'
                : 'text-neutral-500 hover:text-neutral-300',
            )}
          >
            {tl.cancelButton}
          </button>
        </div>
      )}
    </div>
  )
}
