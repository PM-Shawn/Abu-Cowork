// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommandConfirmDialog, { type CommandConfirmRequest } from './CommandConfirmDialog';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { DEFAULT_BROWSER_OPERATION_POLICY } from '@/core/permissions/browserToolPolicy';
import { testSiteVerdicts } from '@/test/browserSiteVerdicts';

// Pins the browser-confirmation button set: which scopes are offered is a
// security decision made by the requester (allowPersistentGrant), and the
// "always allow this site" click must both persist the verdict and resolve
// the approval — a dialog that only did one of the two would either nag
// forever or grant without asking.
describe('CommandConfirmDialog', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useSettingsStore.setState({
      browserSitePermissions: testSiteVerdicts({}),
      browserSiteGrantViaEmbed: {},
      // Shipped default (scripting = 'ask'). Reset explicitly so a test that
      // flips the scripting row cannot rename this button for its neighbours.
      browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
    });
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

  describe('a page that embeds other sites', () => {
    // Per-origin authorization is only honest if the user SEES the other
    // origins before the click that authorizes them, and only bearable if the
    // click covers them all — region-by-region prompting is what turns one
    // form into a wall of dialogs.
    it('names the embedded sites in the ask itself', () => {
      renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net'],
        allowPersistentGrant: true,
      });

      expect(screen.getByText(/vendor\.example\.net/)).toBeInTheDocument();
    });

    it('says on the button that the click covers them too', () => {
      renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net', 'https://cdn.example.org'],
        allowPersistentGrant: true,
      });

      expect(screen.getByRole('button', { name: '此网站及 2 个内嵌区域以后都允许' })).toBeInTheDocument();
    });

    it('writes a separate grant per origin — never one that covers sites not listed', async () => {
      const user = userEvent.setup();
      const { onConfirm } = renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net', 'https://cdn.example.org'],
        allowPersistentGrant: true,
      });

      await user.click(screen.getByRole('button', { name: '此网站及 2 个内嵌区域以后都允许' }));

      const verdicts = useSettingsStore.getState().browserSitePermissions;
      expect(verdicts).toEqual({
        'https://oa.example.com': 'allowed',
        'https://vendor.example.net': 'allowed',
        'https://cdn.example.org': 'allowed',
      });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('grants nothing beyond this conversation when the user takes the narrow choice', async () => {
      const user = userEvent.setup();
      const { onConfirm } = renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net'],
        allowPersistentGrant: true,
      });

      await user.click(screen.getByRole('button', { name: '仅本次对话' }));

      expect(useSettingsStore.getState().browserSitePermissions).toEqual({});
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('is silent about regions on a page that has none', () => {
      renderDialog({ browserOrigin: 'https://oa.example.com', allowPersistentGrant: true });

      expect(screen.getByRole('button', { name: '此网站以后都允许' })).toBeInTheDocument();
      expect(screen.queryByText(/内嵌区域/)).not.toBeInTheDocument();
    });

    /**
     * Round-2 F2. The click that grants a page AND its regions is the very
     * click that also opens the scripting door, so the label has to carry both
     * facts. Written as a nested ternary the regions branch short-circuited
     * the scripting one, and the warning vanished on exactly the pages where
     * the grant reaches furthest.
     */
    it('still says "including scripts" when the page ALSO has embedded regions', () => {
      useSettingsStore.setState({
        browserOperationPolicy: { ...DEFAULT_BROWSER_OPERATION_POLICY, scripting: 'allow' },
      });
      renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net'],
        allowPersistentGrant: true,
      });

      expect(
        screen.getByRole('button', { name: '此网站及 1 个内嵌区域以后都允许（含运行脚本）' }),
      ).toBeInTheDocument();
    });

    /**
     * Round-2 F3. A portal page can embed dozens of third-party frames; a
     * prompt that printed all of them would be asking for consent to a wall of
     * text. The cap is on the GRANT as much as on the list — what is not
     * printed is not authorized, and the dialog says how many were left out.
     */
    it('lists at most five regions, and grants exactly the ones it listed', async () => {
      const user = userEvent.setup();
      const many = Array.from({ length: 8 }, (_, i) => `https://r${i}.example.net`);
      const { onConfirm } = renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: many,
        allowPersistentGrant: true,
      });

      expect(screen.getByText(/还有 3 个内嵌区域未列出/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '此网站及 5 个内嵌区域以后都允许' }));

      const verdicts = useSettingsStore.getState().browserSitePermissions;
      expect(Object.keys(verdicts).sort()).toEqual(
        ['https://oa.example.com', ...many.slice(0, 5)].sort(),
      );
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('says nothing about unlisted regions when every one of them fits', () => {
      renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net', 'https://cdn.example.org'],
        allowPersistentGrant: true,
      });

      expect(screen.queryByText(/未列出/)).not.toBeInTheDocument();
    });

    /**
     * Round-2 F3. `browserOrigin` for a frame-targeted action is the REGION,
     * and the user is looking at the page that embeds it — which the dialog
     * otherwise never named.
     */
    it('names the page an action inside a region is happening on', () => {
      renderDialog({
        browserOrigin: 'https://vendor.example.net',
        browserPageOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net'],
        allowPersistentGrant: true,
      });

      expect(screen.getByText(/当前页面：https:\/\/oa\.example\.com/)).toBeInTheDocument();
      // …and the region it is already acting in is not counted as a SECOND
      // site the click would newly cover (round-2 F11).
      expect(screen.getByRole('button', { name: '此网站以后都允许' })).toBeInTheDocument();
    });

    it('does not repeat the page origin when the action targets the page itself', () => {
      renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserPageOrigin: 'https://oa.example.com',
        allowPersistentGrant: true,
      });

      expect(screen.queryByText(/当前页面/)).not.toBeInTheDocument();
    });

    /**
     * Round-2 R2-C-②. What this click writes is a real grant — and it is a
     * grant given because ANOTHER site embeds these, so it is marked. The mark
     * is what keeps an automatic task from acting there later; see
     * `settingsStore`'s `browserSiteGrantViaEmbed`.
     */
    it('marks every region grant as one given through an embedding page', async () => {
      const user = userEvent.setup();
      const { onConfirm } = renderDialog({
        browserOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net', 'https://cdn.example.org'],
        allowPersistentGrant: true,
      });

      await user.click(
        screen.getByRole('button', { name: '此网站及 2 个内嵌区域以后都允许' }),
      );

      // The page the user was on is a DIRECT grant; the two regions are not.
      expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({
        'https://vendor.example.net': true,
        'https://cdn.example.org': true,
      });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('marks the action\'s OWN target too when that target is a region', async () => {
      const user = userEvent.setup();
      renderDialog({
        browserOrigin: 'https://vendor.example.net',
        browserPageOrigin: 'https://oa.example.com',
        browserEmbeddedOrigins: ['https://vendor.example.net'],
        allowPersistentGrant: true,
      });

      await user.click(screen.getByRole('button', { name: '此网站以后都允许' }));

      // The user never navigated to vendor.example.net — they were on the OA
      // page. Direct authorization is what the mark records the absence of.
      expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({
        'https://vendor.example.net': true,
      });
    });

    it('leaves an ordinary page grant unmarked', async () => {
      const user = userEvent.setup();
      renderDialog({
        browserOrigin: 'https://example.com',
        allowPersistentGrant: true,
      });

      await user.click(screen.getByRole('button', { name: '此网站以后都允许' }));

      expect(useSettingsStore.getState().browserSiteGrantViaEmbed).toEqual({});
    });
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

  // The same click writes the same verdict either way — but with the scripting
  // row on 'allow', that verdict is also the last precondition for scripts to
  // run on the site with no dialog, and for an automatic task to script there
  // at all. Ruling-I refused to let a SCRIPT dialog mint the verdict for that
  // reason; the click/fill dialog still does, so the label has to say so.
  describe('"always allow this site" names the scripting door when there is one', () => {
    it('says "including scripts" while the scripting row is set to allow', () => {
      useSettingsStore.setState({
        browserOperationPolicy: { ...DEFAULT_BROWSER_OPERATION_POLICY, scripting: 'allow' },
      });
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });

      expect(
        screen.getByRole('button', { name: '此网站以后都允许（含运行脚本）' }),
      ).toBeInTheDocument();
    });

    it('leaves the label alone on the shipped default, where there is no second door', () => {
      // scripting = 'ask' (the default set in beforeEach): the site verdict
      // buys nothing for scripts, so promising it would be the mirror error.
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });

      expect(screen.getByRole('button', { name: '此网站以后都允许' })).toBeInTheDocument();
      expect(screen.queryByText(/含运行脚本/)).not.toBeInTheDocument();
    });

    it('says nothing extra when the scripting row is denied', () => {
      useSettingsStore.setState({
        browserOperationPolicy: { ...DEFAULT_BROWSER_OPERATION_POLICY, scripting: 'deny' },
      });
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });

      expect(screen.getByRole('button', { name: '此网站以后都允许' })).toBeInTheDocument();
    });
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
        browserSitePermissions: testSiteVerdicts({ 'https://example.com': 'allowed' }),
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
