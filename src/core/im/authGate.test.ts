/**
 * AuthGate Tests
 */
import { describe, it, expect } from 'vitest';
import { resolveCapability } from './authGate';
import type { IMChannel } from '../../types/imChannel';

function makeChannel(overrides: Partial<IMChannel> = {}): IMChannel {
  return {
    id: 'ch1',
    platform: 'feishu',
    name: 'Test',
    appId: 'app1',
    appSecret: 'secret1',
    capability: 'safe_tools',
    allowedUsers: [],
    workspacePaths: [],
    sessionTimeoutMinutes: 30,
    maxRoundsPerSession: 50,
    enabled: true,
    status: 'connected',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('resolveCapability', () => {
  it('empty whitelist → allow everyone at configured level', () => {
    const channel = makeChannel({ capability: 'read_tools', allowedUsers: [] });
    const result = resolveCapability('any_user', channel);
    expect(result).toEqual({ allowed: true, capability: 'read_tools' });
  });

  it('user in whitelist → allowed', () => {
    const channel = makeChannel({ allowedUsers: ['u1', 'u2'] });
    const result = resolveCapability('u1', channel);
    expect(result.allowed).toBe(true);
  });

  it('user NOT in whitelist → denied', () => {
    const channel = makeChannel({ allowedUsers: ['u1', 'u2'] });
    const result = resolveCapability('u3', channel);
    expect(result).toEqual({ allowed: false, reason: 'User not in whitelist' });
  });

  it('full capability + user not in whitelist → downgrade to safe_tools', () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: [] });
    const result = resolveCapability('any_user', channel);
    expect(result).toEqual({ allowed: true, capability: 'safe_tools' });
  });

  it('full capability + user in whitelist → full', () => {
    const channel = makeChannel({ capability: 'full', allowedUsers: ['trusted_user'] });
    const result = resolveCapability('trusted_user', channel);
    expect(result).toEqual({ allowed: true, capability: 'full' });
  });

  it('chat_only → allowed with chat_only', () => {
    const channel = makeChannel({ capability: 'chat_only' });
    const result = resolveCapability('user1', channel);
    expect(result).toEqual({ allowed: true, capability: 'chat_only' });
  });
});
