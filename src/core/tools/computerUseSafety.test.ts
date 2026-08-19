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

// Self-protection red line (permission plan §4.6 ②): an agent must never be
// able to operate the UI that grants agents permission — neither Abu's own
// window nor the OS authorization prompt. Both were previously classified
// 'ordinary', i.e. drivable in smart/autonomous mode without any prompt.
describe('self-protection hard deny', () => {
  it('refuses to operate Abu itself in every permission mode', () => {
    const blocked = checkSensitiveApp('com.abu.app', 'Abu', { approvalHandledByHost: true });
    expect(blocked).toContain('不允许操控');
  });

  it('refuses to operate the macOS authorization prompt', () => {
    expect(checkSensitiveApp('com.apple.SecurityAgent', 'SecurityAgent', {
      approvalHandledByHost: true,
    })).toContain('不允许操控');
    expect(checkSensitiveApp('com.apple.authorizationhost', 'authorizationhost', {
      approvalHandledByHost: true,
    })).toContain('不允许操控');
  });

  it('leaves ordinary apps drivable', () => {
    expect(checkSensitiveApp('com.apple.Notes', 'Notes', { approvalHandledByHost: true }))
      .toBeNull();
  });
});
