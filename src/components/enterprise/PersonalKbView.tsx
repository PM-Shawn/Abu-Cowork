// src/components/enterprise/PersonalKbView.tsx
// Employee personal KB management: list / create / upload docs / delete.
import { useEffect, useState } from 'react'
import { Plus, Trash2, Upload, FileText, ArrowLeft } from 'lucide-react'
import {
  listMyKbs, createMyKb, deleteMyKb, listMyKbDocs, uploadMyKbDoc, deleteMyKbDoc,
  type PersonalKbDoc,
} from '@/core/enterprise/kb/personal-api'
import type { KbCatalogEntry } from '@/core/enterprise/kb/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function fmtSize(b: number): string {
  if (b < 1024) return `${b}B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${(b / 1024 / 1024).toFixed(1)}MB`
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-neutral-700 text-neutral-400',
  parsing: 'bg-blue-500/20 text-blue-400',
  embedding: 'bg-purple-500/20 text-purple-400',
  ready: 'bg-emerald-500/20 text-emerald-400',
  failed: 'bg-rose-500/20 text-rose-400',
}

export default function PersonalKbView() {
  const [kbs, setKbs] = useState<KbCatalogEntry[]>([])
  const [selectedKbId, setSelectedKbId] = useState<string | null>(null)
  const [docs, setDocs] = useState<PersonalKbDoc[]>([])
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [newKbName, setNewKbName] = useState('')

  useEffect(() => {
    listMyKbs().then(setKbs).catch(e => setErr((e as Error).message))
  }, [])

  // Fetch docs and poll while any doc is pending/processing
  useEffect(() => {
    if (!selectedKbId) { setDocs([]); return }
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const fetchDocs = () => {
      listMyKbDocs(selectedKbId).then(rows => {
        if (cancelled) return
        setDocs(rows)
        const hasPending = rows.some(d => ['pending', 'parsing', 'embedding'].includes(d.status))
        if (hasPending && !timer) {
          timer = setInterval(() => {
            listMyKbDocs(selectedKbId).then(r => { if (!cancelled) setDocs(r) }).catch(() => undefined)
          }, 3000)
        } else if (!hasPending && timer) {
          clearInterval(timer)
          timer = null
        }
      }).catch(e => { if (!cancelled) setErr((e as Error).message) })
    }
    fetchDocs()
    return () => { cancelled = true; if (timer) clearInterval(timer) }
  }, [selectedKbId])

  const handleCreateKb = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newKbName.trim()) return
    setBusy('create'); setErr(null)
    try {
      await createMyKb({ name: newKbName.trim() })
      setNewKbName(''); setCreating(false)
      setKbs(await listMyKbs())
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleDeleteKb = async (id: string) => {
    if (!confirm('删除这个 KB？所有文档和 chunks 一起删除')) return
    setBusy('del-' + id); setErr(null)
    try {
      await deleteMyKb(id)
      setKbs(kbs.filter(k => k.id !== id))
      if (selectedKbId === id) setSelectedKbId(null)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleUpload = async (file: File) => {
    if (!selectedKbId) return
    setBusy('upload'); setErr(null)
    try {
      await uploadMyKbDoc(selectedKbId, file)
      setDocs(await listMyKbDocs(selectedKbId))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const handleDeleteDoc = async (docId: string) => {
    if (!selectedKbId) return
    if (!confirm('删除此文档？')) return
    setBusy('del-doc-' + docId)
    try {
      await deleteMyKbDoc(selectedKbId, docId)
      setDocs(docs.filter(d => d.id !== docId))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // === Detail view ===
  if (selectedKbId) {
    const kb = kbs.find(k => k.id === selectedKbId)
    return (
      <div className="flex flex-col h-full bg-neutral-900 text-neutral-200">
        <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-2">
          <button
            onClick={() => setSelectedKbId(null)}
            className="text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <h3 className="text-sm font-medium flex-1">{kb?.name ?? selectedKbId}</h3>
          <label className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-orange-500 text-black text-[10px] font-medium cursor-pointer hover:bg-orange-400 transition-colors">
            <Upload className="h-3 w-3" />
            {busy === 'upload' ? '...' : '上传'}
            <input
              type="file"
              hidden
              accept=".pdf,.docx,.md,.markdown,.html,.htm,.txt"
              disabled={busy === 'upload'}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f) }}
            />
          </label>
        </div>
        {err && <div className="px-4 py-2 text-xs text-rose-400 bg-rose-500/10">{err}</div>}
        <div className="flex-1 overflow-auto p-3 space-y-2">
          {docs.length === 0 && (
            <div className="text-xs text-neutral-500 text-center py-8">还没有文档</div>
          )}
          {docs.map(d => (
            <div key={d.id} className="p-2.5 rounded bg-neutral-800 border border-neutral-700 flex items-center gap-2 group">
              <FileText className="h-3 w-3 text-neutral-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs truncate">{d.filename}</div>
                <div className="text-[10px] text-neutral-500 mt-0.5">
                  {fmtSize(d.sizeBytes)} ·{' '}
                  <span className={`px-1.5 py-0.5 rounded ${STATUS_COLOR[d.status] ?? 'bg-neutral-700 text-neutral-400'}`}>
                    {d.status}
                  </span>
                  {d.error && <span className="ml-1 text-rose-400">{d.error}</span>}
                </div>
              </div>
              <button
                onClick={() => handleDeleteDoc(d.id)}
                disabled={!!busy}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-neutral-700 rounded text-rose-400 disabled:opacity-30 transition-opacity"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // === List view ===
  return (
    <div className="flex flex-col h-full bg-neutral-900 text-neutral-200">
      <div className="px-4 py-3 border-b border-neutral-800 flex items-center gap-2">
        <h3 className="text-sm font-medium flex-1">个人 KB ({kbs.length})</h3>
        <Button
          size="xs"
          onClick={() => setCreating(true)}
          className="bg-orange-500 text-black hover:bg-orange-400"
        >
          <Plus className="h-3 w-3 mr-1" /> 新建
        </Button>
      </div>
      {err && <div className="px-4 py-2 text-xs text-rose-400 bg-rose-500/10">{err}</div>}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {kbs.length === 0 && (
          <div className="text-xs text-neutral-500 text-center py-8">
            还没有个人 KB（仅你可见）
          </div>
        )}
        {kbs.map(kb => (
          <div key={kb.id} className="p-3 rounded bg-neutral-800 border border-neutral-700 flex items-center gap-2 group">
            <button onClick={() => setSelectedKbId(kb.id)} className="flex-1 text-left min-w-0">
              <div className="text-sm font-medium truncate">{kb.name}</div>
              {kb.description && (
                <div className="text-[10px] text-neutral-400 mt-0.5 truncate">{kb.description}</div>
              )}
            </button>
            <button
              onClick={() => handleDeleteKb(kb.id)}
              disabled={busy === 'del-' + kb.id}
              className="opacity-0 group-hover:opacity-100 p-1 hover:bg-neutral-700 rounded text-rose-400 disabled:opacity-30 transition-opacity"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {creating && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setCreating(false)}
        >
          <form
            onClick={e => e.stopPropagation()}
            onSubmit={handleCreateKb}
            className="bg-neutral-900 border border-neutral-700 rounded-lg p-5 w-80 space-y-3"
          >
            <div className="text-sm font-medium">新建个人 KB</div>
            <Input
              autoFocus
              value={newKbName}
              onChange={e => setNewKbName(e.target.value)}
              placeholder="名称"
              required
            />
            <div className="text-[10px] text-neutral-500">
              scope=personal_synced — 仅你本人可见，存企业内网
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={busy === 'create'}
                className="bg-orange-500 text-black hover:bg-orange-400"
              >
                {busy === 'create' ? '...' : '创建'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
