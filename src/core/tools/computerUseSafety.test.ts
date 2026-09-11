import { describe, expect, it, vi } from 'vitest';
import { checkSensitiveApp, classifyComputerUseApp } from './computerUseSafety';

vi.mock('../../utils/platform', () => ({
  isMacOS: vi.fn(() => true),
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

describe('Windows executable-path identity', () => {
  it('matches hard-deny policy against the executable basename', async () => {
    const platform = await import('../../utils/platform');
    vi.mocked(platform.isMacOS).mockReturnValue(false);

    expect(checkSensitiveApp(
      'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe',
      'PowerShell',
      { approvalHandledByHost: true },
    )).toContain('不允许操控');
  });

  it('matches hard-deny policy against stable Windows AUMID prefixes', async () => {
    const platform = await import('../../utils/platform');
    vi.mocked(platform.isMacOS).mockReturnValue(false);

    expect(checkSensitiveApp(
      'aumid:windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel',
      'Settings',
      { approvalHandledByHost: true },
    )).toContain('不允许操控');
  });
});

// WeChat for Windows 4.x renamed its main process from WeChat.exe to
// Weixin.exe (mini-program/article host stays WeChatAppEx.exe). Feishu ships
// as Feishu.exe rather than Lark.exe, and the new Outlook is the packaged
// olk.exe. Without these entries the renderer classified them 'ordinary',
// which on the legacy Tauri path means silently drivable with no approval.
describe('Windows approval-required process-name drift', () => {
  const approvalRequiredIdentities: Array<[string, string]> = [
    // Tauri get_active_window reports the bare PowerShell ProcessName (no .exe).
    ['Weixin', 'Weixin'],
    ['C:\\Program Files\\Tencent\\Weixin\\Weixin.exe', 'Weixin'],
    ['C:\\Users\\me\\AppData\\Roaming\\Tencent\\xwechat\\Weixin.exe', 'Weixin'],
    ['C:\\Users\\me\\AppData\\Roaming\\Tencent\\WeChat\\XPlugin\\Plugins\\RadiumWMPF\\14315\\extracted\\runtime\\WeChatAppEx.exe', 'WeChatAppEx'],
    // Legacy 3.x name must keep working.
    ['D:\\Normal Software\\WeChat\\WeChat.exe', 'WeChat'],
    ['D:\\Normal Software\\Feishu\\7.76.7\\Feishu.exe', 'Feishu'],
    ['C:\\Program Files\\WindowsApps\\Microsoft.OutlookForWindows_1.2024.327.300_x64__8wekyb3d8bbwe\\olk.exe', 'Outlook'],
  ];

  it('classifies current WeChat/Feishu/new Outlook binaries as approval-required', async () => {
    const platform = await import('../../utils/platform');
    vi.mocked(platform.isMacOS).mockReturnValue(false);

    for (const [identity] of approvalRequiredIdentities) {
      expect(classifyComputerUseApp(identity), identity).toBe('approval-required');
    }
  });

  it('blocks them on the legacy Tauri path, which has no host approval flow', async () => {
    const platform = await import('../../utils/platform');
    vi.mocked(platform.isMacOS).mockReturnValue(false);

    for (const [identity, appName] of approvalRequiredIdentities) {
      expect(checkSensitiveApp(identity, appName, { approvalHandledByHost: false }), identity)
        .toContain('需要单独的应用授权');
    }
  });

  it('defers them to the Electron host gate instead of denying in the renderer', async () => {
    const platform = await import('../../utils/platform');
    vi.mocked(platform.isMacOS).mockReturnValue(false);

    for (const [identity, appName] of approvalRequiredIdentities) {
      expect(checkSensitiveApp(identity, appName, { approvalHandledByHost: true }), identity)
        .toBeNull();
    }
  });
});
