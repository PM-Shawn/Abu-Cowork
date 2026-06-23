// src/components/enterprise/EnterpriseStatusBadge.tsx
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { MountPoint } from '@/core/enterprise/mounts'

export default function EnterpriseStatusBadge() {
  const mode = useEnterpriseStore(s => s.mode)
  if (mode.kind === 'personal') return null
  const binding = mode.kind === 'enterprise' || mode.kind === 'offline' ? mode.binding : null
  const config = mode.kind === 'enterprise' ? mode.config : mode.kind === 'offline' ? mode.lastConfig : null
  return (
    <div className={[
      'inline-flex items-center gap-2 px-2 py-1 rounded text-[10px]',
      mode.kind === 'offline' ? 'bg-amber-500/20 text-amber-300' : 'bg-orange-500/15 text-orange-400',
    ].join(' ')}>
      <MountPoint slot="brandSlot" binding={binding} config={config} size="sm" />
      {mode.kind === 'offline' && <span>· 离线</span>}
    </div>
  )
}
