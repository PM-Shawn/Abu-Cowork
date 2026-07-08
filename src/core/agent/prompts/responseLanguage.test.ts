import { describe, it, expect } from 'vitest';
import { resolveResponseLanguage } from './responseLanguage';

/**
 * Output-language control (P0 of the prompt English-ization work).
 *
 * The agent system prompt is (historically) Chinese, which implicitly made the
 * model reply in Chinese. Once prompts move to English that implicit anchor is
 * gone, so we inject an explicit "respond in {locale}" instruction driven by the
 * resolved UI locale. Pattern mirrors WorkBuddy's `<response_language>` block.
 */
describe('resolveResponseLanguage', () => {
  it('instructs Simplified Chinese output for the zh-CN locale', () => {
    expect(resolveResponseLanguage('zh-CN')).toContain('简体中文');
  });

  it('instructs English output by default for the en-US locale', () => {
    expect(resolveResponseLanguage('en-US')).toContain('English');
  });

  it('lets the user message language override the locale default (both locales)', () => {
    // The instruction must reference the user's *message* as the override signal.
    expect(resolveResponseLanguage('zh-CN')).toMatch(/消息|message/i);
    expect(resolveResponseLanguage('en-US')).toMatch(/message|消息/i);
  });

  it('warns against basing the language decision on code / paths / logs', () => {
    // WorkBuddy-proven caveat: technical content must not flip the output language.
    for (const locale of ['zh-CN', 'en-US'] as const) {
      expect(resolveResponseLanguage(locale)).toMatch(/code|paths?|logs?|代码|路径|日志/i);
    }
  });

  it('produces distinct instructions per locale', () => {
    expect(resolveResponseLanguage('zh-CN')).not.toBe(resolveResponseLanguage('en-US'));
  });
});
