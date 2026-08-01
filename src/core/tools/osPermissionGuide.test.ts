import { describe, it, expect } from 'vitest';
import { applyOSPermissionGuideIfNeeded, isOSPermissionError } from './osPermissionGuide';

// The shared SSOT helper both executeAnyTool (registry.ts, reverse path) and the
// sidecar's executeLocalTool (local-execution path) call, so a file-tool
// OS-permission error emits the identical guided message regardless of which
// path ran it.
describe('applyOSPermissionGuideIfNeeded', () => {
  // Stable across both the macOS and Windows branches of formatOSPermissionGuide.
  const GUIDE_MARKER = '系统未授权阿布访问此位置';

  it('appends the grant guide when a file tool hits an OS-permission error', () => {
    const raw = "EACCES: permission denied, open '/protected/x.txt'";
    const out = applyOSPermissionGuideIfNeeded('write_file', raw);
    expect(out).not.toBe(raw);
    expect(out.startsWith(raw)).toBe(true); // guide is appended, not a replacement
    expect(out).toContain(GUIDE_MARKER);
  });

  it('leaves a non-permission result untouched', () => {
    const ok = 'wrote 3 bytes to /tmp/x.txt';
    expect(applyOSPermissionGuideIfNeeded('write_file', ok)).toBe(ok);
  });

  it('does not guide a non-file tool even on an EACCES-shaped string', () => {
    const raw = 'EACCES: permission denied';
    expect(applyOSPermissionGuideIfNeeded('show_widget', raw)).toBe(raw);
  });
});

describe('isOSPermissionError', () => {
  it('matches the OS-permission error shapes across platforms', () => {
    expect(isOSPermissionError('EACCES: permission denied')).toBe(true);
    expect(isOSPermissionError('EPERM: operation not permitted')).toBe(true);
    expect(isOSPermissionError('Access is denied.')).toBe(true); // Windows
    expect(isOSPermissionError('ENOENT: no such file')).toBe(false);
    expect(isOSPermissionError('wrote 3 bytes')).toBe(false);
  });
});
