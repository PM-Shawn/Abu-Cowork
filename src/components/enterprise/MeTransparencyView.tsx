// src/components/enterprise/MeTransparencyView.tsx
// /me transparency panel — shows the enterprise server's record of the current user.
// Surfaces in enterprise Settings > EnterpriseSection when enterprise mode is active.
import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import type { MeTransparencyProps } from '@/core/enterprise/mounts'
import { registerEnterpriseMount } from '@/core/enterprise/mounts'
import { callEnterprise } from '@/core/enterprise/api'

interface MeData {
  user: Record<string, string | null>
  department: Record<string, string | null> | null
  role: Record<string, string | null> | null
}
interface TokensData {
  items: Array<{ id: string; kind: string; label: string | null; createdAt: string; expiresAt: string | null }>
}
interface AuditData {
  items: Array<{ id: number; at: string; action: string }>
}
interface UsageData {
  tokens?: { input?: number; output?: number }
  cost?: { amount?: number }
}

type Tab = 'profile' | 'tokens' | 'audit' | 'usage'

function MeTransparencyView(_props: MeTransparencyProps) {
  const [tab, setTab] = useState<Tab>('profile')
  const [me, setMe] = useState<MeData | null>(null)
  const [tokens, setTokens] = useState<TokensData | null>(null)
  const [audit, setAudit] = useState<AuditData | null>(null)
  const [usage, setUsage] = useState<UsageData | null>(null)
  const [meErr, setMeErr] = useState<string | null>(null)

  useEffect(() => {
    callEnterprise<MeData>('/api/me')
      .then(setMe)
      .catch(e => setMeErr((e as Error).message))
  }, [])

  useEffect(() => {
    if (tab === 'tokens') {
      callEnterprise<TokensData>('/api/me/tokens').then(setTokens).catch(() => setTokens({ items: [] }))
    }
  }, [tab])

  useEffect(() => {
    if (tab === 'audit') {
      callEnterprise<AuditData>('/api/me/audit').then(setAudit).catch(() => setAudit({ items: [] }))
    }
  }, [tab])

  useEffect(() => {
    if (tab === 'usage') {
      callEnterprise<UsageData>('/api/me/usage').then(setUsage).catch(() => setUsage({}))
    }
  }, [tab])

  const tabLabels: Record<Tab, string> = {
    profile: '资料',
    tokens: '客户端',
    audit: '审计',
    usage: '用量',
  }

  return (
    <div className="flex flex-col bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)] rounded-xl border border-[var(--abu-border)] overflow-hidden">
      {/* Tab bar */}
      <div className="px-4 pt-3 pb-2 border-b border-[var(--abu-border)] flex gap-1">
        {(['profile', 'tokens', 'audit', 'usage'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'px-3 py-1.5 text-xs rounded transition-colors',
              tab === t
                ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                : 'text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]',
            ].join(' ')}
          >
            {tabLabels[t]}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4 min-h-[120px]">
        {tab === 'profile' && (
          meErr
            ? <div className="text-xs text-rose-400">{meErr}</div>
            : !me
              ? <div className="text-xs text-[var(--abu-text-tertiary)]">加载中...</div>
              : (
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-[var(--abu-text-tertiary)]">姓名</dt>
                    <dd>{me.user?.name ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[var(--abu-text-tertiary)]">邮箱</dt>
                    <dd>{me.user?.email ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[var(--abu-text-tertiary)]">部门</dt>
                    <dd>{me.department?.name ?? '—'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-[var(--abu-text-tertiary)]">角色</dt>
                    <dd>{me.role?.name ?? '—'}</dd>
                  </div>
                </dl>
              )
        )}

        {tab === 'tokens' && (
          !tokens
            ? <div className="text-xs text-[var(--abu-text-tertiary)]">加载中...</div>
            : tokens.items.length === 0
              ? <div className="text-xs text-[var(--abu-text-tertiary)]">无已注册客户端</div>
              : (
                <ul className="space-y-2 text-xs">
                  {tokens.items.map(item => (
                    <li key={item.id} className="p-2 bg-[var(--abu-bg-subtle)] rounded flex justify-between">
                      <span>{item.label ?? item.kind}</span>
                      <span className="text-[var(--abu-text-tertiary)]">{item.createdAt.slice(0, 10)}</span>
                    </li>
                  ))}
                </ul>
              )
        )}

        {tab === 'audit' && (
          !audit
            ? <div className="text-xs text-[var(--abu-text-tertiary)]">加载中...</div>
            : audit.items.length === 0
              ? <div className="text-xs text-[var(--abu-text-tertiary)]">无审计记录</div>
              : (
                <ul className="space-y-1 text-xs font-mono max-h-48 overflow-y-auto">
                  {audit.items.slice(0, 100).map(r => (
                    <li key={r.id} className="flex gap-3">
                      <span className="text-[var(--abu-text-tertiary)] shrink-0">{r.at.slice(0, 16)}</span>
                      <span>{r.action}</span>
                    </li>
                  ))}
                </ul>
              )
        )}

        {tab === 'usage' && (
          !usage
            ? <div className="text-xs text-[var(--abu-text-tertiary)]">加载中...</div>
            : (
              <div className="grid grid-cols-3 gap-2">
                <div className="p-3 bg-[var(--abu-bg-subtle)] rounded text-center">
                  <div className="text-[10px] text-[var(--abu-text-tertiary)]">输入 tokens</div>
                  <div className="text-lg font-semibold">{usage.tokens?.input ?? 0}</div>
                </div>
                <div className="p-3 bg-[var(--abu-bg-subtle)] rounded text-center">
                  <div className="text-[10px] text-[var(--abu-text-tertiary)]">输出 tokens</div>
                  <div className="text-lg font-semibold">{usage.tokens?.output ?? 0}</div>
                </div>
                <div className="p-3 bg-[var(--abu-bg-subtle)] rounded text-center">
                  <div className="text-[10px] text-[var(--abu-text-tertiary)]">费用</div>
                  <div className="text-lg font-semibold">${usage.cost?.amount ?? 0}</div>
                </div>
              </div>
            )
        )}
      </div>
    </div>
  )
}

registerEnterpriseMount('meTransparencyPage', MeTransparencyView as ComponentType<MeTransparencyProps>)

export default MeTransparencyView
