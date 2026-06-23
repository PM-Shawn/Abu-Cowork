// src/components/enterprise/EnterpriseLlmBadge.tsx
import { useEnterpriseStore } from '@/stores/enterpriseStore'

export default function EnterpriseLlmBadge() {
  const mode = useEnterpriseStore(s => s.mode)
  if (mode.kind === 'personal') return null
  const b = (mode.kind === 'enterprise' || mode.kind === 'offline') ? mode.binding : null
  if (!b) return null

  return (
    <div className="p-4 rounded-lg bg-orange-500/10 border border-orange-500/30 text-sm space-y-2">
      <div className="font-medium text-orange-400">使用企业 AI 网关</div>
      <p className="text-xs text-neutral-300">
        所有 LLM 调用通过企业网关，无需在此配置 API key。模型可用性由企业管理员决定。
      </p>
      <dl className="text-xs text-neutral-400 space-y-1">
        <div className="flex justify-between">
          <dt>组织</dt>
          <dd>{b.orgName}</dd>
        </div>
        <div className="flex justify-between">
          <dt>网关</dt>
          <dd className="font-mono truncate max-w-[200px]">{b.llmEndpoint ?? '—'}</dd>
        </div>
        {mode.kind === 'offline' && (
          <div className="flex justify-between text-amber-400">
            <dt>状态</dt>
            <dd>离线</dd>
          </div>
        )}
      </dl>
    </div>
  )
}
