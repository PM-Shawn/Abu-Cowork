import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@enterprise-modules/components/KbBrowser', () => ({}));
vi.mock('@enterprise-modules/components/PersonalKbView', () => ({}));
vi.mock('@enterprise-modules/components/EnterpriseSkillTab', () => ({}));
vi.mock('@enterprise-modules/components/EnterpriseMcpTab', () => ({}));
vi.mock('@enterprise-modules/components/EnterprisePluginTab', () => ({}));
vi.mock('@enterprise-modules/components/EnterpriseAgentTab', () => ({}));
vi.mock('@enterprise-modules/components/MeTransparencyView', () => ({}));
vi.mock('@enterprise-modules/components/MigrationWizard', () => ({}));

import { appPolicyOf, startDefaultAppLanding, stopDefaultAppLanding } from '@enterprise-modules/core/enterprise/app-policy';
import { useEnterpriseStore } from '@enterprise-modules/stores/enterpriseStore';
import { useAppStore } from '@/stores/appStore';
import type { EnterpriseBinding, EnterpriseConfigSnapshot } from '@/core/enterprise/types';

/**
 * The app policy an organization sets for its employees (product spec §5):
 * which app their Abu opens in, and whether they may leave it.
 */
const binding: EnterpriseBinding = {
  serverUrl: 'https://enterprise.example', orgId: 'org-1', orgName: 'Org',
  userId: 'user-1', userName: 'User', userEmail: 'user@example.com',
  deptId: null, roleId: null, accessToken: 'token', boundAt: '2026-08-05T00:00:00Z',
  llmEndpoint: null, llmVirtualKey: null, llmKeyExpiresAt: null,
};

function config(patch: Partial<EnterpriseConfigSnapshot> = {}): EnterpriseConfigSnapshot {
  return {
    brand: { name: 'Org', logoUrl: null, primaryColor: null }, defaultSoul: null,
    policyDefaults: {}, modules: ['skills'], licenseStatus: 'valid',
    licenseExpiresAt: '2027-01-01T00:00:00Z', serverTime: '2026-08-05T00:00:00Z',
    fetchedAt: Date.now(), ...patch,
  };
}

beforeEach(() => {
  stopDefaultAppLanding();
  useEnterpriseStore.setState({ mode: { kind: 'personal' } });
});

describe('enterprise app policy', () => {
  it('answers personal mode with no default app and a free switcher', () => {
    expect(appPolicyOf({ kind: 'personal' })).toEqual({ defaultAppId: null, allowExit: true });
  });

  it('reads both fields from the session snapshot', () => {
    const mode = { kind: 'enterprise' as const, binding, config: config({
      defaultAppId: 'acme-contract-review@enterprise', allowExitDefaultApp: false,
    }) };
    expect(appPolicyOf(mode)).toEqual({ defaultAppId: 'acme-contract-review@enterprise', allowExit: false });
  });

  it('keeps the switcher free when the organization names no app', () => {
    // Nothing to leave: the employee is in the general shell already, so a
    // stale allowExitDefaultApp: false must not strand them there.
    const mode = { kind: 'enterprise' as const, binding, config: config({
      defaultAppId: null, allowExitDefaultApp: false,
    }) };
    expect(appPolicyOf(mode)).toEqual({ defaultAppId: null, allowExit: true });
  });

  it('keeps answering from the last snapshot while offline', () => {
    const mode = {
      kind: 'offline' as const, binding, reason: 'token rejected',
      lastConfig: config({ defaultAppId: 'acme@enterprise', allowExitDefaultApp: false }),
    };
    expect(appPolicyOf(mode)).toEqual({ defaultAppId: 'acme@enterprise', allowExit: false });
  });

  it('falls back to a free switcher before the first snapshot arrives', () => {
    expect(appPolicyOf({ kind: 'enterprise', binding, config: null }))
      .toEqual({ defaultAppId: null, allowExit: true });
  });
});

describe('landing in the organization app', () => {
  it('puts the employee in it once, and again only when the administrator names another', () => {
    const enter = vi.spyOn(useAppStore.getState(), 'enterAppWhenAvailable').mockImplementation(() => {});
    startDefaultAppLanding();

    useEnterpriseStore.setState({ mode: { kind: 'enterprise', binding, config: config({ defaultAppId: 'acme@enterprise' }) } });
    expect(enter).toHaveBeenCalledWith('acme@enterprise');

    // A later heartbeat naming the same app must not drag an employee who
    // switched away back into it five minutes on.
    useEnterpriseStore.setState({ mode: { kind: 'enterprise', binding, config: config({ defaultAppId: 'acme@enterprise' }) } });
    expect(enter).toHaveBeenCalledTimes(1);

    useEnterpriseStore.setState({ mode: { kind: 'enterprise', binding, config: config({ defaultAppId: 'other@enterprise' }) } });
    expect(enter).toHaveBeenLastCalledWith('other@enterprise');
    enter.mockRestore();
  });

  it('lands again after signing out and back into the same organization', () => {
    const enter = vi.spyOn(useAppStore.getState(), 'enterAppWhenAvailable').mockImplementation(() => {});
    startDefaultAppLanding();

    useEnterpriseStore.setState({ mode: { kind: 'enterprise', binding, config: config({ defaultAppId: 'acme@enterprise' }) } });
    useEnterpriseStore.setState({ mode: { kind: 'personal' } });
    useEnterpriseStore.setState({ mode: { kind: 'enterprise', binding, config: config({ defaultAppId: 'acme@enterprise' }) } });

    expect(enter).toHaveBeenCalledTimes(2);
    enter.mockRestore();
  });

  it('does nothing for an organization that names no app', () => {
    const enter = vi.spyOn(useAppStore.getState(), 'enterAppWhenAvailable').mockImplementation(() => {});
    startDefaultAppLanding();
    useEnterpriseStore.setState({ mode: { kind: 'enterprise', binding, config: config() } });
    expect(enter).not.toHaveBeenCalled();
    enter.mockRestore();
  });
});
