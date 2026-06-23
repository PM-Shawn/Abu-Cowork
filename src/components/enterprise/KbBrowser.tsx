// src/components/enterprise/KbBrowser.tsx
import { useState } from 'react'
import type { ComponentType } from 'react'
import { Search, BookOpen } from 'lucide-react'
import type { KbModuleProps } from '@/core/enterprise/mounts'
import { registerEnterpriseMount } from '@/core/enterprise/mounts'
import { useEnterpriseKbStore } from '@/stores/enterpriseKbStore'
import { queryKb, type KbQueryChunk } from '@/core/enterprise/kb/api'
import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import PersonalKbView from './PersonalKbView'

type KbTab = 'enterprise' | 'personal'

function KbBrowser(_props: KbModuleProps) {
  const catalog = useEnterpriseKbStore(s => s.catalog)
  const syncErr = useEnterpriseKbStore(s => s.syncError)
  const [tab, setTab] = useState<KbTab>('enterprise')
  const [selected, setSelected] = useState<string>('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<KbQueryChunk[]>([])
  const [err, setErr] = useState<string | null>(null)

  const kbOptions = [
    { value: '', label: '选择知识库...' },
    ...(catalog?.map(kb => ({
      value: kb.id,
      label: kb.description ? `${kb.name} · ${kb.description}` : kb.name,
    })) ?? []),
  ]

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!selected || !q.trim()) return
    setBusy(true); setErr(null)
    try {
      const r = await queryKb(selected, q.trim(), 8)
      setResults(r.results)
    } catch (ex) {
      setErr((ex as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col h-full bg-neutral-900 text-neutral-200">
      <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-2">
        <BookOpen className="h-3.5 w-3.5 text-neutral-400" />
        <h2 className="text-sm font-medium flex-1">知识库</h2>
        <div className="flex gap-1 text-xs">
          <button
            onClick={() => setTab('enterprise')}
            className={`px-2 py-1 rounded transition-colors ${tab === 'enterprise' ? 'bg-orange-500/20 text-orange-400' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            企业 ({catalog?.length ?? 0})
          </button>
          <button
            onClick={() => setTab('personal')}
            className={`px-2 py-1 rounded transition-colors ${tab === 'personal' ? 'bg-emerald-500/20 text-emerald-400' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            个人
          </button>
        </div>
      </div>

      {tab === 'personal' ? (
        <PersonalKbView />
      ) : (
        <>
          {syncErr && (
            <div className="px-4 py-2 text-[10px] text-amber-400 bg-amber-500/10">{syncErr}</div>
          )}

          <div className="p-4 border-b border-neutral-800">
            <Select
              value={selected}
              onChange={setSelected}
              options={kbOptions}
            />
            <form onSubmit={run} className="mt-2 flex gap-2">
              <div className="relative flex-1">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none" />
                <Input
                  value={q}
                  onChange={e => setQ(e.target.value)}
                  placeholder="问点什么..."
                  className="pl-8"
                />
              </div>
              <Button
                type="submit"
                disabled={busy || !selected || !q.trim()}
                size="default"
              >
                {busy ? '...' : '查询'}
              </Button>
            </form>
            {err && <div className="mt-2 text-xs text-rose-400">{err}</div>}
          </div>

          <ScrollArea className="flex-1 p-4">
            {results.length === 0 ? (
              <div className="text-xs text-neutral-500 text-center py-8">
                {busy ? '检索中...' : '选择 KB 并输入问题开始检索'}
              </div>
            ) : (
              <ul className="space-y-3">
                {results.map((r, i) => (
                  <li key={r.id} className="p-3 rounded bg-neutral-800 border border-neutral-700">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="text-[10px] text-neutral-500">
                        #{i + 1} · score {r.score.toFixed(4)}{r.filename && (
                          <> · <span className="font-mono">{r.filename}</span></>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-neutral-200 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                      {r.text}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </>
      )}
    </div>
  )
}

registerEnterpriseMount('kbModule', KbBrowser as ComponentType<KbModuleProps>)

export default KbBrowser
