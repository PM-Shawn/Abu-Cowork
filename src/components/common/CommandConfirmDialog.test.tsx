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

    expect(screen.getByRole('button', { name: '仅这次' })).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: '仅这次' }));

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
});
