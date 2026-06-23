// src/components/enterprise/EnterpriseSkillTab.tsx
import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import type { TabSlotProps } from '@/core/enterprise/mounts'
import { registerEnterpriseMount } from '@/core/enterprise/mounts'
import { callEnterprise, EnterpriseApiError } from '@/core/enterprise/api'

interface SkillRow {
  id: string
  name: string
  description: string
  latestVersion: string
  deptScope?: string[]
}

function EnterpriseSkillTab({ binding }: TabSlotProps) {
  const [items, setItems] = useState<SkillRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setItems(null)
    setErr(null)
    callEnterprise<{ items: SkillRow[] }>('/api/skills/catalog')
      .then(r => setItems(r.items))
      .catch(e => {
        if (e instanceof EnterpriseApiError && (e.status === 404 || e.status === 501)) {
          setItems([]) // server not enabled — show empty state
        } else {
          setErr((e as Error).message)
        }
      })
  }, [binding.serverUrl])

  if (err) {
    return <div className="p-4 text-xs text-rose-400">{err}</div>
  }
  if (items === null) {
    return <div className="p-4 text-xs text-[var(--abu-text-tertiary)]">加载中...</div>
  }
  if (items.length === 0) {
    return (
      <div className="p-6 text-center text-xs text-[var(--abu-text-tertiary)]">
        <div>该企业还未发布企业 Skill</div>
        <div className="mt-1">管理员可以从 admin 后台上架</div>
      </div>
    )
  }
  return (
    <div className="divide-y divide-[var(--abu-border)]">
      {items.map(s => (
        <div key={s.id} className="px-4 py-3">
          <div className="text-sm text-[var(--abu-text-primary)]">
            {s.name}
            <span className="text-xs text-[var(--abu-text-tertiary)] font-mono ml-2">v{s.latestVersion}</span>
          </div>
          <div className="text-xs text-[var(--abu-text-secondary)] mt-1">{s.description}</div>
        </div>
      ))}
    </div>
  )
}

registerEnterpriseMount('skillTab', EnterpriseSkillTab as ComponentType<TabSlotProps>)

export default EnterpriseSkillTab
