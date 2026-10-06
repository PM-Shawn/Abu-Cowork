import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { getLanguageSetting, setLanguage } from '../../i18n';
import { useSettingsStore } from '../../stores/settingsStore';
import { useToastStore } from '../../stores/toastStore';
import { extractBlockedPath, showSandboxBlockedToast } from './recovery';

describe('sandbox recovery', () => {
  describe('showSandboxBlockedToast', () => {
    const language = getLanguageSetting();
    const clear = () => {
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().removeToast(toast.id);
    };
    const action = (label: string) => {
      const found = useToastStore.getState().toasts.flatMap((toast) => toast.actions ?? []).find((candidate) => candidate.label === label);
      if (!found) throw new Error(`no action ${label}`);
      return found;
    };

    beforeEach(() => {
      setLanguage('zh-CN');
      clear();
      useSettingsStore.setState({ systemSettingsOpen: false, activeSystemTab: 'general' });
    });

    afterEach(() => {
      clear();
      useSettingsStore.setState({ systemSettingsOpen: false, activeSystemTab: 'general' });
      setLanguage(language);
    });

    it('names the blocked folder and offers 授权此目录 and 前往安全设置', () => {
      showSandboxBlockedToast("echo abu > '/fake/project/output/out.txt'");
      const [toast] = useToastStore.getState().toasts;
      expect(toast.type).toBe('warning');
      expect(toast.title).toBe('沙箱拦截了写入操作');
      expect(toast.message).toBe('被拦截的目录: /fake/project/output');
      expect(toast.actions?.map((candidate) => candidate.label)).toEqual(['授权此目录', '前往安全设置']);
    });

    it('前往安全设置 opens the settings window on the security page', () => {
      showSandboxBlockedToast("echo abu > '/fake/project/output/out.txt'");
      action('前往安全设置').onClick();
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
      expect(useSettingsStore.getState().activeSystemTab).toBe('sandbox');
    });

    it('offers 前往安全设置 alone when the command names no folder, and it opens the same page', () => {
      showSandboxBlockedToast('some-tool --write-somewhere');
      const [toast] = useToastStore.getState().toasts;
      expect(toast.actions?.map((candidate) => candidate.label)).toEqual(['前往安全设置']);
      action('前往安全设置').onClick();
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
      expect(useSettingsStore.getState().activeSystemTab).toBe('sandbox');
    });
  });

  describe('extractBlockedPath', () => {
    it('extracts dest from cp command', () => {
      expect(extractBlockedPath('cp "/tmp/Hello world.docx" "/Users/didi/Desktop/Hello world.docx"'))
        .toBe('/Users/didi/Desktop');
    });

    it('extracts dest from mv command', () => {
      expect(extractBlockedPath('mv /tmp/output.pdf /Users/didi/Documents/output.pdf'))
        .toBe('/Users/didi/Documents');
    });

    it('extracts path from Python save()', () => {
      expect(extractBlockedPath("python3 -c \"doc.save('/Users/didi/Desktop/Hello world.docx')\""))
        .toBe('/Users/didi/Desktop');
    });

    it('extracts path from writeFileSync', () => {
      expect(extractBlockedPath("node -e \"fs.writeFileSync('/Users/didi/Desktop/doc.txt', 'hi')\""))
        .toBe('/Users/didi/Desktop');
    });

    it('extracts path from tee command', () => {
      expect(extractBlockedPath('echo hello | tee /Users/didi/Desktop/out.txt'))
        .toBe('/Users/didi/Desktop');
    });

    it('returns null for unrecognizable command', () => {
      expect(extractBlockedPath('ls -la /tmp')).toBeNull();
    });

    it('handles cp with flags', () => {
      expect(extractBlockedPath('cp -r /tmp/dir /Users/didi/Desktop/dir'))
        .toBe('/Users/didi/Desktop');
    });
  });
});
