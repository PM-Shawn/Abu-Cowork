import { CircleAlert, LoaderCircle, LogIn, LogOut, RefreshCw } from 'lucide-react';
import { useAccountStore } from '@/core/account/accountStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
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

      {!signedIn && !expired ? (
        <section className="space-y-4 rounded-xl border border-[var(--abu-border)] p-4">
          <p className="text-body text-[var(--abu-text-secondary)]">
            {t.account.localWithoutLogin}
          </p>
          <Button onClick={openAccountLogin}>
            <LogIn aria-hidden="true" />
            {t.account.loginRegister}
          </Button>
        </section>
      ) : (
        <section className="space-y-4 rounded-xl border border-[var(--abu-border)] p-4">
          {expired && (
            <div className="flex items-start gap-2 rounded-xl bg-[var(--abu-danger-bg)] px-3 py-2.5 text-minor text-[var(--abu-danger)]">
              <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t.account.sessionExpired}</span>
            </div>
          )}

          {profileStatus === 'loading' && (
            <div className="flex items-center gap-2 text-body text-[var(--abu-text-tertiary)]">
              <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
              {t.account.profileLoading}
            </div>
          )}

          {profileStatus === 'error' && !expired && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--abu-bg-muted)] px-3 py-2.5">
              <span className="text-minor text-[var(--abu-text-tertiary)]">
                {t.account.profileUnavailable}
              </span>
              <Button size="sm" variant="subtle" onClick={() => void hydrate()}>
                <RefreshCw aria-hidden="true" />
                {t.account.reloadProfile}
              </Button>
            </div>
          )}

          {(account.name || account.email) && (
            <dl className="space-y-3 text-body">
              {account.name && (
                <div className="flex items-center justify-between gap-6">
                  <dt className="text-[var(--abu-text-tertiary)]">{t.account.name}</dt>
                  <dd className="min-w-0 truncate font-medium text-[var(--abu-text-primary)]">
                    {account.name}
                  </dd>
                </div>
              )}
              {account.email && (
                <div className="flex items-center justify-between gap-6">
                  <dt className="text-[var(--abu-text-tertiary)]">{t.account.email}</dt>
                  <dd className="min-w-0 truncate text-[var(--abu-text-primary)]">
                    {account.email}
                  </dd>
                </div>
              )}
            </dl>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {expired && (
              <Button onClick={openAccountLogin}>
                <LogIn aria-hidden="true" />
                {t.account.retry}
              </Button>
            )}
            <Button variant="destructive" onClick={() => void signOut()}>
              <LogOut aria-hidden="true" />
              {t.account.signOut}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
