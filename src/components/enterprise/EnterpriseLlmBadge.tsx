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
    <div className="p-4 rounded-lg bg-orange-500/10 border border-orange-500/30 text-sm space-y-2">
      <div className="font-medium text-orange-400">{t.enterprise.usingGateway}</div>
      <p className="text-xs text-neutral-300">
        {t.enterprise.gatewayDesc}
      </p>
      <dl className="text-xs text-neutral-400 space-y-1">
        <div className="flex justify-between">
          <dt>{t.enterprise.organization}</dt>
          <dd>{b.orgName}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{t.enterprise.gateway}</dt>
          <dd className="font-mono truncate max-w-[200px]">{b.llmEndpoint ?? '—'}</dd>
        </div>
        {mode.kind === 'offline' && (
          <div className="flex justify-between text-amber-400">
            <dt>{t.enterprise.status}</dt>
            <dd>{t.enterprise.offline}</dd>
          </div>
        )}
      </dl>
    </div>
  )
}
