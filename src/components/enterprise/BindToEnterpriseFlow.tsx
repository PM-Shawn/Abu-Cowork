// src/components/enterprise/BindToEnterpriseFlow.tsx
import { useState } from 'react'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { startBind } from '@/core/enterprise/auth'
import { callEnterprise } from '@/core/enterprise/api'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export default function BindToEnterpriseFlow({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [serverUrl, setServerUrl] = useState('')
  const [userCode, setUserCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const bind = useEnterpriseStore(s => s.bind)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!serverUrl) return
    setBusy(true); setErr(null)
    try {
      const { initResp, result } = await startBind(serverUrl, navigator.userAgent.slice(0, 80))
      setUserCode(initResp.user_code)
      const r = await result
      // bound — now fetch heartbeat for user / org info
      const heart = await callEnterprise<Record<string, Record<string, string | null>>>('/api/client/heartbeat', { method: 'POST', serverUrl: r.serverUrl })
      await bind({
        serverUrl: r.serverUrl,
        orgId: heart.org?.id ?? '',
        orgName: heart.org?.name ?? '',
        userId: heart.user?.id ?? '',
        userName: heart.user?.name ?? '',
        userEmail: heart.user?.email ?? '',
        deptId: heart.user?.deptId ?? null,
        roleId: null,
        accessToken: r.accessToken,
        boundAt: new Date().toISOString(),
        // === Plan 2.C: LLM gateway — prefer bind response, fall back to heartbeat ===
        llmEndpoint: r.llmEndpoint ?? heart.llm?.endpoint ?? null,
        llmVirtualKey: r.llmVirtualKey ?? null,
        llmKeyExpiresAt: heart.llm?.virtualKeyExpiresAt ?? null,
      })
      onDone()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 w-[420px]">
        <h2 className="text-base font-semibold mb-2">绑定到企业实例</h2>
        <p className="text-xs text-neutral-400 mb-4">绑定后将切换到企业模式，使用企业提供的 LLM 网关和 Skill / MCP 市场。</p>
        {!userCode ? (
          <form onSubmit={submit}>
            <label className="block text-xs text-neutral-300 mb-1">企业 Abu 实例 URL</label>
            <Input
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              placeholder="https://abu.your-company.com"
              required
            />
            {err && <div className="text-xs text-rose-400 mt-2">{err}</div>}
            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onCancel}>取消</Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? '处理中...' : '继续'}
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <p className="text-xs text-neutral-300 mb-2">浏览器已打开，请确认这个代码在浏览器页面里显示：</p>
            <div className="text-2xl font-mono tracking-widest text-center py-3 bg-neutral-800 rounded">{userCode}</div>
            <p className="text-xs text-neutral-500 mt-2">完成 SSO 登录后会自动绑定...</p>
            {err && <div className="text-xs text-rose-400 mt-2">{err}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
