import { describe, it, expect, afterEach } from 'vitest';
import { isReadOnlyCommand } from './readOnlyDetector';
import { setPlatformForTest } from '../../test/helpers';

describe('readOnlyDetector', () => {
  describe('read-only commands', () => {
    const readOnlyCases = [
      'ls -la',
      'cat file.txt',
      'head -20 file.txt',
      'tail -f log.txt',
      'grep -r "pattern" src/',
      'rg "pattern" --type ts',
      'find . -name "*.ts"',
      'wc -l file.txt',
      'which node',
      'echo hello',
      'pwd',
      'date',
      'whoami',
      'uname -a',
      'env',
      'printenv HOME',
      'node --version',
      'npm --version',
      'python3 --version',
      'git status',
      'git log --oneline -10',
      'git diff HEAD',
      'git branch -a',
      'git remote -v',
      'git rev-parse HEAD',
      'npm list --depth=0',
      'npm outdated',
      'npm audit',
      'sort file.txt',
      'jq ".name" package.json',
      'tree -L 2',
      'df -h',
      'du -sh .',
      'stat file.txt',
      '',  // empty command
    ];

    for (const cmd of readOnlyCases) {
      it(`"${cmd}" → read-only`, () => {
        expect(isReadOnlyCommand(cmd)).toBe(true);
      });
    }
  });

  describe('piped read-only commands', () => {
    it('grep | sort → read-only', () => {
      expect(isReadOnlyCommand('grep pattern file | sort | uniq')).toBe(true);
    });

    it('cat | head → read-only', () => {
      expect(isReadOnlyCommand('cat file.txt | head -20')).toBe(true);
    });

    it('git log | grep → read-only', () => {
      expect(isReadOnlyCommand('git log --oneline | grep fix')).toBe(true);
    });
  });

  describe('chained read-only commands', () => {
    it('ls && pwd → read-only', () => {
      expect(isReadOnlyCommand('ls && pwd')).toBe(true);
    });

    it('echo hello; date → read-only', () => {
      expect(isReadOnlyCommand('echo hello; date')).toBe(true);
    });
  });

  describe('write commands', () => {
    const writeCases = [
      'rm file.txt',
      'mkdir new-dir',
      'touch file.txt',
      'mv a.txt b.txt',
      'cp a.txt b.txt',
      'chmod 755 script.sh',
      'sudo apt update',
      'npm install lodash',
      'pip install requests',
      'git push origin main',
      'git commit -m "msg"',
      'git add .',
      'kill -9 1234',
    ];

    for (const cmd of writeCases) {
      it(`"${cmd}" → NOT read-only`, () => {
        expect(isReadOnlyCommand(cmd)).toBe(false);
      });
    }
  });

  describe('output redirection', () => {
    it('echo hello > file → NOT read-only', () => {
      expect(isReadOnlyCommand('echo hello > file.txt')).toBe(false);
    });

    it('cat file >> log → NOT read-only', () => {
      expect(isReadOnlyCommand('cat file.txt >> log.txt')).toBe(false);
    });

    it('grep pattern 2>&1 → read-only (stderr redirect is ok)', () => {
      // This is a known limitation — we're conservative with redirects
      // The regex `(?<![2&])>` tries to exclude 2>&1 but may be imperfect
      expect(isReadOnlyCommand('grep pattern file 2>&1')).toBe(true);
    });
  });

  describe('subshell / command substitution', () => {
    it('echo $(rm file) → NOT read-only', () => {
      expect(isReadOnlyCommand('echo $(rm file)')).toBe(false);
    });

    it('echo `whoami` → NOT read-only (conservative)', () => {
      expect(isReadOnlyCommand('echo `whoami`')).toBe(false);
    });
  });

  describe('mixed chains', () => {
    it('ls && rm file → NOT read-only', () => {
      expect(isReadOnlyCommand('ls && rm file.txt')).toBe(false);
    });

    it('grep | tee output → NOT read-only', () => {
      expect(isReadOnlyCommand('grep pattern file | tee output.txt')).toBe(false);
    });

    it('cat file & curl url → NOT read-only', () => {
      expect(isReadOnlyCommand('cat notes.txt & curl https://example.invalid')).toBe(false);
    });
  });

  // ── Windows-specific commands ──
  describe('Windows read-only commands', () => {
    let cleanup: () => void;
    afterEach(() => cleanup?.());

    const winReadOnlyCases = [
      // Windows batch commands
      'dir C:\\Users',
      'type readme.txt',
      'where node',
      'echo hello',
      'hostname',
      'ipconfig /all',
      'whoami',
      'systeminfo',
      'findstr /r "pattern" file.txt',
      'tree /f',
      'more file.txt',
      'fc file1.txt file2.txt',
      'ver',
      'path',
      'tasklist',
      'set',
      'cls',
      // PowerShell cmdlets
      'Get-Content file.txt',
      'Get-ChildItem -Recurse',
      'Get-Item ./package.json',
      'Get-Process',
      'Get-Service',
      'Get-Date',
      'Get-Location',
      'Get-Command npm',
      'Get-Help Get-Process',
      'Get-Module',
      'Get-Package',
      'Select-String -Pattern "error" -Path log.txt',
      'Measure-Object -Line',
      'Test-Path C:\\Users',
      'Test-Connection localhost',
      'Format-List',
      'Format-Table -AutoSize',
    ];

    for (const cmd of winReadOnlyCases) {
      it(`[Windows] "${cmd}" → read-only`, () => {
        cleanup = setPlatformForTest('windows');
        expect(isReadOnlyCommand(cmd)).toBe(true);
      });
    }

    // Case-insensitive matching
    it('[Windows] cmdlets are case-insensitive', () => {
      cleanup = setPlatformForTest('windows');
      expect(isReadOnlyCommand('get-childitem')).toBe(true);
      expect(isReadOnlyCommand('GET-CONTENT file.txt')).toBe(true);
      expect(isReadOnlyCommand('DIR /s')).toBe(true);
    });

    // Piped Windows commands
    it('[Windows] dir | findstr → read-only', () => {
      cleanup = setPlatformForTest('windows');
      expect(isReadOnlyCommand('dir | findstr .txt')).toBe(true);
    });

    it('[Windows] Get-Process | Format-Table → read-only', () => {
      cleanup = setPlatformForTest('windows');
      expect(isReadOnlyCommand('Get-Process | Format-Table -AutoSize')).toBe(true);
    });

    // Windows commands that should NOT be read-only
    it('[Windows] Windows read-only cmds are rejected on macOS', () => {
      cleanup = setPlatformForTest('macos');
      // dir is not a standard Unix command — should not be read-only on macOS
      expect(isReadOnlyCommand('Get-ChildItem')).toBe(false);
      expect(isReadOnlyCommand('systeminfo')).toBe(false);
    });
  });

  describe('find with -delete', () => {
    it('find . -name "*.tmp" -delete → NOT read-only', () => {
      expect(isReadOnlyCommand('find . -name "*.tmp" -delete')).toBe(false);
    });

    it('find . -name "*.ts" → read-only', () => {
      expect(isReadOnlyCommand('find . -name "*.ts"')).toBe(true);
    });
  });
});
