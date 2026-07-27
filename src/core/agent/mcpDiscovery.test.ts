import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/electronHost', () => ({
  hasElectronCommandHost: vi.fn(),
}));

import { hasElectronCommandHost } from '../../utils/electronHost';
import { getRegistryEntry } from './mcpDiscovery';

const mockedElectronHost = vi.mocked(hasElectronCommandHost);

describe('browser MCP host routing', () => {
  beforeEach(() => {
    mockedElectronHost.mockReset();
  });

  it('uses the bundled local browser runtime under Electron', () => {
    mockedElectronHost.mockReturnValue(true);
    expect(getRegistryEntry('abu-browser-bridge')).toMatchObject({
      command: 'abu-browser-runtime',
      args: [],
      env: {},
      bundledResourceDir: 'browser-extension',
    });
  });

  it('preserves the optional Chrome extension bridge under legacy Tauri', () => {
    mockedElectronHost.mockReturnValue(false);
    expect(getRegistryEntry('abu-browser-bridge')).toMatchObject({
      command: 'npx',
      args: ['-y', 'abu-browser-bridge@latest'],
      env: {},
      bundledResourceDir: 'browser-extension',
    });
  });
});
