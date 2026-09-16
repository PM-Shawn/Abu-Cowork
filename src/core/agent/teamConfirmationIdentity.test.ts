import { beforeEach, describe, expect, it } from 'vitest';
import { buildTeamConfirmationIdentity, clearTeamConfirmationIdentities } from './teamConfirmationIdentity';

const ctx = { conversationId: 'c', loopId: 'l', toolCallId: 't', workspacePath: '/a' };
describe('team confirmation parameter identity', () => {
  beforeEach(() => clearTeamConfirmationIdentities('c'));
  it('normalizes key ordering and resolved cwd, while preserving meaningful command differences', async () => {
    const a = await buildTeamConfirmationIdentity('run_command', { command: 'npm publish', cwd: '' }, ctx);
    const b = await buildTeamConfirmationIdentity('run_command', { cwd: '/a', command: 'npm publish' }, ctx);
    expect(a).toEqual(b);
    const c = await buildTeamConfirmationIdentity('run_command', { command: 'npm publish' }, { ...ctx, workspacePath: '/b' });
    expect(c?.parametersDigest).not.toBe(a?.parametersDigest);
    expect(c?.cwd).toBe('/b');
  });
  it('hashes script bodies and effective browser targets without storing the body', async () => {
    const a = await buildTeamConfirmationIdentity('browser__execute_js', { script: 'secret-a' }, ctx, { origin: 'https://a.test' });
    const b = await buildTeamConfirmationIdentity('browser__execute_js', { script: 'secret-b' }, ctx, { origin: 'https://a.test' });
    const c = await buildTeamConfirmationIdentity('browser__execute_js', { script: 'secret-a' }, ctx, { origin: 'https://b.test' });
    expect(a?.parametersDigest).not.toBe(b?.parametersDigest);
    expect(a?.parametersDigest).not.toBe(c?.parametersDigest);
    expect(JSON.stringify(a)).not.toContain('secret-a');
    expect(await buildTeamConfirmationIdentity('run_command', {}, {})).toBeUndefined();
  });
  it('counts identical calls once, isolates dispatch/member/run, and clears ended runs', async () => {
    const build = (overrides = {}) => buildTeamConfirmationIdentity('run_command', { command: 'npm publish' }, { ...ctx, ...overrides });
    expect((await build())?.requestOrdinal).toBe(1);
    expect((await build({ toolCallId: 't2' }))?.requestOrdinal).toBe(2);
    expect((await build({ toolCallId: 't2' }))?.requestOrdinal).toBe(2);
    expect((await build({ agentName: 'other' }))?.requestOrdinal).toBe(1);
    expect((await build({ teamApprovalDispatch: { id: 'd2', fingerprint: 'task' } }))?.requestOrdinal).toBe(1);
    expect((await build({ loopId: 'l2' }))?.requestOrdinal).toBe(1);
    clearTeamConfirmationIdentities('c', 'l');
    expect((await build({ toolCallId: 't3' }))?.requestOrdinal).toBe(1);
    expect((await build({ loopId: 'l2', toolCallId: 't2' }))?.requestOrdinal).toBe(2);
    clearTeamConfirmationIdentities('c');
    expect((await build({ loopId: 'l2', toolCallId: 't3' }))?.requestOrdinal).toBe(1);
  });
});
