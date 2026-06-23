// src/components/enterprise/EnterpriseSkillTab.tsx
import { useState } from 'react'
import type { ComponentType } from 'react'
import { Download, Trash2, RefreshCw, Cloud, CloudOff } from 'lucide-react'
import type { TabSlotProps } from '@/core/enterprise/mounts'
import { registerEnterpriseMount } from '@/core/enterprise/mounts'
import { useEnterpriseSkillStore, type CatalogEntry } from '@/stores/enterpriseSkillStore'
import { syncCatalogOnce } from '@/core/enterprise/skill/catalog-sync'
import { installSkill, uninstallSkill } from '@/core/enterprise/skill/installer'

function EnterpriseSkillTab(_props: TabSlotProps) {
  const catalog = useEnterpriseSkillStore(s => s.catalog)
  const installed = useEnterpriseSkillStore(s => s.installed)
  const syncErr = useEnterpriseSkillStore(s => s.syncError)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const installedByName = new Map(installed.map(i => [i.name, i.installedVersion]))

  const act = async (entry: CatalogEntry, kind: 'install' | 'update' | 'uninstall') => {
    setBusy(entry.id + kind)
    setErr(null)
    try {
      if (kind === 'uninstall') {
        await uninstallSkill(entry.name)
      } else {
        await installSkill(entry.id, entry.latestVersionId)
      }
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col h-full bg-neutral-900 text-neutral-200">
      <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-2">
        <h2 className="text-sm font-medium flex-1">企业 Skill ({catalog?.length ?? 0})</h2>
        <button
          onClick={() => { void syncCatalogOnce() }}
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
      {err && (
        <div className="px-4 py-2 text-xs text-rose-400 bg-rose-500/10">{err}</div>
      )}

      <div className="flex-1 overflow-auto">
        {catalog === null ? (
          <div className="p-6 text-xs text-neutral-500">加载中...</div>
        ) : catalog.length === 0 ? (
          <div className="p-6 text-xs text-neutral-500 text-center">企业还未发布 Skill</div>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {catalog.map(e => {
              const installedVer = installedByName.get(e.name)
              const upToDate = installedVer === e.latestVersion
              return (
                <li key={e.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{e.name}</div>
                      <div className="text-[10px] text-neutral-500 font-mono mt-0.5">
                        v{e.latestVersion}
                        {installedVer && installedVer !== e.latestVersion
                          ? ` · 已装 v${installedVer}`
                          : ''}
                      </div>
                      {e.description && (
                        <div className="text-xs text-neutral-400 mt-1">{e.description}</div>
                      )}
                    </div>
                    <div>
                      {!installedVer && (
                        <button
                          onClick={() => { void act(e, 'install') }}
                          disabled={busy === e.id + 'install'}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-orange-500 text-black text-[10px] font-medium disabled:opacity-50"
                        >
                          <Download className="h-3 w-3" />
                          {busy === e.id + 'install' ? '...' : '安装'}
                        </button>
                      )}
                      {installedVer && !upToDate && (
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => { void act(e, 'update') }}
                            disabled={busy === e.id + 'update'}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-orange-500 text-black text-[10px] font-medium disabled:opacity-50"
                          >
                            <Cloud className="h-3 w-3" />
                            {busy === e.id + 'update' ? '...' : '更新'}
                          </button>
                          <button
                            onClick={() => { void act(e, 'uninstall') }}
                            disabled={busy === e.id + 'uninstall'}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                      {installedVer && upToDate && (
                        <div className="flex gap-1.5">
                          <span className="text-[10px] text-emerald-400 px-2 py-1 rounded bg-emerald-500/10">
                            已是最新
                          </span>
                          <button
                            onClick={() => { void act(e, 'uninstall') }}
                            disabled={busy === e.id + 'uninstall'}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-[10px] disabled:opacity-50"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

registerEnterpriseMount('skillTab', EnterpriseSkillTab as ComponentType<TabSlotProps>)

export default EnterpriseSkillTab
