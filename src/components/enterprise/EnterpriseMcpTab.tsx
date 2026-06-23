// src/components/enterprise/EnterpriseMcpTab.tsx
import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'
import type { TabSlotProps } from '@/core/enterprise/mounts'
import { registerEnterpriseMount } from '@/core/enterprise/mounts'
import { callEnterprise, EnterpriseApiError } from '@/core/enterprise/api'

interface McpRow {
  id: string
  name: string
  description: string
  endpoint?: string
}

function EnterpriseMcpTab({ binding }: TabSlotProps) {
  const [items, setItems] = useState<McpRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setItems(null)
    setErr(null)
    callEnterprise<{ items: McpRow[] }>('/api/mcp/catalog')
      .then(r => setItems(r.items))
      .catch(e => {
        if (e instanceof EnterpriseApiError && (e.status === 404 || e.status === 501)) {
          setItems([])
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
        该企业未上架 MCP 工具
      </div>
    )
  }
  return (
    <div className="divide-y divide-[var(--abu-border)]">
      {items.map(m => (
        <div key={m.id} className="px-4 py-3">
          <div className="text-sm text-[var(--abu-text-primary)]">{m.name}</div>
          <div className="text-xs text-[var(--abu-text-secondary)] mt-1">{m.description}</div>
          {m.endpoint && (
            <div className="text-[10px] text-[var(--abu-text-tertiary)] font-mono mt-1">{m.endpoint}</div>
          )}
        </div>
      ))}
    </div>
  )
}

registerEnterpriseMount('mcpTab', EnterpriseMcpTab as ComponentType<TabSlotProps>)

export default EnterpriseMcpTab
