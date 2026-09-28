// src/components/settings/sections/EnterpriseSection.tsx
import { useI18n } from '@/i18n'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { MountPoint } from '@/core/enterprise/mounts'
import { Button } from '@/components/ui/button'
import EnterpriseConnectionSlot from '@/components/enterprise/EnterpriseConnectionSlot'
// Side-effect import: registers BrandSlot in the enterprise mounts registry.
import '@/components/enterprise/BrandSlot'

export default function EnterpriseSection() {
  const { t } = useI18n()
  const mode = useEnterpriseStore(s => s.mode)
  const unbind = useEnterpriseStore(s => s.unbind)

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
    </div>
  )
}
