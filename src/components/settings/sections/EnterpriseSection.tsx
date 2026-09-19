// src/components/settings/sections/EnterpriseSection.tsx
import { useState } from 'react'
import { useI18n } from '@/i18n'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { MountPoint } from '@/core/enterprise/mounts'
import { getEnterpriseMount } from '@/core/enterprise/mounts-registry'
import { Button } from '@/components/ui/button'
import EnterpriseConnectionSlot from '@/components/enterprise/EnterpriseConnectionSlot'
// Side-effect import: registers BrandSlot in the enterprise mounts registry.
import '@/components/enterprise/BrandSlot'
// The /me transparency page and migration wizard are registered by the
// enterprise-modules entry point (real impls in the enterprise build, no-op in
// OSS). Read below via getEnterpriseMount() — NullComponent fallback in OSS, so
// this file never imports enterprise UI directly.

export default function EnterpriseSection() {
  const { t } = useI18n()
  const mode = useEnterpriseStore(s => s.mode)
  const unbind = useEnterpriseStore(s => s.unbind)
  const [showMe, setShowMe] = useState(false)
  const [showMigration, setShowMigration] = useState(false)

  if (mode.kind === 'personal') {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-h-sm font-semibold text-[var(--abu-text-primary)] mb-1">{t.enterprise.title}</h2>
          <p className="text-body text-[var(--abu-text-tertiary)]">
            {t.enterprise.description}
          </p>
        </div>
        <EnterpriseConnectionSlot />
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
        <h2 className="text-h-sm font-semibold text-[var(--abu-text-primary)] mb-1">
          {t.enterprise.title}
          {mode.kind === 'offline' && (
            <span className="ml-2 text-minor text-[var(--abu-warning)] font-normal">{t.enterprise.offlineBadge}</span>
          )}
        </h2>
        <p className="text-body text-[var(--abu-text-tertiary)]">{t.enterprise.boundStatus}</p>
      </div>

      <section className="space-y-3 rounded-xl border border-[var(--abu-border)] p-4">
        <MountPoint slot="brandSlot" binding={binding} config={config} size="md" />
        <dl className="mt-3 space-y-2 text-body">
          <div className="flex justify-between">
            <dt className="text-[var(--abu-text-tertiary)]">{t.enterprise.instanceLabel}</dt>
            <dd className="text-[var(--abu-text-primary)] font-mono text-minor">{binding?.serverUrl}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--abu-text-tertiary)]">{t.enterprise.loginIdentityLabel}</dt>
            <dd className="text-[var(--abu-text-primary)]">{binding?.userEmail}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--abu-text-tertiary)]">{t.enterprise.boundAtLabel}</dt>
            <dd className="text-[var(--abu-text-primary)]">{binding?.boundAt?.slice(0, 10)}</dd>
          </div>
          {config?.licenseStatus && (
            <div className="flex justify-between">
              <dt className="text-[var(--abu-text-tertiary)]">License</dt>
              <dd className={config.licenseStatus === 'valid' ? 'text-[var(--abu-success)]' : 'text-[var(--abu-warning)]'}>
                {config.licenseStatus}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <EnterpriseConnectionSlot currentServerUrl={binding?.serverUrl} />

      {/* /me transparency panel */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-body font-medium text-[var(--abu-text-primary)]">{t.enterprise.myDataTitle}</h3>
          <Button variant="ghost" size="sm" onClick={() => setShowMe(v => !v)}>
            {showMe ? t.enterprise.collapseData : t.enterprise.viewMyData}
          </Button>
        </div>
        {showMe && binding && (
          <MeView binding={binding} config={config} />
        )}
      </section>

      {/* Personal-to-enterprise migration */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-body font-medium text-[var(--abu-text-primary)]">{t.enterprise.migrationTitle}</h3>
          <Button variant="ghost" size="sm" onClick={() => setShowMigration(true)}>
            {t.enterprise.migrateButton}
          </Button>
        </div>
        <p className="text-minor text-[var(--abu-text-tertiary)]">
          {t.enterprise.migrateDescription}
        </p>
      </section>

      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          if (confirm(t.enterprise.unbindConfirm)) {
            void unbind()
          }
        }}
      >
        {t.enterprise.unbindButton}
      </Button>

      {showMigration && <MigrationWizard onClose={() => setShowMigration(false)} />}
    </div>
  )
}
