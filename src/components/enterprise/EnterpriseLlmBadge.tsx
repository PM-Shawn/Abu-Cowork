// src/components/enterprise/EnterpriseLlmBadge.tsx
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { useI18n } from '@/i18n'

export default function EnterpriseLlmBadge() {
  const { t } = useI18n()
  const mode = useEnterpriseStore(s => s.mode)
  if (mode.kind === 'personal') return null
  const b = (mode.kind === 'enterprise' || mode.kind === 'offline') ? mode.binding : null
  if (!b) return null

  return (
    <div className="p-4 rounded-lg bg-[var(--abu-clay-bg)] border border-[var(--abu-clay)] text-body space-y-2">
      <div className="font-medium text-[var(--abu-clay)]">{t.enterprise.usingGateway}</div>
      <p className="text-minor text-neutral-300">
        {t.enterprise.gatewayDesc}
      </p>
      <dl className="text-minor text-neutral-400 space-y-1">
        <div className="flex justify-between">
          <dt>{t.enterprise.organization}</dt>
          <dd>{b.orgName}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{t.enterprise.gateway}</dt>
          <dd className="font-mono truncate max-w-[200px]">{b.llmEndpoint ?? '—'}</dd>
        </div>
        {mode.kind === 'offline' && (
          <div className="flex justify-between text-[var(--abu-warning)]">
            <dt>{t.enterprise.status}</dt>
            <dd>{t.enterprise.offline}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}
