// src/components/settings/sections/EnterpriseSection.tsx
import { useI18n } from '@/i18n'
import { useEnterpriseStore } from '@/stores/enterpriseStore'
import { MountPoint } from '@/core/enterprise/mounts'
import { Button } from '@/components/ds/button'
import { useConfirm } from '@/components/ds/confirm-context'
import { StatusIcon } from '@/components/ds/status-icon'
import { Tag } from '@/components/ds/tag'
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader'
import EnterpriseConnectionSlot from '@/components/enterprise/EnterpriseConnectionSlot'
// Side-effect import: registers BrandSlot in the enterprise mounts registry.
import '@/components/enterprise/BrandSlot'

export default function EnterpriseSection() {
  const { t } = useI18n()
  const mode = useEnterpriseStore(s => s.mode)
  const unbind = useEnterpriseStore(s => s.unbind)
  const confirm = useConfirm()

  if (mode.kind === 'personal') {
    return (
      <div className="space-y-4">
        <SettingsSectionHeader title={t.enterprise.title} description={t.enterprise.description} />
        <EnterpriseConnectionSlot />
      </div>
    )
  }

  const binding = mode.kind === 'enterprise' || mode.kind === 'offline' ? mode.binding : null
  const config = mode.kind === 'enterprise' ? mode.config : mode.kind === 'offline' ? mode.lastConfig : null
  const licenseValid = config?.licenseStatus === 'valid'

  const askToUnbind = async () => {
    if (!await confirm({ title: t.enterprise.unbindConfirm, confirmLabel: t.enterprise.unbindButton, tone: 'danger' })) return
    // Read again at answer time: the binding may have gone while the question was open.
    if (useEnterpriseStore.getState().mode.kind !== 'personal') void unbind()
  }

  return (
    <div className="space-y-4">
      <div>
        <SettingsSectionHeader title={t.enterprise.title} description={t.enterprise.boundStatus} />
        {mode.kind === 'offline' && (
          <div className="mt-2"><Tag tone="warning">{t.enterprise.offlineBadge}</Tag></div>
        )}
      </div>

      <section className="space-y-3 rounded-panel border border-separator p-4">
        <MountPoint slot="brandSlot" binding={binding} config={config} size="md" />
        <dl className="mt-3 space-y-2 text-ui">
          <div className="flex justify-between">
            <dt className="text-label-tertiary">{t.enterprise.instanceLabel}</dt>
            <dd className="font-code text-ui-sm text-label">{binding?.serverUrl}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-label-tertiary">{t.enterprise.loginIdentityLabel}</dt>
            <dd className="text-label">{binding?.userEmail}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-label-tertiary">{t.enterprise.boundAtLabel}</dt>
            <dd className="text-label">{binding?.boundAt?.slice(0, 10)}</dd>
          </div>
          {config?.licenseStatus && (
            <div className="flex justify-between">
              <dt className="text-label-tertiary">License</dt>
              <dd className={licenseValid ? 'inline-flex items-center gap-1 text-success' : 'inline-flex items-center gap-1 text-warning'}>
                <StatusIcon tone={licenseValid ? 'success' : 'warning'} size="sm" />
                {config.licenseStatus}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <Button variant="danger" size="sm" onClick={() => void askToUnbind()}>
        {t.enterprise.unbindButton}
      </Button>
    </div>
  )
}
