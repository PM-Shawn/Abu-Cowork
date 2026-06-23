// src/components/enterprise/EnterpriseMcpTab.tsx
import { useState } from 'react'
import type { ComponentType } from 'react'
import { Plus, Trash2, RefreshCw, CloudOff } from 'lucide-react'
import type { TabSlotProps } from '@/core/enterprise/mounts'
import { registerEnterpriseMount } from '@/core/enterprise/mounts'
import { useEnterpriseMcpStore } from '@/stores/enterpriseMcpStore'
import { syncMcpCatalogOnce } from '@/core/enterprise/mcp/catalog-sync'
import { installMcp, uninstallMcp } from '@/core/enterprise/mcp/installer'

function EnterpriseMcpTab(_props: TabSlotProps) {
  const catalog = useEnterpriseMcpStore(s => s.catalog)
  const installed = useEnterpriseMcpStore(s => s.installed)
  const syncErr = useEnterpriseMcpStore(s => s.syncError)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionErr, setActionErr] = useState<string | null>(null)

  const installedById = new Set(installed.map(i => i.id))

  const act = async (id: string, name: string, kind: 'install' | 'uninstall') => {
    setBusy(id + kind)
    setActionErr(null)
    try {
      if (kind === 'install') await installMcp(id, name)
      else await uninstallMcp(id)
    } catch (e) {
      setActionErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col h-full bg-neutral-900 text-neutral-200">
      <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-2">
        <h2 className="text-sm font-medium flex-1">企业 MCP ({catalog?.length ?? 0})</h2>
        <button
          onClick={() => { void syncMcpCatalogOnce() }}
          className="text-xs text-neutral-400 hover:text-neutral-200 flex items-center gap-1"
        >
          <RefreshCw className="h-3 w-3" /> 刷新
        </button>
      </div>

      {syncErr && (
        <div className="px-4 py-2 text-[10px] text-amber-400 bg-amber-500/10 flex items-center gap-1">
          <CloudOff className="h-3 w-3" />{syncErr}
        </div>
      )}
      {actionErr && (
        <div className="px-4 py-2 text-xs text-rose-400 bg-rose-500/10">{actionErr}</div>
      )}

      <div className="flex-1 overflow-auto">
        {catalog === null ? (
          <div className="p-6 text-xs text-neutral-500">加载中...</div>
        ) : catalog.length === 0 ? (
          <div className="p-6 text-xs text-neutral-500 text-center">企业未上架 MCP</div>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {catalog.map(e => {
              const isInst = installedById.has(e.id)
              return (
                <li key={e.id} className="px-4 py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{e.name}</div>
                    {e.description && (
                      <div className="text-xs text-neutral-400 mt-1">{e.description}</div>
                    )}
                    <div className="text-[10px] text-neutral-500 font-mono mt-1 truncate">{e.endpoint}</div>
                  </div>
                  {isInst ? (
                    <div className="flex gap-1.5 shrink-0">
                      <span className="text-[10px] text-emerald-400 px-2 py-1 rounded bg-emerald-500/10">
                        已安装
                      </span>
                      <button
                        onClick={() => { void act(e.id, e.name, 'uninstall') }}
                        disabled={busy === e.id + 'uninstall'}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] disabled:opacity-50"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { void act(e.id, e.name, 'install') }}
                      disabled={busy === e.id + 'install'}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-orange-500 text-black text-[10px] font-medium disabled:opacity-50 shrink-0"
                    >
                      <Plus className="h-3 w-3" />
                      {busy === e.id + 'install' ? '...' : '安装'}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

registerEnterpriseMount('mcpTab', EnterpriseMcpTab as ComponentType<TabSlotProps>)

export default EnterpriseMcpTab
