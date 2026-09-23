import { describe, expect, it } from 'vitest';
import { evaluateBrowserPermissionGate, type BrowserPermissionGateFacts } from './browserPermissionGate';
import { buildIMRunPermissionCeiling } from './runPermissionCeiling';
const base: BrowserPermissionGateFacts = {
  opClass: 'interactive', runMode: 'attended', configured: { decision: 'allow', source: 'default' },
  permissionMode: 'standard', runPermissionCeiling: null, toolTargetsPage: true,
  originResolved: true, answersPageDialog: false, loginRequired: false,
  confirmationChannelAvailable: true, originKnown: true, highRisk: false,
};
describe('new permission execution gate', () => {
  it.each(['attended', 'unattended'] as const)('applies allow without a site grant in %s', (runMode) => {
    expect(evaluateBrowserPermissionGate({ ...base, runMode }).ask).toBeNull();
    expect(evaluateBrowserPermissionGate({ ...base, runMode }).outcome).toBe('allow');
  });
  it.each(['interactive', 'read-only', 'upload', 'scripting'] as const)('offers an exact-resource persistent grant for ordinary %s ask', (opClass) => {
    expect(evaluateBrowserPermissionGate({ ...base, opClass, configured: { decision: 'ask', source: 'default' } }).ask?.offersPersistentGrant).toBe(true);
  });
  it('offers no persistent grant for scripts on a high-risk site', () => {
    expect(evaluateBrowserPermissionGate({ ...base, opClass: 'scripting', highRisk: true, configured: { decision: 'ask', source: 'default' } })
      .ask?.offersPersistentGrant).not.toBe(true);
  });
  it('sends unattended ask to the approval channel without then requiring a site grant', () => {
    const result = evaluateBrowserPermissionGate({ ...base, runMode: 'unattended', configured: { decision: 'ask', source: 'default' } });
    expect(result.outcome).toBe('allow');
    expect(result.ask?.channel).toBe('im');
  });
  it.each([{ highRisk: true }, { originKnown: false }])('never offers persistent grants for %j', (facts) => {
    expect(evaluateBrowserPermissionGate({ ...base, ...facts, configured: { decision: 'ask', source: 'default' } }).ask?.offersPersistentGrant).not.toBe(true);
  });
  it('retains site block, missing approval channel, high-risk and origin boundaries', () => {
    expect(evaluateBrowserPermissionGate({ ...base, configured: { decision: 'deny', source: 'site-block' } }).denialReason).toBe('site-denied');
    expect(evaluateBrowserPermissionGate({ ...base, confirmationChannelAvailable: false, configured: { decision: 'ask', source: 'site' } }).outcome).toBe('deny');
    expect(evaluateBrowserPermissionGate({ ...base, highRisk: true }).ask).not.toBeNull();
    expect(evaluateBrowserPermissionGate({ ...base, highRisk: true, runMode: 'unattended' }).outcome).toBe('deny');
    expect(evaluateBrowserPermissionGate({ ...base, originResolved: false }).outcome).toBe('deny');
  });
  it.each(['interactive', 'upload', 'scripting'] as const)('cannot elevate a read-only run through an allowed %s setting', (opClass) => {
    expect(evaluateBrowserPermissionGate({ ...base, opClass, runPermissionCeiling: buildIMRunPermissionCeiling('read_tools') }).denialReason).toBe('capability-denied');
  });
  it.each(['read-only', 'interactive', 'upload', 'scripting'] as const)('blocks high-risk unattended %s even with explicit allow', (opClass) => {
    expect(evaluateBrowserPermissionGate({ ...base, opClass, runMode: 'unattended', highRisk: true }).denialReason).toBe('high-risk-site');
  });
  it('allows reading a login wall but refuses unattended state changes there', () => {
    expect(evaluateBrowserPermissionGate({ ...base, opClass: 'read-only', runMode: 'unattended', loginRequired: true }).outcome).toBe('allow');
    expect(evaluateBrowserPermissionGate({ ...base, runMode: 'unattended', loginRequired: true }).denialReason).toBe('login-required');
  });
  it('never converts answering a page dialog into a persistent grant', () => {
    expect(evaluateBrowserPermissionGate({ ...base, answersPageDialog: true, configured: { decision: 'ask', source: 'default' } }).ask?.offersPersistentGrant).toBe(false);
  });
  it.each(['standard', 'smart', 'autonomous'] as const)('respects explicit ask and deny even in %s mode', (permissionMode) => {
    expect(evaluateBrowserPermissionGate({ ...base, permissionMode, configured: { decision: 'ask', source: 'site' } }).ask?.channel).toBe('dialog');
    expect(evaluateBrowserPermissionGate({ ...base, permissionMode, configured: { decision: 'deny', source: 'site' } }).outcome).toBe('deny');
  });
});
