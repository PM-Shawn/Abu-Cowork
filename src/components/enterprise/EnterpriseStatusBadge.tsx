// src/components/enterprise/EnterpriseStatusBadge.tsx
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { MountPoint } from '@/core/enterprise/mounts'
import { useI18n } from '@/i18n'

export default function EnterpriseStatusBadge() {
  const { t } = useI18n()
  const mode = useEnterpriseStore(s => s.mode)
  if (mode.kind === 'personal') return null
  const binding = mode.kind === 'enterprise' || mode.kind === 'offline' ? mode.binding : null
  const config = mode.kind === 'enterprise' ? mode.config : mode.kind === 'offline' ? mode.lastConfig : null
  return (
    <div className={[
      'inline-flex items-center gap-2 px-2 py-1 rounded text-caption',
      mode.kind === 'offline' ? 'bg-[var(--abu-warning-bg)] text-[var(--abu-warning)]' : 'bg-[var(--abu-clay-bg-15)] text-[var(--abu-clay)]',
    ].join(' ')}>
      <MountPoint slot="brandSlot" binding={binding} config={config} size="sm" />
      {mode.kind === 'offline' && <span>{t.enterprise.offlineBadge}</span>}
    </div>
  )
}
