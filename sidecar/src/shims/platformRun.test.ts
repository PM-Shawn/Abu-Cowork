import { describe, expect, it } from 'vitest';
import { platform } from 'node:os';
import { getPlatform, getShell, initPlatform, isLinux, isMacOS, isWindows } from './platformRun';

// The real utils/platform.ts resolves the platform asynchronously and RETURNS
// it; this shim resolves synchronously and used to return void, so a caller
// writing `const p = await initPlatform()` compiled and got undefined.
describe('sidecar platform shim', () => {
  it('initPlatform resolves to the same platform the sync readers report', async () => {
    await expect(initPlatform()).resolves.toBe(getPlatform());
  });

  it('maps the host platform the same three ways the real module does', () => {
    const expected = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'macos' : 'linux';
    expect(getPlatform()).toBe(expected);
    expect(isWindows()).toBe(expected === 'windows');
    expect(isMacOS()).toBe(expected === 'macos');
    expect(isLinux()).toBe(expected === 'linux');
    expect(getShell()).toBe(expected === 'windows' ? 'PowerShell' : 'zsh/bash');
  });
});
