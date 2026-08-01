import { afterEach, describe, expect, it } from 'vitest';
import { getMCPTemplatesForHost } from './mcp';

function setElectronHost(enabled: boolean): void {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  runtime.__ABU_SHELL__ = enabled
    ? { mainSupervisesSidecar: true }
    : undefined;
}

describe('MCP marketplace host filtering', () => {
  afterEach(() => {
    setElectronHost(false);
  });

  it('hides the first-party Chrome bridge template in Electron', () => {
    setElectronHost(true);

    expect(getMCPTemplatesForHost().some(
      (template) => template.id === 'abu-browser-bridge',
    )).toBe(false);
  });

  it('preserves the legacy Chrome bridge template for Tauri', () => {
    setElectronHost(false);

    expect(getMCPTemplatesForHost()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'abu-browser-bridge',
        command: 'npx',
        defaultArgs: ['-y', 'abu-browser-bridge@latest'],
      }),
    ]));
  });
});
