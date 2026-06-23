// src/components/enterprise/MigrationWizard.tsx
// Personal-to-enterprise data migration wizard.
// Three steps: scanning → selecting → uploading → done.
import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, XCircle, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { scanAll, type ScanResult } from '@/core/enterprise/migration/scanner'
import { runMigration, type MigrationProgress, type MigrationItemResult } from '@/core/enterprise/migration/migrator'

type WizardStep = 'scanning' | 'select' | 'uploading' | 'done'

export default function MigrationWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<WizardStep>('scanning')
  const [scan, setScan] = useState<ScanResult>({ skills: [], memories: [] })
  const [selSkills, setSelSkills] = useState<Set<string>>(new Set())
  const [selMems, setSelMems] = useState<Set<string>>(new Set())
  const [progress, setProgress] = useState<MigrationProgress | null>(null)
  const [results, setResults] = useState<MigrationItemResult[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    scanAll()
      .then(r => {
        setScan(r)
        // Default: select all discovered items
        setSelSkills(new Set(r.skills.map(s => s.name)))
        setSelMems(new Set(r.memories.map(m => m.filename)))
        setStep('select')
      })
      .catch(e => {
        setErr((e as Error).message)
        setStep('select')
      })
  }, [])

  const startMigration = async () => {
    setStep('uploading')
    setErr(null)
    try {
      const r = await runMigration(
        {
          selectedSkills: scan.skills.filter(s => selSkills.has(s.name)),
          selectedMemories: scan.memories.filter(m => selMems.has(m.filename)),
        },
        p => setProgress(p),
      )
      setResults(r)
      setStep('done')
    } catch (e) {
      setErr((e as Error).message)
      setStep('done')
    }
  }

  const totalSelected = selSkills.size + selMems.size

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="bg-neutral-900 border border-neutral-700 rounded-lg w-[520px] max-h-[80vh] overflow-auto"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-neutral-100">从个人版迁移数据</h2>
          <button
            onClick={onClose}
            className="text-neutral-500 hover:text-neutral-300 text-xs"
          >
            关闭
          </button>
        </div>

        {/* Step: scanning */}
        {step === 'scanning' && (
          <div className="p-6 text-center">
            <Loader2 className="h-5 w-5 animate-spin text-orange-400 inline" />
            <div className="text-xs text-neutral-400 mt-2">正在扫描本地数据...</div>
          </div>
        )}

        {/* Step: select */}
        {step === 'select' && (
          <div className="p-5 space-y-4">
            {err && <div className="text-xs text-rose-400">{err}</div>}

            <p className="text-xs text-neutral-400">
              选择要迁移到企业版的项目。迁移后原个人版数据保留在本机，不会被删除。
            </p>

            {/* Skills section */}
            <section>
              <div className="text-xs font-medium text-neutral-300 mb-2">
                本地 Skills ({scan.skills.length})
              </div>
              {scan.skills.length === 0 ? (
                <div className="text-xs text-neutral-500">未发现本地 Skills</div>
              ) : (
                <>
                  <ul className="space-y-1 max-h-40 overflow-auto">
                    {scan.skills.map(s => (
                      <li key={s.name} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={selSkills.has(s.name)}
                          onChange={e => {
                            const next = new Set(selSkills)
                            if (e.target.checked) next.add(s.name)
                            else next.delete(s.name)
                            setSelSkills(next)
                          }}
                        />
                        <span className="text-neutral-200">{s.name}</span>
                        {!s.hasManifest && (
                          <span className="text-[10px] text-amber-400">
                            (将自动生成 manifest)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="text-[10px] text-neutral-500 mt-1">
                    注：上传至企业市场需要管理员审核权限，普通员工上传后会收到提示，请联系管理员处理
                  </div>
                </>
              )}
            </section>

            {/* Memories section */}
            <section>
              <div className="text-xs font-medium text-neutral-300 mb-2">
                本地记忆 ({scan.memories.length})
              </div>
              {scan.memories.length === 0 ? (
                <div className="text-xs text-neutral-500">未发现本地记忆文件</div>
              ) : (
                <>
                  <ul className="space-y-1 max-h-40 overflow-auto">
                    {scan.memories.map(m => (
                      <li key={m.filename} className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={selMems.has(m.filename)}
                          onChange={e => {
                            const next = new Set(selMems)
                            if (e.target.checked) next.add(m.filename)
                            else next.delete(m.filename)
                            setSelMems(next)
                          }}
                        />
                        <span className="text-neutral-200">{m.filename}</span>
                        <span className="text-[10px] text-neutral-500">{m.sizeBytes} B</span>
                      </li>
                    ))}
                  </ul>
                  <div className="text-[10px] text-neutral-500 mt-1">
                    将上传到个人 KB「我的记忆」（仅你本人可见）
                  </div>
                </>
              )}
            </section>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                取消
              </Button>
              <Button
                size="sm"
                disabled={totalSelected === 0}
                onClick={() => void startMigration()}
              >
                <Upload className="h-3 w-3 mr-1" />
                开始迁移 ({totalSelected})
              </Button>
            </div>
          </div>
        )}

        {/* Step: uploading */}
        {step === 'uploading' && (
          <div className="p-6 text-center space-y-3">
            <Loader2 className="h-5 w-5 animate-spin text-orange-400 inline" />
            {progress && (
              <div className="text-xs text-neutral-400">
                {progress.step === 'skill' &&
                  `上传 Skill ${progress.index}/${progress.total}: ${progress.current}`}
                {progress.step === 'memory' &&
                  `上传记忆 ${progress.index}/${progress.total}: ${progress.current}`}
                {progress.step === 'starting' && '准备中...'}
              </div>
            )}
          </div>
        )}

        {/* Step: done */}
        {step === 'done' && (
          <div className="p-5 space-y-3">
            <div className="text-sm font-medium text-neutral-100">迁移完成</div>
            {err && <div className="text-xs text-rose-400">{err}</div>}
            {results.length === 0 && !err && (
              <div className="text-xs text-neutral-500">未迁移任何项目</div>
            )}
            <ul className="space-y-1 text-xs max-h-60 overflow-auto">
              {results.map((r, i) => (
                <li key={i} className="flex items-start gap-2">
                  {r.ok ? (
                    <CheckCircle2 className="h-3 w-3 text-emerald-400 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="h-3 w-3 text-rose-400 mt-0.5 shrink-0" />
                  )}
                  <div className="flex-1">
                    <div className="text-neutral-200">
                      {r.kind === 'skill' ? '[Skill] ' : '[记忆] '}
                      {r.name}
                    </div>
                    {r.error && (
                      <div className="text-[10px] text-rose-400 mt-0.5">{r.error}</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={onClose}>
                关闭
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
