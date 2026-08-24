import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectSystemLocale,
  getResolvedLocale,
  setLanguage,
  getLanguageSetting,
  initLanguage,
  getI18n,
  getLocale,
  format,
} from './index';

describe('i18n', () => {
  beforeEach(() => {
    // Reset to default
    initLanguage('system');
  });

  // ── detectSystemLocale ──
  describe('detectSystemLocale', () => {
    it('returns a supported locale', () => {
      const locale = detectSystemLocale();
      expect(['zh-CN', 'en-US']).toContain(locale);
    });
  });

  // ── getResolvedLocale ──
  describe('getResolvedLocale', () => {
    it('returns system locale when setting is "system"', () => {
      const locale = getResolvedLocale('system');
      expect(['zh-CN', 'en-US']).toContain(locale);
    });

    it('returns zh-CN when explicitly set', () => {
      expect(getResolvedLocale('zh-CN')).toBe('zh-CN');
    });

    it('returns en-US when explicitly set', () => {
      expect(getResolvedLocale('en-US')).toBe('en-US');
    });
  });

  // ── setLanguage / getLanguageSetting ──
  describe('setLanguage / getLanguageSetting', () => {
    it('defaults to "system"', () => {
      expect(getLanguageSetting()).toBe('system');
    });

    it('sets language to zh-CN', () => {
      setLanguage('zh-CN');
      expect(getLanguageSetting()).toBe('zh-CN');
    });

    it('sets language to en-US', () => {
      setLanguage('en-US');
      expect(getLanguageSetting()).toBe('en-US');
    });

    it('sets language back to system', () => {
      setLanguage('en-US');
      setLanguage('system');
      expect(getLanguageSetting()).toBe('system');
    });
  });

  // ── getI18n ──
  describe('getI18n', () => {
    it('returns a translation dictionary', () => {
      const t = getI18n();
      expect(t).toBeDefined();
      expect(typeof t).toBe('object');
    });

    it('returns Chinese when set to zh-CN', () => {
      setLanguage('zh-CN');
      const t = getI18n();
      // Check a known key exists (sidebar is common)
      expect(t.sidebar).toBeDefined();
    });

    it('returns English when set to en-US', () => {
      setLanguage('en-US');
      const t = getI18n();
      expect(t.sidebar).toBeDefined();
    });

    it('provides the complete context breakdown labels in both locales', () => {
      setLanguage('zh-CN');
      expect(getI18n().chat.contextBreakdown).toEqual({
        title: '上下文构成',
        systemPrompt: '系统提示词',
        tools: '工具',
        mcp: 'MCP',
        skills: '技能',
        conversation: '对话',
        free: '剩余',
      });

      setLanguage('en-US');
      expect(getI18n().chat.contextBreakdown).toEqual({
        title: 'Context breakdown',
        systemPrompt: 'System prompt',
        tools: 'Tools',
        mcp: 'MCP',
        skills: 'Skills',
        conversation: 'Conversation',
        free: 'Free',
      });
    });
  });

  // ── getLocale ──
  describe('getLocale', () => {
    it('returns current resolved locale', () => {
      setLanguage('en-US');
      expect(getLocale()).toBe('en-US');
    });
  });

  // ── format ──
  describe('format', () => {
    it('replaces named placeholders', () => {
      expect(format('{count} files', { count: 5 })).toBe('5 files');
    });

    it('replaces multiple placeholders', () => {
      expect(format('{name} has {count} items', { name: 'Alice', count: 3 })).toBe('Alice has 3 items');
    });

    it('leaves unmatched placeholders unchanged', () => {
      expect(format('{name} has {count}', { name: 'Bob' })).toBe('Bob has {count}');
    });

    it('handles no placeholders', () => {
      expect(format('Hello world', {})).toBe('Hello world');
    });

    it('handles numeric values', () => {
      expect(format('Total: {total}', { total: 42 })).toBe('Total: 42');
    });
  });
});
