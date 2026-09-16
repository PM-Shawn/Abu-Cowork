import { expect, it } from 'vitest';
import { runtimeAfterInstall } from './runtimeTransition';
import type { PluginRuntimeSnapshot } from './operationBridge';

const previous: PluginRuntimeSnapshot = { enabled: false,
  servers: { same: { name: 'same', command: 'node', args: ['app.js'], env: { B: '2', A: '1' }, enabled: true },
    changed: { name: 'changed', url: 'https://old.example', enabled: true }, removed: { name: 'removed', command: 'old' } },
  disabledSkills: { old: true }, disabledAgents: { helper: false },
};
it('preserves disabled master and existing child choices while denying new or changed execution', () => {
  const next = runtimeAfterInstall(previous, [
    { name: 'same', command: 'node', args: ['app.js'], env: { A: '1', B: '2' } },
    { name: 'changed', command: 'new' }, { name: 'added', command: 'extra' },
  ], ['old', 'new'], ['helper', 'extra'], true);
  expect(next.enabled).toBe(false);
  expect(next.servers.same?.enabled).toBe(true);
  expect(next.servers.changed).toEqual({ name: 'changed', command: 'new', enabled: false });
  expect(next.servers.added?.enabled).toBe(false);
  expect(next.servers.removed).toBeNull();
  expect(next.disabledSkills).toEqual({ old: true, new: true });
  expect(next.disabledAgents).toEqual({ helper: false, extra: true });
});
it('initial installation enables approved skill/agent intent but does not execute MCP implicitly', () => {
  const next = runtimeAfterInstall({ enabled: false, servers: {}, disabledSkills: {}, disabledAgents: {} },
    [{ name: 'mcp', command: 'node' }], ['skill'], ['agent'], false);
  expect(next.enabled).toBe(true);
  expect(next.disabledSkills.skill).toBe(false);
  expect(next.disabledAgents.agent).toBe(false);
  expect(next.servers.mcp?.enabled).toBe(false);
});

it('requires fresh consent after transport or headers change', () => {
  const state = { ...previous, servers: { remote: { name: 'remote', transport: 'http' as const, url: 'https://same.example', headers: { Authorization: 'old' }, enabled: true } } };
  for (const config of [{ ...state.servers.remote, transport: 'stdio' as const, command: 'node', url: undefined }, { ...state.servers.remote, headers: { Authorization: 'new' } }]) {
    expect(runtimeAfterInstall(state, [config], [], [], true).servers.remote?.enabled).toBe(false);
  }
});
