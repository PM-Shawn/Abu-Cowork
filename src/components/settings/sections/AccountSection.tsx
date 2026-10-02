import EnterpriseAccountSlot from '@enterprise-modules/components/enterprise/EnterpriseAccountSlot';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
import { useAccountStore } from '@/core/account/accountStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';

export default function AccountSection() {
  const status = useAccountStore((state) => state.status);
  const account = useAccountStore((state) => state.account);
  const profileStatus = useAccountStore((state) => state.profileStatus);
  const hydrate = useAccountStore((state) => state.hydrate);
  const signOut = useAccountStore((state) => state.signOut);
  const openAccountLogin = useSettingsStore((state) => state.openAccountLogin);
  const { t } = useI18n();
  const expired = status === 'expired' && account !== null;
  const signedIn = status === 'signed_in' && account !== null;

  return (
    <div className="space-y-5">
      <SettingsSectionHeader title={t.account.title} description={t.account.description} />

      <EnterpriseAccountSlot>
      {!signedIn && !expired ? (
        <section className="space-y-4 rounded-panel border border-separator p-4">
          <p className="text-ui text-label-secondary">
            {t.account.localWithoutLogin}
          </p>
          <Button variant="primary" icon={AppIcons.signIn} onClick={openAccountLogin}>
            {t.account.loginRegister}
          </Button>
        </section>
      ) : (
        <section className="space-y-4 rounded-panel border border-separator p-4">
          {expired && <InlineMessage tone="danger">{t.account.sessionExpired}</InlineMessage>}

          {profileStatus === 'loading' && (
            <div><Spinner label={t.account.profileLoading} /></div>
          )}

          {profileStatus === 'error' && !expired && (
            <InlineMessage
              tone="warning"
              action={(
                <Button variant="plain" size="sm" icon={AppIcons.retry} onClick={() => void hydrate()}>
                  {t.account.reloadProfile}
                </Button>
              )}
            >
              {t.account.profileUnavailable}
            </InlineMessage>
          )}

          {(account.name || account.email) && (
            <dl className="space-y-3">
              {account.name && (
                <div className="flex items-center justify-between gap-6 text-ui">
                  <dt className="text-label-tertiary">{t.account.name}</dt>
                  <dd className="min-w-0 truncate font-medium text-label">
                    {account.name}
                  </dd>
                </div>
              )}
              {account.email && (
                <div className="flex items-center justify-between gap-6 text-ui">
                  <dt className="text-label-tertiary">{t.account.email}</dt>
                  <dd className="min-w-0 truncate text-label">
                    {account.email}
                  </dd>
                </div>
              )}
            </dl>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {expired && (
              <Button variant="primary" icon={AppIcons.signIn} onClick={openAccountLogin}>
                {t.account.retry}
              </Button>
            )}
            <Button variant="secondary" icon={AppIcons.signOut} onClick={() => void signOut()}>
              {t.account.signOut}
            </Button>
          </div>
        </section>
      )}
      </EnterpriseAccountSlot>
    </div>
  );
}
