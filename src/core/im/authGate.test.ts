/**
 * AuthGate Tests
 */
import { describe, it, expect } from 'vitest';
import { resolveCapability, getBlockedToolsForLevel } from './authGate';
import { matchesToolName } from '../skill/toolFilter';
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

// The read-only tier carries no browser capability at all — the same one
// sentence triggerPermission.ts enforces. channelRouter used to hard-code
// `blockedTools: [request_workspace]` for every tier, so an IM read_tools run
// still had the whole browser surface; and because a standing "always allow
// this site" grant makes registry.ts resolve the browser gate to 'allow'
// WITHOUT consulting the confirmation callback, the read-only callbacks could
// not claw that back. The ceiling has to hold at tool-list level.
describe('getBlockedToolsForLevel', () => {
  const BROWSER_TOOLS = [
    'click', 'fill', 'select', 'keyboard', 'execute_js', 'navigate',
    // Read-only tools the policy module never enumerates (registered
    // dynamically by the browser servers) — the namespace wildcard must catch
    // these too.
    'snapshot', 'screenshot', 'get_tabs',
  ];

  function blocks(level: Parameters<typeof getBlockedToolsForLevel>[0], tool: string): boolean {
    return getBlockedToolsForLevel(level).some((pattern) => matchesToolName(tool, pattern));
  }

  it('always blocks request_workspace — an IM run cannot answer a UI dialog', () => {
    for (const level of ['chat_only', 'read_tools', 'safe_tools', 'full'] as const) {
      expect(getBlockedToolsForLevel(level), level).toContain('request_workspace');
    }
  });

  it('read_tools gets no browser tools at all, on either browser server', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(blocks('read_tools', `abu-browser__${tool}`), tool).toBe(true);
      expect(blocks('read_tools', `abu-browser-bridge__${tool}`), tool).toBe(true);
    }
  });

  it('chat_only is at least as strict as read_tools', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(blocks('chat_only', `abu-browser__${tool}`), tool).toBe(true);
    }
  });

  it('leaves safe_tools and full untouched — request_workspace only', () => {
    for (const level of ['safe_tools', 'full'] as const) {
      expect(getBlockedToolsForLevel(level), level).toEqual(['request_workspace']);
      expect(blocks(level, 'abu-browser__click'), level).toBe(false);
      expect(blocks(level, 'abu-browser__snapshot'), level).toBe(false);
    }
  });

  it('does not block non-browser tools whose names merely start similarly', () => {
    expect(blocks('read_tools', 'abu-browserish__click')).toBe(false);
    expect(blocks('read_tools', 'read_file')).toBe(false);
  });
});
