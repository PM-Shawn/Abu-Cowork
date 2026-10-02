import { useCallback, useEffect, useRef } from 'react';
import { Dialog } from '@/components/ds/dialog';
import { useAccountStore } from '@/core/account/accountStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { startEnterpriseAccountLogin } from '@/core/enterprise/accountLogin';
import LoginPage, { type LoginPageStatus } from './LoginPage';

/** Centered account entry dialog shared by the sidebar and account settings. */
export default function AccountLoginDialog() {
  const open = useSettingsStore((state) => state.accountLoginOpen);
  const close = useSettingsStore((state) => state.closeAccountLogin);
  const openSystemSettings = useSettingsStore((state) => state.openSystemSettings);
  const status = useAccountStore((state) => state.status);
  const account = useAccountStore((state) => state.account);
  const error = useAccountStore((state) => state.error);
  const startPersonalLogin = useAccountStore((state) => state.startPersonalLogin);
  const cancel = useAccountStore((state) => state.cancel);
  const signOut = useAccountStore((state) => state.signOut);
  const { t } = useI18n();
  const personalStartRequested = useRef(false);

  const cancelAttempt = useCallback(() => {
    personalStartRequested.current = false;
    cancel();
  }, [cancel]);

  const closeDialog = useCallback(() => {
    if (
      personalStartRequested.current ||
      status === 'awaiting_browser' ||
      status === 'exchanging'
    ) cancelAttempt();
    close();
  }, [cancelAttempt, close, status]);

  useEffect(() => {
    if (open && status === 'signed_in') {
      personalStartRequested.current = false;
      close();
    }
  }, [close, open, status]);

  useEffect(() => {
    if (!open) {
      personalStartRequested.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (error) personalStartRequested.current = false;
  }, [error]);

  // The window is on screen until it is closed or the sign-in has finished. It stays on the
  // page while it fades out; its buttons do nothing then.
  const shown = open && status !== 'signed_in';
  // A finished sign-in fades out on the sentence it was showing.
  const pageStatus: LoginPageStatus = status === 'signed_in' ? 'exchanging' : status;

  return (
    <Dialog
      open={shown}
      onOpenChange={(next) => { if (!next) closeDialog(); }}
      title={t.account.loginRegister}
      size="sm"
      closeButton={{ 'data-abu-account-dialog-close': '' }}
      contentProps={{ 'data-abu-account-dialog': '' }}
    >
      <LoginPage
        status={pageStatus}
        error={error}
        hasAccount={account !== null}
        onPersonalLogin={() => {
          if (!shown) return;
          personalStartRequested.current = true;
          void startPersonalLogin();
        }}
        onEnterpriseLogin={() => {
          if (!shown) return;
          if (personalStartRequested.current) cancelAttempt();
          close();
          void startEnterpriseAccountLogin()
            .then((result) => {
              if (result === 'configuration_required') openSystemSettings('enterprise');
            })
            .catch(() => openSystemSettings('enterprise'));
        }}
        onCancel={() => { if (shown) cancelAttempt(); }}
        onSignOut={() => { if (shown) void signOut(); }}
      />
    </Dialog>
  );
}
