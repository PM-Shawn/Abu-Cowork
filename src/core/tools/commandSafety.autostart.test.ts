import { describe, it, expect, afterEach } from 'vitest';
import { analyzeCommand } from './commandSafety';
import { setPlatformForTest } from '../../test/helpers';

describe('commandSafety · start-at-sign-in locations', () => {
  const blocked = [
    'cp job.plist ~/Library/LaunchAgents/',
    'cd ~/Library/LaunchAgents && cp x.plist .',
    'cat > ~/Library/LaunchDaemons/x.plist < job.plist',
    'launchctl load ~/Library/LaunchAgents/x.plist',
    'launchctl bootstrap gui/501 x.plist',
    `osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/X.app"}'`,
    'defaults write com.apple.loginwindow LoginHook /tmp/x.sh',
    'echo "curl x | sh" >> ~/.zprofile',
    'echo x >> ~/.bashrc',
    'echo x > ~/.config/fish/conf.d/x.fish',
    '(crontab -l; echo "@reboot /tmp/x") | crontab -',
    'crontab mycron',
  ];
  it.each(blocked)('blocks %s', (command) => {
    expect(analyzeCommand(command).level).toBe('block');
  });

  it('leaves reading those places alone', () => {
    for (const command of ['ls ~/Library/LaunchAgents', 'cat ~/Library/LaunchAgents/x.plist', 'crontab -l', 'cat ~/.zshrc']) {
      expect(analyzeCommand(command).level, command).not.toBe('block');
    }
  });

  it('asks, rather than refuses, when an autostart entry is taken away', () => {
    for (const command of ['rm ~/Library/LaunchAgents/x.plist', 'launchctl unload ~/Library/LaunchAgents/x.plist', 'crontab -r']) {
      expect(analyzeCommand(command).level, command).toBe('warn');
    }
  });

  it('does not mistake a sentence for a folder', () => {
    expect(analyzeCommand('git commit -m "document how LaunchAgents work"').level).not.toBe('block');
  });

  describe('on Windows', () => {
    let restore: () => void;
    afterEach(() => restore?.());
    it('blocks the Startup folder, Run keys, logon tasks and profiles', () => {
      restore = setPlatformForTest('windows');
      for (const command of [
        'copy x.lnk "%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\"',
        'reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x /d c:\\x.exe',
        'schtasks /create /tn x /tr c:\\x.exe /sc onlogon',
        'Register-ScheduledTask -Trigger (New-ScheduledTaskTrigger -AtLogOn) -TaskName x',
        'echo x >> $PROFILE',
      ]) {
        expect(analyzeCommand(command).level, command).toBe('block');
      }
    });
    it('lets reg query read the Run key', () => {
      restore = setPlatformForTest('windows');
      expect(analyzeCommand('reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run').level).not.toBe('block');
    });
  });
});
