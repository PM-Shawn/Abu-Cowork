import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMicrophoneStatus, openMicrophoneSettings } from './microphoneBridge';

function stubShell(microphone?: (action: string) => Promise<unknown>) {
  vi.stubGlobal('__ABU_SHELL__', microphone ? { microphone } : {});
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('microphoneBridge', () => {
  it('reports unknown and opens nothing outside the Electron host', async () => {
    stubShell();
    expect(await getMicrophoneStatus()).toBe('unknown');
    expect(await openMicrophoneSettings()).toBe(false);
  });

  it('passes through known OS statuses', async () => {
    const host = vi.fn(async () => 'denied');
    stubShell(host);
    expect(await getMicrophoneStatus()).toBe('denied');
    expect(host).toHaveBeenCalledWith('status');
  });

  it('maps an unexpected status to unknown', async () => {
    stubShell(async () => 'maybe');
    expect(await getMicrophoneStatus()).toBe('unknown');
  });

  it('opens the OS privacy page through the host', async () => {
    const host = vi.fn(async () => true);
    stubShell(host);
    expect(await openMicrophoneSettings()).toBe(true);
    expect(host).toHaveBeenCalledWith('open-settings');
  });
});
