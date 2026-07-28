import { describe, expect, it } from 'vitest';
import { getRegistryEntry } from './mcpDiscovery';

describe('Chrome bridge MCP registry', () => {
  it('always represents the optional external Chrome extension bridge', () => {
    expect(getRegistryEntry('abu-browser-bridge')).toMatchObject({
      command: 'npx',
      args: ['-y', 'abu-browser-bridge@latest'],
      env: {},
      bundledResourceDir: 'browser-extension',
    });
  });
});
