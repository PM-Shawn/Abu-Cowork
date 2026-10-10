import { useCallback, useEffect, useRef, useState } from 'react';
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
  // A personal sign-in was asked for from this opening and has not ended. The ref is what the
  // handlers read; the state follows it so the window can say it has work in progress.
  const personalStartRequested = useRef(false);
  const [personalStartPending, setPersonalStartPending] = useState(false);
  const markPersonalStart = useCallback((requested: boolean) => {
    personalStartRequested.current = requested;
    setPersonalStartPending(requested);
  }, []);

  const cancelAttempt = useCallback(() => {
    markPersonalStart(false);
    cancel();
  }, [cancel, markPersonalStart]);

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
      markPersonalStart(false);
      close();
    }
  }, [close, markPersonalStart, open, status]);

  useEffect(() => {
    if (!open) {
      markPersonalStart(false);
    }
  }, [markPersonalStart, open]);

  useEffect(() => {
    if (error) markPersonalStart(false);
  }, [error, markPersonalStart]);

  // The window is on screen until it is closed or the sign-in has finished. It stays on the
  // page while it fades out; its buttons do nothing then.
  const shown = open && status !== 'signed_in';
  // A finished sign-in fades out on the sentence it was showing.
  const pageStatus: LoginPageStatus = status === 'signed_in' ? 'exchanging' : status;

  return (
    <Dialog
      open={shown}
      // Closing the window cancels a sign-in that is under way, so it steps aside for an
      // approval and returns afterwards. With no sign-in under way it closes for one, as any
      // window does, and cancels nothing.
      busy={status === 'awaiting_browser' || status === 'exchanging' || personalStartPending}
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
          markPersonalStart(true);
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
