// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CommandConfirmDialog, { type CommandConfirmRequest } from './CommandConfirmDialog';
import { initLanguage } from '@/i18n';
import { useSettingsStore, __resetBrowserConfigPersistenceForTests } from '@/stores/settingsStore';
import { createBrowserPermissionConfig, emptyBrowserSiteRule } from '@/core/permissions/browserPermissionConfig';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';

// Pins the browser-confirmation button set: which scopes are offered is a
// security decision made by the requester (allowPersistentGrant), and the
// "always allow this site" click must both persist the verdict and resolve
// the approval — a dialog that only did one of the two would either nag
// forever or grant without asking.
const originalLocksDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
function restoreNavigatorLocks() {
  if (originalLocksDescriptor) Object.defineProperty(navigator, 'locks', originalLocksDescriptor);
  else Reflect.deleteProperty(navigator, 'locks');
}

describe('CommandConfirmDialog', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    let writes = Promise.resolve<unknown>(undefined);
    const browserNavigator = navigator;
    Object.defineProperty(browserNavigator, 'locks', { configurable: true, value: { request: (_name: string, callback: () => unknown) => {
      const job = writes.then(callback); writes = job.catch(() => undefined); return job;
    } } });
    vi.stubGlobal('navigator', browserNavigator);
    __resetBrowserConfigPersistenceForTests();
    localStorage.clear();
    setMigratedBrowserSettings({ browserPermissionConfigV2: createBrowserPermissionConfig() });
  });

  afterEach(() => {
    cleanup(); vi.unstubAllGlobals(); restoreNavigatorLocks();
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
          browserPermissionResource: overrides.kind === 'browser-upload' ? 'upload' : 'browse',
          browserPermissionTargets: overrides.browserOrigin ? [{ origin: overrides.browserOrigin, embeddedIn: overrides.browserPageOrigin }] : [],
          ...overrides,
        }}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    return { onConfirm, onCancel };
  }

  it('offers a one-shot action and a resource-specific saved grant', () => {
    renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });
    expect(screen.getByRole('button', { name: '仅允许这次' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '以后允许在此网站浏览' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeEnabled();
  });
  it.each(['browse', 'upload'] as const)('persists only the requested %s resource', async (resource) => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true, browserPermissionResource: resource });
    await user.click(screen.getByRole('button', { name: resource === 'browse' ? '以后允许在此网站浏览' : '以后允许向此网站上传' }));
    await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2).not.toEqual(createBrowserPermissionConfig()));
    const config = useSettingsStore.getState().browserPermissionConfigV2;
    expect(config.sites).toEqual({ 'https://example.com': { ...emptyBrowserSiteRule(), [resource]: 'allow' } });
    expect(config.embeddedSites).toEqual({});
    expect(onConfirm).toHaveBeenCalledOnce();
  });
  it('the narrow choice grants only this request and writes no site rule', async () => {
    const { onConfirm } = renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });
    await userEvent.setup().click(screen.getByRole('button', { name: '仅允许这次' }));
    expect(useSettingsStore.getState().browserPermissionConfigV2.sites).toEqual({});
    expect(onConfirm).toHaveBeenCalledOnce();
  });
  it('shows and preserves embedded scope without granting the frame as a top-level site', async () => {
    const origin = 'https://frame.example'; const host = 'https://host.example';
    renderDialog({ browserOrigin: origin, browserPageOrigin: host, allowPersistentGrant: true });
    expect(screen.getByText(/仅在 https:\/\/host.example 中/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2).not.toEqual(createBrowserPermissionConfig()));
    const config = useSettingsStore.getState().browserPermissionConfigV2;
    expect(config.sites[origin]).toBeUndefined();
    expect(config.embeddedSites[host][origin]).toEqual({ upload: 'inherit', script: 'inherit', browse: 'allow' });
  });
  it('a multi-target grant writes every named scope and no other resource or site', async () => {
    const host = 'https://host.example'; const frame = 'https://frame.example';
    renderDialog({ browserOrigin: host, allowPersistentGrant: true, browserPermissionTargets: [{ origin: host }, { origin: frame, embeddedIn: host }] });
    expect(screen.getByText(new RegExp(frame))).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2).not.toEqual(createBrowserPermissionConfig()));
    const config = useSettingsStore.getState().browserPermissionConfigV2;
    expect(config.sites).toEqual({ [host]: { ...emptyBrowserSiteRule(), browse: 'allow' } });
    expect(config.embeddedSites).toEqual({ [host]: { [frame]: { upload: 'inherit', script: 'inherit', browse: 'allow' } } });
  });
  it.each([
    { allowPersistentGrant: false }, { browserOrigin: undefined },
    { browserPermissionTargets: [] },
    { browserEmbeddedOrigins: Array.from({ length: 6 }, (_, i) => `https://f${i}.example`) },
  ])('cannot offer a permanent grant beyond the request authority: %j', (overrides) => {
    renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true, ...overrides });
    expect(screen.queryByRole('button', { name: /以后允许/ })).toBeNull();
  });
  it('offers to always allow scripts on the site, and writes only the script permission', async () => {
    const { onConfirm } = renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true,
      browserPermissionResource: 'script', browserPermissionTargets: [{ origin: 'https://example.com' }] });
    await userEvent.setup().click(screen.getByRole('button', { name: '以后在此网站允许执行脚本' }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(useSettingsStore.getState().browserPermissionConfigV2.sites['https://example.com'])
      .toEqual({ ...emptyBrowserSiteRule(), script: 'allow' });
  });
  it('a save failure does not approve or hide the pending action', async () => {
    const write = vi.spyOn(useSettingsStore.getState(), 'grantBrowserPermissionTargets').mockResolvedValue(false);
    const { onConfirm } = renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });
    await userEvent.setup().click(screen.getByRole('button', { name: '以后允许在此网站浏览' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '仅允许这次' })).toBeEnabled();
    write.mockRestore();
  });

  it('plain command confirmations are unchanged — two buttons, command wording', () => {
    renderDialog({ kind: 'command', browserOrigin: undefined, allowPersistentGrant: undefined });

    expect(screen.queryByRole('button', { name: /以后允许/ })).not.toBeInTheDocument();
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

      expect(screen.queryByRole('button', { name: /以后允许/ })).not.toBeInTheDocument();
      // The one-time approval and the block action both remain reachable.
      expect(screen.getByRole('button', { name: '仅允许这次' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '禁止此网站' })).toBeInTheDocument();
    });

    it('withholds the permanent option for self-extension requests', () => {
      renderDialog({
        kind: 'self-extension',
        browserOrigin: 'https://example.com',
        allowPersistentGrant: true,
      });

      expect(screen.queryByRole('button', { name: /以后允许/ })).not.toBeInTheDocument();
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

      await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2.sites['https://evil.example.com']?.blocked).toBe(true));
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('is offered even when a permanent grant is forbidden (e.g. a high-risk site)', () => {
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: false });

      expect(screen.queryByRole('button', { name: /以后允许/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '禁止此网站' })).toBeInTheDocument();
    });

    it('overwrites an existing allow verdict for the same origin', async () => {
      const user = userEvent.setup();
      setMigratedBrowserSettings({ browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { 'https://example.com': { ...emptyBrowserSiteRule(), browse: 'allow' } } } });
      renderDialog({ browserOrigin: 'https://example.com', allowPersistentGrant: true });

      await user.click(screen.getByRole('button', { name: '禁止此网站' }));

      await waitFor(() => expect(useSettingsStore.getState().browserPermissionConfigV2.sites['https://example.com']?.blocked).toBe(true));
    });

    it('is not offered when the origin is unknown or the request is not a browser action', () => {
      renderDialog({ browserOrigin: undefined, allowPersistentGrant: true });
      expect(screen.queryByRole('button', { name: '禁止此网站' })).not.toBeInTheDocument();
      cleanup();

      renderDialog({ kind: 'command', browserOrigin: 'https://example.com' });
      expect(screen.queryByRole('button', { name: '禁止此网站' })).not.toBeInTheDocument();
    });
  });

  /**
   * Acceptance F5 — the upload question.
   *
   * It used to be asked with the generic browser box: the heading said
   * 「浏览器操作确认」, the line under it named `abu-browser__upload_file`, and
   * the button said 「确认执行」. A person reading that is told the name of an
   * identifier only this codebase uses, and is not told the one thing that
   * matters — that files are about to leave their machine, and for where.
   *
   * The site-scoped affordances are asserted alongside the wording on
   * purpose: an upload is a browser action, and the way this could go wrong
   * is by giving it its own heading and silently dropping its 「禁止此网站」
   * row along with the kind check that offered it.
   */
  describe('an upload asks its own question', () => {
    function renderUpload(overrides: Partial<CommandConfirmRequest> = {}) {
      return renderDialog({
        kind: 'browser-upload',
        command: '报价.csv (18 B), 明细.xlsx (1.2 MB) — 1.2 MB',
        browserUploadFileCount: 2,
        browserOrigin: 'https://oa.example.com',
        allowPersistentGrant: false,
        ...overrides,
      });
    }

    it('says how many files are going where, and confirms with 「确认上传」', () => {
      renderUpload();

      expect(screen.getByText('上传 2 个文件到 oa.example.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '确认上传' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument();
    });

    it('never shows the internal tool name', () => {
      renderUpload();

      expect(document.body.textContent).not.toContain('abu-browser__');
      expect(screen.queryByText('浏览器操作确认')).toBeNull();
    });

    it('lists the files, their sizes and the total', () => {
      renderUpload();

      expect(screen.getByText('报价.csv (18 B), 明细.xlsx (1.2 MB) — 1.2 MB')).toBeInTheDocument();
    });

    it('counts one file in the singular', () => {
      renderUpload({ browserUploadFileCount: 1, command: '报价.csv (18 B)' });

      expect(screen.getByText('上传 1 个文件到 oa.example.com')).toBeInTheDocument();
    });

    /**
     * The files are going to a region the page merely hosts, not to the site
     * the user is looking at — the one distinction that changes whether this
     * upload is what they meant.
     */
    it('says so when the target is a region embedded in the page', () => {
      renderUpload({
        browserOrigin: 'https://vendor.example.net',
        browserPageOrigin: 'https://oa.example.com',
      });

      expect(
        screen.getByText('上传 2 个文件到 vendor.example.net（页面内嵌区域）'),
      ).toBeInTheDocument();
    });

    it('names the site generically when the origin could not be resolved', () => {
      renderUpload({ browserOrigin: undefined });

      expect(screen.getByText('上传 2 个文件到 这个网站')).toBeInTheDocument();
    });

    it('keeps the site grant and the block row an upload is entitled to', () => {
      renderUpload({ allowPersistentGrant: true });

      // The once/always split survives, in the upload's own verb.
      expect(screen.getByRole('button', { name: '仅本次上传' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '以后允许向此网站上传' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '禁止此网站' })).toBeInTheDocument();
    });

    it('reads the same way in the other locale', () => {
      initLanguage('en-US');
      renderUpload();

      expect(screen.getByText('Upload 2 files to oa.example.com')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Confirm upload' })).toBeInTheDocument();
      initLanguage('zh-CN');
    });

    it('reads the same way in the other locale for one file', () => {
      initLanguage('en-US');
      renderUpload({ browserUploadFileCount: 1, command: 'quote.csv (18 B)' });

      expect(screen.getByText('Upload 1 file to oa.example.com')).toBeInTheDocument();
      initLanguage('zh-CN');
    });
  });
});

import { act as auditAct, fireEvent as auditFire } from '@testing-library/react';
import {createBrowserPermissionConfig as auditConfig} from '@/core/permissions/browserPermissionConfig';
describe('audit-review dialog replacement', () => {
 afterEach(() => {cleanup();vi.restoreAllMocks();});
 it('audit-ui: releases saving state for the next request without confirming the old one', async () => {
  initLanguage('zh-CN');
  useSettingsStore.setState({browserPermissionConfigV2:auditConfig()});
  let release!: (value: boolean) => void; let guard!: () => boolean;
  const write=vi.spyOn(useSettingsStore.getState(),'grantBrowserPermissionTargets').mockImplementation((_resource,_targets,current)=>{guard=current!;return new Promise(resolve=>{release=resolve;});});
  const first={command:'first',reason:'first',level:'warn',kind:'browser',browserOrigin:'https://first.example',browserPermissionResource:'browse',browserPermissionTargets:[{origin:'https://first.example'}],allowPersistentGrant:true} as CommandConfirmRequest;
  const next={...first,command:'second',reason:'second',browserOrigin:'https://second.example',browserPermissionResource:'upload',browserPermissionTargets:[{origin:'https://second.example'}]} as CommandConfirmRequest;
  const confirm=vi.fn(),cancel=vi.fn();
  const view=render(<CommandConfirmDialog request={first} onConfirm={confirm} onCancel={cancel}/>);
  auditFire.click(screen.getByRole('button',{name:'以后允许在此网站浏览'}));
  view.rerender(<CommandConfirmDialog request={next} onConfirm={confirm} onCancel={cancel}/>);
  expect(guard()).toBe(false);
  await auditAct(async()=>{release(false);});
  expect(write.mock.calls[0].slice(0,2)).toEqual(['browse',[{origin:'https://first.example'}]]);
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'仅允许这次'})).toBeEnabled();
 });
});

