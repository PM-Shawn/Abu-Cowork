/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommandConfirmDialog, { type CommandConfirmRequest } from './CommandConfirmDialog';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';

// Pins the browser-confirmation button set: which scopes are offered is a
// security decision made by the requester (allowPersistentGrant), and the
// "always allow this site" click must both persist the verdict and resolve
// the approval — a dialog that only did one of the two would either nag
// forever or grant without asking.
describe('CommandConfirmDialog', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useSettingsStore.setState({ browserSitePermissions: {} });
  });

  afterEach(() => {
    cleanup();
  });

  function renderDialog(overrides: Partial<CommandConfirmRequest>) {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <CommandConfirmDialog
        request={{
          command: 'abu-browser__navigate (https://example.com)',
          level: 'warn',
          reason: 'reason',
          kind: 'browser',
          ...overrides,
        }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return { onConfirm, onCancel };
  }

  it('offers three choices when a persistent site grant is allowed', () => {
    renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });

    expect(screen.getByRole('button', { name: '仅本次对话' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '此网站以后都允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  it('"always allow" persists the exact origin and resolves the approval', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      browserOrigin: 'https://example.com',
      allowPersistentGrant: true,
    });

    await user.click(screen.getByRole('button', { name: '此网站以后都允许' }));

    expect(useSettingsStore.getState().browserSitePermissions['https://example.com']).toBe('allowed');
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('"just this once" resolves without persisting anything', async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({
      browserOrigin: 'https://example.com',
      allowPersistentGrant: true,
    });

    await user.click(screen.getByRole('button', { name: '仅本次对话' }));

    expect(useSettingsStore.getState().browserSitePermissions).toEqual({});
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('hides the persistent option when the requester forbids it (scripting tools)', () => {
    renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: false });

    expect(screen.queryByRole('button', { name: /以后都允许/ })).not.toBeInTheDocument();
    // Without the site-grant offer the confirm button keeps its default label.
    expect(screen.getByRole('button', { name: '确认执行' })).toBeInTheDocument();
  });

  it('hides the persistent option when the origin is unknown', () => {
    renderDialog({ browserOrigin: undefined, allowPersistentGrant: true });

    expect(screen.queryByRole('button', { name: /以后都允许/ })).not.toBeInTheDocument();
  });

  it('plain command confirmations are unchanged — two buttons, command wording', () => {
    renderDialog({ kind: 'command', browserOrigin: undefined, allowPersistentGrant: undefined });

    expect(screen.queryByRole('button', { name: /以后都允许/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  });

  // "Danger level decides whether you can settle it once and for all"
  // (permission plan §4.3). The dialog enforces that as a floor, so a caller
  // that misclassifies a high-consequence action still cannot mint a
  // permanent grant from it.
  describe('always-ask floor on the permanent grant', () => {
    it('withholds the permanent option for a danger-level browser action', () => {
      renderDialog({
        browserOrigin: 'https://bank.example.com',
        allowPersistentGrant: true,
        level: 'danger',
      });

      expect(screen.queryByRole('button', { name: /以后都允许/ })).not.toBeInTheDocument();
      // The one-time approval and the block action both remain reachable.
      expect(screen.getByRole('button', { name: '确认执行' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '禁止此网站' })).toBeInTheDocument();
    });

    it('withholds the permanent option for self-extension requests', () => {
      renderDialog({
        kind: 'self-extension',
        browserOrigin: 'https://example.com',
        allowPersistentGrant: true,
      });

      expect(screen.queryByRole('button', { name: /以后都允许/ })).not.toBeInTheDocument();
    });
  });

  // Blocking is the missing half of the site-verdict store: `getSiteVerdict`
  // has honoured 'denied' since v0.39.0 but nothing could write it, so the
  // only way to stop being asked was to approve.
  describe('block this site', () => {
    it('persists a denied verdict and refuses the pending action', async () => {
      const user = userEvent.setup();
      const { onConfirm, onCancel } = renderDialog({
        browserOrigin: 'https://evil.example.com',
        allowPersistentGrant: true,
      });

      await user.click(screen.getByRole('button', { name: '禁止此网站' }));

      expect(useSettingsStore.getState().browserSitePermissions).toEqual({
        'https://evil.example.com': 'denied',
      });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('is offered even when a permanent grant is forbidden (scripting tools)', () => {
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: false });

      expect(screen.queryByRole('button', { name: /以后都允许/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '禁止此网站' })).toBeInTheDocument();
    });

    it('overwrites an existing allow verdict for the same origin', async () => {
      const user = userEvent.setup();
      useSettingsStore.setState({
        browserSitePermissions: { 'https://example.com': 'allowed' },
      });
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });

      await user.click(screen.getByRole('button', { name: '禁止此网站' }));

      expect(useSettingsStore.getState().browserSitePermissions['https://example.com']).toBe('denied');
    });

    it('is not offered when the origin is unknown or the request is not a browser action', () => {
      renderDialog({ browserOrigin: undefined, allowPersistentGrant: true });
      expect(screen.queryByRole('button', { name: '禁止此网站' })).not.toBeInTheDocument();
      cleanup();

      renderDialog({ kind: 'command', browserOrigin: 'https://example.com' });
      expect(screen.queryByRole('button', { name: '禁止此网站' })).not.toBeInTheDocument();
    });
  });
});
