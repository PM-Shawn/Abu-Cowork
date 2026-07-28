import { describe, expect, it, vi } from 'vitest';
import { checkSensitiveApp } from './computerUseSafety';

vi.mock('../../utils/platform', () => ({
  isMacOS: () => true,
}));

describe('Computer Use identity compatibility', () => {
  it('preserves the legacy Tauri fallback when app identity is unavailable', () => {
    expect(checkSensitiveApp(null, '', { approvalHandledByHost: false })).toBeNull();
  });

  it('fails closed when the Electron main-process gate owns app approval', () => {
    expect(checkSensitiveApp(null, '', { approvalHandledByHost: true }))
      .toContain('无法确认');
  });
});