describe('audit-review dialog cancellation',()=>{
 afterEach(()=>{cleanup();vi.restoreAllMocks();});
 it('audit-cancel: ordinary cancellation invalidates the pending grant callback',async()=>{
  initLanguage('zh-CN');useSettingsStore.setState({browserPermissionConfigV2:auditConfig()});
  let release!: (value: boolean) => void; let guard!: () => boolean;
  vi.spyOn(useSettingsStore.getState(),'grantBrowserPermissionTargets').mockImplementation((_resource,_targets,current)=>{guard=current!;return new Promise(resolve=>{release=resolve;});});
  const request={command:'upload',reason:'upload',level:'warn',kind:'browser-upload',browserOrigin:'https://frame.example',browserPageOrigin:'https://host.example',browserPermissionResource:'upload',browserPermissionTargets:[{origin:'https://frame.example',embeddedIn:'https://host.example'}],allowPersistentGrant:true} as CommandConfirmRequest;
  const confirm=vi.fn(),cancel=vi.fn();
  render(<CommandConfirmDialog request={request} onConfirm={confirm} onCancel={cancel}/>);
  auditFire.click(screen.getByRole('button',{name:'以后允许向此网站上传'}));
  auditFire.click(screen.getByRole('button',{name:'取消'}));
  expect(guard()).toBe(false);
  await auditAct(async()=>release(false));
  expect(cancel).toHaveBeenCalledTimes(1);expect(confirm).not.toHaveBeenCalled();
 });
});
