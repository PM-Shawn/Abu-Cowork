// src/components/settings/sections/EnterpriseSection.tsx
import { useState } from 'react'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { MountPoint } from '@/core/enterprise/mounts'
import { getEnterpriseMount } from '@/core/enterprise/mounts-registry'
import { Button } from '@/components/ui/button'
import BindToEnterpriseFlow from '@/components/enterprise/BindToEnterpriseFlow'
// The /me transparency page and migration wizard are registered by the
// enterprise-modules entry point (real impls in the enterprise build, no-op in
// OSS). Read below via getEnterpriseMount() — NullComponent fallback in OSS, so
// this file never imports enterprise UI directly.

export default function EnterpriseSection() {
  const mode = useEnterpriseStore(s => s.mode)
  const unbind = useEnterpriseStore(s => s.unbind)
  const [showBind, setShowBind] = useState(false)
  const [showMe, setShowMe] = useState(false)
  const [showMigration, setShowMigration] = useState(false)

  if (mode.kind === 'personal') {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-[var(--abu-text-primary)] mb-1">企业模式</h2>
          <p className="text-sm text-[var(--abu-text-tertiary)]">
            绑定到你公司的 Abu 企业实例，使用统一的 LLM 网关、Skill 和 MCP 资源。
          </p>
        </div>
        <section className="space-y-3 rounded-xl border border-[var(--abu-border)] p-4">
          <h3 className="text-sm font-medium text-[var(--abu-text-primary)]">绑定企业实例</h3>
          <p className="text-xs text-[var(--abu-text-tertiary)]">
            绑定后将切换到企业模式，个人模式下的数据仍保留在本机，解绑后可恢复访问。
          </p>
          <Button size="sm" onClick={() => setShowBind(true)}>切换到企业模式</Button>
        </section>
        {showBind && (
          <BindToEnterpriseFlow
            onDone={() => setShowBind(false)}
            onCancel={() => setShowBind(false)}
          />
        )}
      </div>
    )
  }

  const binding = mode.kind === 'enterprise' || mode.kind === 'offline' ? mode.binding : null
  const config = mode.kind === 'enterprise' ? mode.config : mode.kind === 'offline' ? mode.lastConfig : null

  const MeView = getEnterpriseMount('meTransparencyPage')
  const MigrationWizard = getEnterpriseMount('migrationWizard')

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-[var(--abu-text-primary)] mb-1">
          企业模式
          {mode.kind === 'offline' && (
            <span className="ml-2 text-xs text-amber-400 font-normal">· 离线</span>
          )}
        </h2>
        <p className="text-sm text-[var(--abu-text-tertiary)]">已绑定到企业实例</p>
      </div>

      <section className="space-y-3 rounded-xl border border-[var(--abu-border)] p-4">
        <MountPoint slot="brandSlot" binding={binding} config={config} size="md" />
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--abu-text-tertiary)]">实例</dt>
            <dd className="text-[var(--abu-text-primary)] font-mono text-xs">{binding?.serverUrl}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--abu-text-tertiary)]">登录身份</dt>
            <dd className="text-[var(--abu-text-primary)]">{binding?.userEmail}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--abu-text-tertiary)]">绑定时间</dt>
            <dd className="text-[var(--abu-text-primary)]">{binding?.boundAt?.slice(0, 10)}</dd>
          </div>
          {config?.licenseStatus && (
            <div className="flex justify-between">
              <dt className="text-[var(--abu-text-tertiary)]">License</dt>
              <dd className={config.licenseStatus === 'valid' ? 'text-emerald-400' : 'text-amber-400'}>
                {config.licenseStatus}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {/* /me transparency panel */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--abu-text-primary)]">我的数据</h3>
          <Button variant="ghost" size="sm" onClick={() => setShowMe(v => !v)}>
            {showMe ? '收起' : '查看我的数据'}
          </Button>
        </div>
        {showMe && binding && (
          <MeView binding={binding} config={config} />
        )}
      </section>

      {/* Personal-to-enterprise migration */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-[var(--abu-text-primary)]">数据迁移</h3>
          <Button variant="ghost" size="sm" onClick={() => setShowMigration(true)}>
            从个人版迁移数据
          </Button>
        </div>
        <p className="text-xs text-[var(--abu-text-tertiary)]">
          将本地个人版的 Skills 和记忆上传到企业版，原数据保留不删除。
        </p>
      </section>

      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          if (confirm('解绑后将回到个人模式，企业 Skill / 用量将不再可见。确定解绑？')) {
            void unbind()
          }
        }}
      >
        解绑企业实例
      </Button>

      {showMigration && <MigrationWizard onClose={() => setShowMigration(false)} />}
    </div>
  )
}
