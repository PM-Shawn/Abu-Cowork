import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  getAccountProtocolRegistrationStatus,
  parseAccountAuthCallback,
} from '@/core/account/deepLink';

describe('parseAccountAuthCallback', () => {
  it('accepts one code and one state from the canonical auth host', () => {
    expect(parseAccountAuthCallback('abu://auth?code=code-1&state=state-1')).toEqual({
      code: 'code-1', state: 'state-1',
    });
  });

  // A Windows protocol launch reaches the app as `abu://auth/?…`: ShellExecute
  // adds the slash before argv is handed over, so the same callback arrives in
  // both shapes and both must parse.
  it('accepts the callback shape a Windows protocol launch delivers', () => {
    expect(parseAccountAuthCallback('abu://auth/?code=code-1&state=state-1')).toEqual({
      code: 'code-1', state: 'state-1',
    });
  });

  it.each([
    'abu://auth?code=code-1',
    'abu://auth?state=state-1',
    'abu://auth?code=one&code=two&state=state-1',
    'abu://auth/path?code=code-1&state=state-1',
    'abu://enroll?code=code-1&state=state-1',
    'https://auth?code=code-1&state=state-1',
  ])('rejects a malformed or unrelated callback: %s', (url) => {
    expect(parseAccountAuthCallback(url)).toBeNull();
  });
});

describe('getAccountProtocolRegistrationStatus', () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it.each([
    [true, 'registered'],
    [false, 'not_registered'],
  ] as const)('maps the desktop host result %s', async (hostResult, expected) => {
    vi.mocked(invoke).mockResolvedValue(hostResult);
    await expect(getAccountProtocolRegistrationStatus()).resolves.toBe(expected);
    expect(invoke).toHaveBeenCalledWith('plugin:deep-link|is_registered');
  });

  it('keeps host failures and malformed replies distinct from false', async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValueOnce('false');
    await expect(getAccountProtocolRegistrationStatus()).resolves.toBe('unknown');
    await expect(getAccountProtocolRegistrationStatus()).resolves.toBe('unknown');
  });
});
