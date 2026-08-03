import { beforeEach, describe, expect, it } from 'vitest';
import { useMCPStore } from './mcpStore';

describe('mcpStore.renameServer', () => {
  beforeEach(() => {
    useMCPStore.setState({ servers: {}, isLoading: false });
  });

  it('moves the record key and updates the config identity', () => {
    useMCPStore.getState().addServer({
      name: 'old-name',
      command: 'npx',
      args: ['demo'],
      enabled: true,
    });

    expect(useMCPStore.getState().renameServer('old-name', 'new-name')).toBe(true);
    expect(useMCPStore.getState().servers['old-name']).toBeUndefined();
    expect(useMCPStore.getState().servers['new-name']).toMatchObject({
      config: { name: 'new-name', command: 'npx', args: ['demo'], enabled: true },
      status: 'disconnected',
      tools: [],
    });
  });

  it('refuses to overwrite an existing server', () => {
    useMCPStore.getState().addServer({ name: 'old-name', command: 'old' });
    useMCPStore.getState().addServer({ name: 'taken-name', command: 'taken' });

    expect(useMCPStore.getState().renameServer('old-name', 'taken-name')).toBe(false);
    expect(useMCPStore.getState().servers['old-name'].config.command).toBe('old');
    expect(useMCPStore.getState().servers['taken-name'].config.command).toBe('taken');
  });

  it('refuses a missing source and accepts an unchanged identity', () => {
    expect(useMCPStore.getState().renameServer('missing', 'new-name')).toBe(false);
    useMCPStore.getState().addServer({ name: 'same-name', command: 'demo' });
    expect(useMCPStore.getState().renameServer('same-name', 'same-name')).toBe(true);
  });
});
